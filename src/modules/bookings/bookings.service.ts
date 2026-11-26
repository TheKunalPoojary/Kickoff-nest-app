import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { AvailabilityService, type Slot } from '../availability/availability.service.js';
import {
  BookingNotCancellableException,
  BookingNotFoundException,
  SlotUnavailableException,
  isExclusionViolation,
} from '../../common/errors/domain.errors.js';
import { computeRefund } from './refund-policy.js';
import { PaymentsService } from '../payments/payments.service.js';
import { generateBookingCode } from './booking-code.js';
import { computeAdvance } from './advance.js';
import type { Env } from '../../infra/config/env.schema.js';
import type {
  CancelBookingDto,
  CollectBalanceDto,
  CreateBookingDto,
  CreateManualBookingDto,
  ListBookingsDto,
  OwnerBookingsQueryDto,
  OwnerSummaryQueryDto,
} from './booking.schemas.js';

const BOOKING_SELECT = {
  id: true,
  bookingCode: true,
  status: true,
  source: true,
  startsAt: true,
  endsAt: true,
  amountPaise: true,
  advancePaise: true,
  balanceCollectedPaise: true,
  balanceCollectedAt: true,
  customerName: true,
  customerPhone: true,
  holdsUntil: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  resource: {
    select: {
      id: true,
      name: true,
      kind: true,
      bufferMins: true,
      venue: { select: { id: true, name: true, city: true, timezone: true, addressLine: true } },
    },
  },
} as const;

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Creates a PENDING_PAYMENT booking. That row IS the slot lock — it takes
   * part in the `booking_no_overlap` exclusion constraint, so the hold is
   * durable across restarts and enforced by the database rather than by
   * cooperating application code.
   */
  async create(userId: string, dto: CreateBookingDto, idempotencyKey?: string) {
    // Retries — a double-tap, a crash-and-reopen, a flaky network — must
    // collapse into one booking rather than several.
    if (idempotencyKey) {
      const existing = await this.prisma.booking.findUnique({
        where: { idempotencyKey },
        select: BOOKING_SELECT,
      });
      if (existing) return this.present(existing);
    }

    const plan = await this.planBooking(dto);

    return this.withStaleHoldRetry(dto.resourceId, plan, () =>
      this.insert(userId, dto, plan, idempotencyKey),
    );
  }

  /**
   * A booking entered by the owner from the portal — walk-in or phone. Paid at
   * the venue, so it is CONFIRMED immediately with no hold and no payment row.
   *
   * It goes through exactly the same validation and the same exclusion
   * constraint as an app booking: a walk-in racing an app checkout for one slot
   * must still produce exactly one winner.
   */
  async createManual(ownerId: string, resourceId: string, dto: CreateManualBookingDto) {
    const slotDto: CreateBookingDto = { resourceId, startsAt: dto.startsAt, slots: dto.slots };
    const plan = await this.planBooking(slotDto);

    if (dto.collectedPaise > plan.amountPaise) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Collected amount cannot exceed the booking price.',
      });
    }

    return this.withStaleHoldRetry(resourceId, plan, async () => {
      const booking = await this.prisma.booking.create({
        data: {
          bookingCode: generateBookingCode(),
          userId: ownerId,
          resourceId,
          startsAt: plan.startsAt,
          endsAt: plan.endsAt,
          status: 'CONFIRMED',
          source: 'WALK_IN',
          amountPaise: plan.amountPaise,
          advancePaise: 0,
          balanceCollectedPaise: dto.collectedPaise,
          balanceCollectedAt: dto.collectedPaise > 0 ? new Date() : null,
          customerName: dto.customerName,
          customerPhone: dto.customerPhone,
        },
        select: BOOKING_SELECT,
      });
      return this.present(booking);
    });
  }

  /**
   * The constraint's WHERE clause cannot reference now(), so an expired but
   * unswept hold still blocks the slot. On a conflict, clear those and retry
   * EXACTLY once — a retry loop under contention turns a single lost race into
   * a thundering herd against the same slot.
   */
  private async withStaleHoldRetry<T>(
    resourceId: string,
    plan: BookingPlan,
    insert: () => Promise<T>,
  ): Promise<T> {
    try {
      return await insert();
    } catch (err) {
      if (!isExclusionViolation(err)) throw err;

      const cleared = await this.expireStaleOverlapping(resourceId, plan.startsAt, plan.endsAt);
      if (cleared === 0) throw new SlotUnavailableException({ resourceId });

      this.logger.debug(`Cleared ${cleared} stale hold(s); retrying booking once`);

      try {
        return await insert();
      } catch (retryErr) {
        if (isExclusionViolation(retryErr)) throw new SlotUnavailableException({ resourceId });
        throw retryErr;
      }
    }
  }

  private async insert(
    userId: string,
    dto: CreateBookingDto,
    plan: BookingPlan,
    idempotencyKey?: string,
  ) {
    const holdMinutes = this.config.get('BOOKING_HOLD_MINUTES', { infer: true });

    const booking = await this.prisma.booking.create({
      data: {
        bookingCode: generateBookingCode(),
        userId,
        resourceId: dto.resourceId,
        startsAt: plan.startsAt,
        // Widened by bufferMins so the cleanup gap is enforced by the same
        // exclusion constraint. See the note on Booking in schema.prisma.
        endsAt: plan.endsAt,
        status: 'PENDING_PAYMENT',
        amountPaise: plan.amountPaise,
        advancePaise: plan.advancePaise,
        holdsUntil: new Date(Date.now() + holdMinutes * 60_000),
        idempotencyKey,
      },
      select: BOOKING_SELECT,
    });

    return this.present(booking);
  }

  /**
   * Validates the request against computed availability and prices it
   * server-side. The client never supplies an amount — that would let anyone
   * book a ₹1500 pitch for ₹1.
   */
  private async planBooking(dto: CreateBookingDto): Promise<BookingPlan> {
    const resource = await this.prisma.resource.findFirst({
      where: { id: dto.resourceId, isActive: true, deletedAt: null },
      select: {
        id: true,
        bufferMins: true,
        venue: { select: { timezone: true, advancePct: true } },
      },
    });

    if (!resource) {
      throw new NotFoundException({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Resource not found.',
      });
    }

    const tz = resource.venue.timezone;
    const localDate = formatInTimeZone(dto.startsAt, tz, 'yyyy-MM-dd');

    // A slot that runs past midnight belongs to the PREVIOUS local day's
    // schedule (a venue open 06:00-01:00 sells its 00:00 slot as part of the
    // night before), so both days are consulted.
    const previousDate = formatInTimeZone(
      new Date(dto.startsAt.getTime() - 24 * 60 * 60 * 1000),
      tz,
      'yyyy-MM-dd',
    );

    const [prev, curr] = await Promise.all([
      this.availability.getAvailability(dto.resourceId, previousDate),
      this.availability.getAvailability(dto.resourceId, localDate),
    ]);

    const bySlotStart = new Map<string, Slot>();
    for (const slot of [...prev.slots, ...curr.slots]) {
      bySlotStart.set(slot.startsAt, slot);
    }

    const ordered = [...bySlotStart.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const startIso = dto.startsAt.toISOString();
    const startIndex = ordered.findIndex((s) => s.startsAt === startIso);

    if (startIndex === -1) {
      throw new ConflictException({
        code: 'INVALID_SLOT',
        message: 'That start time is not a bookable slot for this resource.',
      });
    }

    const chosen = ordered.slice(startIndex, startIndex + dto.slots);

    if (chosen.length < dto.slots) {
      throw new ConflictException({
        code: 'INVALID_SLOT',
        message: 'The venue closes before that booking would end.',
      });
    }

    for (const [i, slot] of chosen.entries()) {
      if (slot.state !== 'AVAILABLE') {
        throw new SlotUnavailableException({ startsAt: slot.startsAt, state: slot.state });
      }
      // Consecutive slots must actually abut; a gap would mean booking across
      // a closed period.
      if (i > 0 && chosen[i - 1].endsAt !== slot.startsAt) {
        throw new ConflictException({
          code: 'INVALID_SLOT',
          message: 'Those slots are not consecutive.',
        });
      }
    }

    const playEnd = new Date(chosen.at(-1)!.endsAt);
    const amountPaise = chosen.reduce((sum, s) => sum + s.pricePaise, 0);

    return {
      startsAt: dto.startsAt,
      endsAt: new Date(playEnd.getTime() + resource.bufferMins * 60_000),
      playEndsAt: playEnd,
      amountPaise,
      advancePaise: computeAdvance(amountPaise, resource.venue.advancePct),
      bufferMins: resource.bufferMins,
    };
  }

  /** Returns how many stale holds were cleared, so the caller knows whether a retry is worthwhile. */
  private async expireStaleOverlapping(
    resourceId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<number> {
    const result = await this.prisma.booking.updateMany({
      where: {
        resourceId,
        status: 'PENDING_PAYMENT',
        holdsUntil: { lt: new Date() },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }

  async listMine(userId: string, query: ListBookingsDto) {
    const now = new Date();

    return this.prisma.booking
      .findMany({
        where: {
          userId,
          // Walk-ins are stored against the owner who entered them; they are
          // not the owner's own bookings.
          source: 'APP',
          ...(query.status ? { status: query.status } : {}),
          ...(query.scope === 'upcoming'
            ? { startsAt: { gte: now }, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } }
            : {}),
          ...(query.scope === 'past' ? { startsAt: { lt: now } } : {}),
        },
        select: BOOKING_SELECT,
        orderBy: { startsAt: query.scope === 'past' ? 'desc' : 'asc' },
        take: query.limit,
      })
      .then((rows) => rows.map((r) => this.present(r)));
  }

  async findOne(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId },
      select: BOOKING_SELECT,
    });

    if (!booking) {
      // Scoped to the caller, so another user's booking id is a 404 rather
      // than a 403 that confirms it exists.
      throw new NotFoundException({
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found.',
      });
    }

    return this.present(booking);
  }

  /** Shows what a cancellation would be worth, without performing it. */
  async previewCancellation(userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId },
      select: { status: true, advancePaise: true, startsAt: true },
    });

    if (!booking) {
      throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' });
    }

    // Only the advance was paid online, so only the advance can come back.
    const decision = computeRefund({
      amountPaise: booking.advancePaise,
      startsAt: booking.startsAt,
      now: new Date(),
    });

    return { ...decision, cancellable: this.isCancellable(booking.status) };
  }

  async cancel(userId: string, bookingId: string, dto: CancelBookingDto) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, userId },
      select: { id: true, status: true, advancePaise: true, startsAt: true },
    });

    if (!booking) {
      throw new NotFoundException({ code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' });
    }

    if (!this.isCancellable(booking.status)) {
      throw new BookingNotCancellableException({ status: booking.status });
    }

    const decision = computeRefund({
      amountPaise: booking.advancePaise,
      startsAt: booking.startsAt,
      now: new Date(),
    });

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancelReason: dto.reason,
      },
      select: BOOKING_SELECT,
    });

    // Issue the refund, but never let a gateway failure undo the cancellation:
    // the user has been told their booking is cancelled, and the slot is
    // already released. A stuck refund is recoverable; a cancellation that
    // silently rolled back is not.
    let refundIssued = false;
    try {
      const result = await this.payments.refundForCancellation(bookingId);
      refundIssued = result.refunded;
    } catch (err) {
      this.logger.error(
        `Booking ${bookingId} cancelled but refund failed — needs manual retry: ${String(err)}`,
      );
    }

    return { booking: this.present(updated), refund: decision, refundIssued };
  }

  // ------------------------------------------------------------ owner portal

  /** Bookings at one venue in a time window, for the portal's day grid and list. */
  async listForVenue(venueId: string, query: OwnerBookingsQueryDto) {
    const rows = await this.prisma.booking.findMany({
      where: {
        resource: { venueId },
        startsAt: { gte: query.from, lt: query.to },
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.source ? { source: query.source } : {}),
      },
      select: {
        ...BOOKING_SELECT,
        user: { select: { id: true, name: true, phone: true, email: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: query.limit,
    });
    return rows.map((r) => this.present(r));
  }

  /** Headline numbers for the owner dashboard over a time window. */
  async summaryForVenue(venueId: string, query: OwnerSummaryQueryDto) {
    const groups = await this.prisma.booking.groupBy({
      by: ['status', 'source'],
      where: { resource: { venueId }, startsAt: { gte: query.from, lt: query.to } },
      _count: { _all: true },
      _sum: { amountPaise: true, advancePaise: true, balanceCollectedPaise: true },
    });

    const live = groups.filter((g) => g.status === 'CONFIRMED' || g.status === 'COMPLETED');
    const sum = (rows: typeof groups, field: 'amountPaise' | 'advancePaise' | 'balanceCollectedPaise') =>
      rows.reduce((s, g) => s + (g._sum[field] ?? 0), 0);

    const bookedValuePaise = sum(live, 'amountPaise');
    const advanceCollectedPaise = sum(live, 'advancePaise');
    const balanceCollectedPaise = sum(live, 'balanceCollectedPaise');

    return {
      from: query.from,
      to: query.to,
      counts: {
        confirmed: live.reduce((s, g) => s + g._count._all, 0),
        walkIn: live.filter((g) => g.source === 'WALK_IN').reduce((s, g) => s + g._count._all, 0),
        pendingPayment: groups
          .filter((g) => g.status === 'PENDING_PAYMENT')
          .reduce((s, g) => s + g._count._all, 0),
        cancelled: groups
          .filter((g) => g.status === 'CANCELLED')
          .reduce((s, g) => s + g._count._all, 0),
      },
      bookedValuePaise,
      advanceCollectedPaise,
      balanceCollectedPaise,
      balanceDuePaise: Math.max(0, bookedValuePaise - advanceCollectedPaise - balanceCollectedPaise),
    };
  }

  /**
   * Owner/admin cancellation. Business rule: the online advance is
   * non-refundable when the venue cancels (see refund-policy.ts), so this
   * never calls the gateway — but it still goes through
   * refundForCancellation so the policy lives in one place.
   */
  async cancelByVenue(actorId: string, bookingId: string, dto: CancelBookingDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, advancePaise: true, startsAt: true },
    });
    if (!booking) throw new BookingNotFoundException();
    if (!this.isCancellable(booking.status)) {
      throw new BookingNotCancellableException({ status: booking.status });
    }

    const decision = computeRefund({
      amountPaise: booking.advancePaise,
      startsAt: booking.startsAt,
      now: new Date(),
      cancelledByVenue: true,
    });

    const updated = await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: actorId,
        cancelReason: dto.reason,
      },
      select: BOOKING_SELECT,
    });

    let refundIssued = false;
    try {
      refundIssued = (await this.payments.refundForCancellation(bookingId, true)).refunded;
    } catch (err) {
      this.logger.error(`Venue-cancelled booking ${bookingId} refund step failed: ${String(err)}`);
    }

    return { booking: this.present(updated), refund: decision, refundIssued };
  }

  /** Records money the owner took at the venue (cash/UPI) against the balance. */
  async collectBalance(bookingId: string, dto: CollectBalanceDto) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        status: true,
        amountPaise: true,
        advancePaise: true,
        balanceCollectedPaise: true,
      },
    });
    if (!booking) throw new BookingNotFoundException();

    if (booking.status !== 'CONFIRMED' && booking.status !== 'COMPLETED') {
      throw new ConflictException({
        code: 'BOOKING_NOT_COLLECTABLE',
        message: `A ${booking.status.toLowerCase()} booking has no balance to collect.`,
      });
    }

    const due = booking.amountPaise - booking.advancePaise - booking.balanceCollectedPaise;
    if (dto.amountPaise > due) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `Only ₹${(due / 100).toFixed(2)} is still due on this booking.`,
        details: { balanceDuePaise: due },
      });
    }

    // Optimistic: only applies if nobody else recorded a payment in between,
    // so two staff tapping "collected" at once cannot double-count.
    const result = await this.prisma.booking.updateMany({
      where: { id: bookingId, balanceCollectedPaise: booking.balanceCollectedPaise },
      data: {
        balanceCollectedPaise: booking.balanceCollectedPaise + dto.amountPaise,
        balanceCollectedAt: new Date(),
      },
    });
    if (result.count === 0) {
      throw new ConflictException({
        code: 'CONCURRENT_UPDATE',
        message: 'This booking was just updated. Refresh and try again.',
      });
    }

    const updated = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: BOOKING_SELECT,
    });
    return this.present(updated);
  }

  private isCancellable(status: string): boolean {
    return status === 'PENDING_PAYMENT' || status === 'CONFIRMED';
  }

  /**
   * `endsAt` includes the cleanup buffer, which is an implementation detail of
   * the exclusion constraint. Clients must see the play window.
   */
  private present<
    T extends {
      endsAt: Date;
      amountPaise: number;
      advancePaise: number;
      balanceCollectedPaise: number;
      resource: { bufferMins: number };
    },
  >(booking: T) {
    return {
      ...booking,
      // What the customer still owes at the venue.
      balanceDuePaise: Math.max(
        0,
        booking.amountPaise - booking.advancePaise - booking.balanceCollectedPaise,
      ),
      endsAt: new Date(booking.endsAt.getTime() - booking.resource.bufferMins * 60_000),
      occupiedUntil: booking.endsAt,
    };
  }
}

interface BookingPlan {
  startsAt: Date;
  /** Includes bufferMins — this is what gets stored. */
  endsAt: Date;
  playEndsAt: Date;
  amountPaise: number;
  /** Paid online to hold the slot; computed from Venue.advancePct. */
  advancePaise: number;
  bufferMins: number;
}
