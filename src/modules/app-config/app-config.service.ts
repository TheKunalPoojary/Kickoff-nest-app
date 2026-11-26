import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import {
  APP_SETTING_SCHEMAS,
  type AppConfig,
  type AppSettingKey,
  DEFAULT_APP_SETTINGS,
  type UpdateAppConfigDto,
} from './app-config.schemas.js';

const CACHE_TTL_MS = 15_000;

const KEY_FOR: Record<keyof AppConfig, AppSettingKey> = {
  versions: 'app.versions',
  maintenance: 'app.maintenance',
  features: 'app.features',
};

@Injectable()
export class AppConfigService {
  private cache: { value: AppConfig; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read on every request by MaintenanceGuard, so it is cached in memory.
   * A 15s TTL means an admin toggle takes effect within 15s on every instance
   * without a shared cache or pub/sub.
   */
  async get(): Promise<AppConfig> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;

    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: Object.values(KEY_FOR) } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    // A missing or malformed row falls back to the default rather than
    // failing the request — a bad setting must never take the API down.
    const read = <K extends keyof AppConfig>(field: K): AppConfig[K] => {
      const key = KEY_FOR[field];
      const parsed = APP_SETTING_SCHEMAS[key].safeParse(byKey.get(key));
      return (
        parsed.success ? parsed.data : APP_SETTING_SCHEMAS[key].parse(DEFAULT_APP_SETTINGS[key])
      ) as AppConfig[K];
    };

    const value: AppConfig = {
      versions: read('versions'),
      maintenance: read('maintenance'),
      features: read('features'),
    };
    this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  async update(dto: UpdateAppConfigDto, actor: { id: string; role: string }): Promise<AppConfig> {
    const before = await this.get();

    await this.prisma.$transaction(async (tx) => {
      for (const field of Object.keys(dto) as (keyof AppConfig)[]) {
        const value = dto[field];
        if (value === undefined) continue;
        const key = KEY_FOR[field];
        await tx.appSetting.upsert({
          where: { key },
          create: { key, value, updatedBy: actor.id },
          update: { value, updatedBy: actor.id },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'app_config.update',
          entityType: 'AppSetting',
          entityId: Object.keys(dto).join(','),
          before,
          after: dto,
        },
      });
    });

    this.cache = null;
    return this.get();
  }
}
