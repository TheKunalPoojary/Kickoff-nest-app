import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { RazorpayClient } from './razorpay.client.js';
import { captureLines, isBalanced, refundLines, type LedgerLine } from './ledger.entries.js';
import { computeRefund } from '../bookings/refund-policy.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayClient,
  ) {}

  /**
   * Creates (or returns) the Razorpay order for a held booking. Called after
   * the hold exists, never before — an order without a held slot is money
   * collected for something that may already be gone.
   */
  async createOrder(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId },
      select: {
        id: true,
        bookingCode: true,
        status: true,
        amountPaise: true,
        holdsUntil: true,
        payment: true,
      },
    });

    if (!booking) {
      throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' });
    }

    if (booking.status !== 'PENDING_PAYMENT') {
      throw new ConflictException({
        code: 'BOOKING_NOT_PAYABLE',
        message: `This booking is ${booking.status.toLowerCase()} and cannot be paid for.`,
      });
    }

    if (booking.holdsUntil && booking.holdsUntil < new Date()) {
      throw new ConflictException({
        code: 'HOLD_EXPIRED',
        message: 'Your slot hold expired. Please pick the slot again.',
      });
    }

    // Reuse the existing order rather than creating a second one for the same
    // booking — two live orders means two ways to pay for one slot.
    if (booking.payment && booking.payment.status === 'CREATED') {
      return {
        orderId: booking.payment.providerOrderId,
        amountPaise: booking.payment.amountPaise,
        bookingId: booking.id,
      };
    }

    const order = await this.razorpay.createOrder({
      amountPaise: booking.amountPaise,
      receipt: booking.bookingCode,
      notes: { bookingId: booking.id },
    });

    await this.prisma.payment.create({
      data: {
        bookingId: booking.id,
        providerOrderId: order.id,
        amountPaise: booking.amountPaise,
        status: 'CREATED',
      },
    });

    return { orderId: order.id, amountPaise: booking.amountPaise, bookingId: booking.id };
  }

  /**
   * What the app polls after checkout. The client's own success callback is
   * never trusted — it drops, it lies, and it can be replayed.
   */
  async getStatus(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId },
      select: { id: true, status: true, payment: { select: { status: true, method: true } } },
    });

    if (!booking) {
      throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' });
    }

    return {
      bookingId: booking.id,
      bookingStatus: booking.status,
      paymentStatus: booking.payment?.status ?? null,
      method: booking.payment?.method ?? null,
      /** The client stops polling on this. */
      settled: booking.status === 'CONFIRMED' || booking.payment?.status === 'FAILED',
    };
  }

  /**
   * Processes a verified webhook event exactly once.
   *
   * Razorpay retries until it gets a 2xx, so this must be safe to run
   * repeatedly. The WebhookEvent unique constraint is what makes that true:
   * a duplicate delivery loses the insert race and returns early.
   */
  async processEvent(params: {
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<{ handled: boolean; reason?: string }> {
    const { eventId, eventType, payload } = params;

    try {
      await this.prisma.webhookEvent.create({
        data: { provider: 'razorpay', eventId, eventType, payload: payload as never },
      });
    } catch {
      // Unique violation: already seen. Ack so Razorpay stops retrying.
      this.logger.debug(`Duplicate webhook ${eventId} ignored`);
      return { handled: false, reason: 'duplicate' };
    }

    try {
      const result = await this.dispatch(eventType, payload);
      await this.prisma.webhookEvent.update({
        where: { provider_eventId: { provider: 'razorpay', eventId } },
        data: { processedAt: new Date() },
      });
      return result;
    } catch (err) {
      // Leave processedAt null so reconciliation and replay can pick it up.
      await this.prisma.webhookEvent.update({
        where: { provider_eventId: { provider: 'razorpay', eventId } },
        data: { error: String(err).slice(0, 500) },
      });
      throw err;
    }
  }

  private async dispatch(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<{ handled: boolean; reason?: string }> {
    const entity = this.extractPayment(payload);

    switch (eventType) {
      case 'payment.captured':
        if (!entity) return { handled: false, reason: 'no payment entity' };
        await this.confirmPayment(entity);
        return { handled: true };

      case 'payment.failed':
        if (!entity) return { handled: false, reason: 'no payment entity' };
        await this.markFailed(entity);
        return { handled: true };

      case 'refund.processed':
        await this.markRefunded(payload);
        return { handled: true };

      default:
        // Razorpay sends many event types; acking the ones we don't act on
        // keeps them from retrying forever.
        return { handled: false, reason: `unhandled ${eventType}` };
    }
  }

  /** Booking confirmation and the ledger write are one transaction, or neither happens. */
  private async confirmPayment(entity: {
    id: string;
    order_id: string;
    amount: number;
    method?: string;
  }) {
    const payment = await this.prisma.payment.findUnique({
      where: { providerOrderId: entity.order_id },
      select: {
        id: true,
        status: true,
        bookingId: true,
        amountPaise: true,
        booking: {
          select: {
            id: true,
            status: true,
            resource: { select: { venue: { select: { id: true, commissionPct: true } } } },
          },
        },
      },
    });

    if (!payment) {
      // Money captured against an order we have no record of. Loud, because it
      // means a user has paid and holds nothing.
      this.logger.error(`Captured payment ${entity.id} for unknown order ${entity.order_id}`);
      return;
    }

    if (payment.status === 'PAID') return;

    const venue = payment.booking.resource.venue;
    const lines = captureLines({
      venueId: venue.id,
      amountPaise: payment.amountPaise,
      commissionPct: Number(venue.commissionPct),
    });

    if (!isBalanced(lines)) {
      // Refuse to write an unbalanced ledger rather than silently corrupting it.
      throw new Error(`Unbalanced ledger for payment ${payment.id}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'PAID',
          providerPaymentId: entity.id,
          method: entity.method,
          rawPayload: entity as never,
        },
      });

      await tx.booking.update({
        where: { id: payment.bookingId },
        data: { status: 'CONFIRMED', holdsUntil: null },
      });

      await tx.ledgerEntry.createMany({
        data: this.toLedgerRows(lines, payment.bookingId, 'BOOKING', payment.bookingId),
      });
    });

    this.logger.log(`Booking ${payment.bookingId} confirmed by payment ${entity.id}`);
  }

  private async markFailed(entity: { id: string; order_id: string; error_description?: string }) {
    const payment = await this.prisma.payment.findUnique({
      where: { providerOrderId: entity.order_id },
      select: { id: true, status: true },
    });
    if (!payment || payment.status === 'PAID') return;

    // The booking is deliberately left PENDING_PAYMENT: the user may retry
    // within the hold window, and the sweeper releases it if they don't.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'FAILED',
        providerPaymentId: entity.id,
        failureReason: entity.error_description?.slice(0, 300),
      },
    });
  }

  private async markRefunded(payload: Record<string, unknown>) {
    const refund = (payload as { refund?: { entity?: Record<string, unknown> } }).refund?.entity;
    const paymentId = refund?.payment_id as string | undefined;
    const amount = Number(refund?.amount ?? 0);
    if (!paymentId) return;

    const payment = await this.prisma.payment.findUnique({
      where: { providerPaymentId: paymentId },
      select: { id: true, amountPaise: true, refundedPaise: true },
    });
    if (!payment) return;

    const refundedTotal = Math.min(payment.refundedPaise + amount, payment.amountPaise);

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundedPaise: refundedTotal,
        status: refundedTotal >= payment.amountPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      },
    });
  }

  /**
   * Issues a refund for a cancelled booking, using the same policy function the
   * user was shown before they confirmed.
   */
  async refundForCancellation(bookingId: string, cancelledByVenue = false) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        amountPaise: true,
        startsAt: true,
        cancelledAt: true,
        resource: { select: { venue: { select: { id: true, commissionPct: true } } } },
        payment: {
          select: { id: true, providerPaymentId: true, status: true, amountPaise: true },
        },
      },
    });

    if (!booking?.payment || booking.payment.status !== 'PAID') {
      // Nothing was captured — an unpaid hold simply expires, no refund needed.
      return { refunded: false, reason: 'no captured payment' };
    }

    const decision = computeRefund({
      amountPaise: booking.amountPaise,
      startsAt: booking.startsAt,
      now: booking.cancelledAt ?? new Date(),
      cancelledByVenue,
    });

    if (decision.refundPaise <= 0) {
      return { refunded: false, reason: decision.tier, decision };
    }

    const venue = booking.resource.venue;
    const commissionTaken = Math.floor(
      (booking.payment.amountPaise * Number(venue.commissionPct)) / 100,
    );

    const lines = refundLines({
      venueId: venue.id,
      refundPaise: decision.refundPaise,
      originalAmountPaise: booking.payment.amountPaise,
      originalCommissionPaise: commissionTaken,
    });

    if (!isBalanced(lines)) {
      throw new Error(`Unbalanced refund ledger for booking ${bookingId}`);
    }

    await this.razorpay.refund(booking.payment.providerPaymentId!, decision.refundPaise);

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: booking.payment!.id },
        // REFUND_PENDING, not REFUNDED: refunds are asynchronous and take days
        // to land. The refund.processed webhook closes it out.
        data: { status: 'REFUND_PENDING' },
      });

      await tx.ledgerEntry.createMany({
        data: this.toLedgerRows(lines, bookingId, 'REFUND', bookingId),
      });
    });

    return { refunded: true, decision };
  }

  private toLedgerRows(
    lines: LedgerLine[],
    bookingId: string,
    refType: string,
    refId: string,
  ) {
    return lines.map((l) => ({
      bookingId,
      account: l.account,
      direction: l.direction,
      amountPaise: l.amountPaise,
      refType,
      refId,
    }));
  }

  private extractPayment(
    payload: Record<string, unknown>,
  ): { id: string; order_id: string; amount: number; method?: string } | null {
    const entity = (payload as { payment?: { entity?: Record<string, unknown> } }).payment?.entity;
    if (!entity || typeof entity.id !== 'string' || typeof entity.order_id !== 'string') {
      return null;
    }
    return entity as never;
  }
}
