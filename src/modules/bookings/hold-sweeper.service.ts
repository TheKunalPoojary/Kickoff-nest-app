import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/**
 * Correctness-critical, not housekeeping.
 *
 * The exclusion constraint's WHERE clause cannot reference now() (it must be
 * immutable), so a PENDING_PAYMENT row keeps blocking its slot until something
 * changes its status. If this stops running, inventory silently freezes:
 * abandoned checkouts hold slots forever and nothing errors. It needs an
 * alert on "has not completed recently", not just a log line.
 */
@Injectable()
export class HoldSweeperService {
  private readonly logger = new Logger(HoldSweeperService.name);
  private lastRunAt: Date | null = null;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'expire-holds' })
  async expireHolds(): Promise<number> {
    const { count } = await this.prisma.booking.updateMany({
      where: { status: 'PENDING_PAYMENT', holdsUntil: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });

    this.lastRunAt = new Date();

    if (count > 0) {
      this.logger.log(`Expired ${count} unpaid hold(s)`);
    }

    return count;
  }

  /**
   * Marks finished bookings COMPLETED so they leave "upcoming" and become
   * reviewable. Cheap, and it keeps the hot upcoming query small.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'complete-bookings' })
  async completeFinished(): Promise<number> {
    const { count } = await this.prisma.booking.updateMany({
      where: { status: 'CONFIRMED', endsAt: { lt: new Date() } },
      data: { status: 'COMPLETED' },
    });

    if (count > 0) {
      this.logger.log(`Completed ${count} finished booking(s)`);
    }

    return count;
  }

  /** Surfaced on /health so a stalled sweeper is visible rather than silent. */
  getLastRunAt(): Date | null {
    return this.lastRunAt;
  }
}
