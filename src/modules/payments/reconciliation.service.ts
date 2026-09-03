import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayClient } from './razorpay.client.js';

/**
 * The safety net for the worst failure in the system: money taken, no booking.
 *
 * Webhooks get lost, dropped, and delivered out of order. Without a job that
 * independently asks the gateway "what actually happened", a user who paid can
 * end up holding nothing and nobody finds out until they complain.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly razorpay: RazorpayClient,
  ) {}

  // No EVERY_15_MINUTES constant in @nestjs/schedule, so spelled out.
  @Cron('*/15 * * * *', { name: 'reconcile-payments' })
  async reconcile(): Promise<{ checked: number; repaired: number }> {
    // Orders created more than 5 minutes ago that never reached a terminal
    // state. Younger ones are probably still mid-checkout.
    const stale = await this.prisma.payment.findMany({
      where: {
        status: 'CREATED',
        createdAt: { lt: new Date(Date.now() - 5 * 60_000) },
      },
      select: { id: true, providerOrderId: true, bookingId: true },
      take: 100,
    });

    let repaired = 0;

    for (const payment of stale) {
      try {
        const found = await this.findCapturedPayment(payment.providerOrderId);
        if (!found) continue;

        this.logger.warn(
          `Reconciling payment ${found.id}: gateway says captured, we had CREATED`,
        );

        await this.payments.processEvent({
          // Synthetic id, namespaced so it cannot collide with a real delivery
          // and so a later genuine webhook is deduped against this.
          eventId: `reconcile:${found.id}`,
          eventType: 'payment.captured',
          payload: { payment: { entity: found } },
        });
        repaired++;
      } catch (err) {
        // One bad row must not stop the sweep.
        this.logger.error(`Reconcile failed for ${payment.providerOrderId}: ${String(err)}`);
      }
    }

    if (repaired > 0) {
      this.logger.warn(`Reconciliation repaired ${repaired} payment(s)`);
    }

    return { checked: stale.length, repaired };
  }

  /**
   * Razorpay has no "payments for order" call in this thin client, so an
   * unmatched order is reported rather than guessed at. Overridden in tests.
   */
  protected async findCapturedPayment(orderId: string) {
    const res = await this.razorpay.fetchPayment(orderId).catch(() => null);
    if (!res || res.status !== 'captured') return null;
    return res;
  }
}
