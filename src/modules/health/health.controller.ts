import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness + dependency check. The load balancer and uptime monitor both hit
   * this, so it must actually touch the database — a process that is up but
   * cannot reach Postgres is not healthy.
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

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      latencyMs: Date.now() - startedAt,
      uptimeSec: Math.round(process.uptime()),
    };
  }
}
