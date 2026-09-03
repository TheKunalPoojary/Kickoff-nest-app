import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { HoldSweeperService } from '../bookings/hold-sweeper.service.js';

/** Sweeper runs every minute; three missed runs means something is wrong. */
const SWEEPER_STALE_AFTER_MS = 3 * 60_000;

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sweeper: HoldSweeperService,
  ) {}

  /**
   * Liveness + dependency check. The load balancer and uptime monitor both hit
   * this, so it must actually touch the database — a process that is up but
   * cannot reach Postgres is not healthy.
   *
   * The hold sweeper is reported too. If it stops, nothing errors: expired
   * holds simply keep blocking their slots and inventory quietly freezes. That
   * failure is invisible unless it is checked for explicitly.
   */
  @Get()
  async check() {
    const startedAt = Date.now();
    let database = 'up';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }

    const lastSweep = this.sweeper.getLastRunAt();
    const sweeperStale =
      lastSweep !== null && Date.now() - lastSweep.getTime() > SWEEPER_STALE_AFTER_MS;

    return {
      status: database === 'up' && !sweeperStale ? 'ok' : 'degraded',
      database,
      holdSweeper: {
        // null simply means the process started less than a minute ago.
        lastRunAt: lastSweep?.toISOString() ?? null,
        stale: sweeperStale,
      },
      latencyMs: Date.now() - startedAt,
      uptimeSec: Math.round(process.uptime()),
    };
  }
}
