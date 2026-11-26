import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { MaintenanceModeException } from '../../common/errors/domain.errors.js';
import { AppConfigService } from './app-config.service.js';

/**
 * Paths that must keep working while the app is in maintenance:
 *  - config/app so the mobile app can learn it is in maintenance at all
 *  - auth so an admin can sign in to switch maintenance back off
 *  - admin/* (also covered by the role bypass, but harmless to list)
 *  - payments/webhook: Razorpay retries until it gets a 2xx, and a payment
 *    captured during maintenance must still confirm its booking
 */
const ALLOWED_PREFIXES = [
  '/health',
  '/api/v1/config/app',
  '/api/v1/auth/',
  '/api/v1/admin/',
  '/api/v1/payments/webhook',
];

/** Registered globally after JwtAuthGuard, so `req.user` is already set. */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    if (req.user?.role === 'ADMIN') return true;
    if (ALLOWED_PREFIXES.some((p) => req.path.startsWith(p))) return true;

    const { maintenance } = await this.config.get();
    if (maintenance.enabled) throw new MaintenanceModeException(maintenance.message);

    return true;
  }
}
