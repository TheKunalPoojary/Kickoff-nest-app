import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { UpgradeRequiredException } from '../../common/errors/domain.errors.js';
import { compareVersions } from './app-config.schemas.js';
import { AppConfigService } from './app-config.service.js';

/**
 * Paths that stay open to an outdated app: it must still be able to read the
 * config that tells it to update, and to sign in/refresh without being kicked
 * out. Payments keep confirming (Razorpay webhook, no app headers anyway).
 */
const ALLOWED_PREFIXES = [
  '/health',
  '/api/v1/config/app',
  '/api/v1/auth/',
  '/api/v1/admin/',
  '/api/v1/payments/webhook',
];

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * Server-side half of the forced-update switch. The mobile app sends
 * `X-App-Platform: ios|android` and `X-App-Version: 1.2.3`; if the admin has
 * turned `forceUpdate` on and the version is below `min`, the request is
 * refused with 426 UPGRADE_REQUIRED.
 *
 * Requests WITHOUT the headers (the owner portal, MCP, curl, webhooks) and
 * malformed values are allowed — this guard targets known app builds and must
 * never lock out other clients. The headers are self-reported, so this stops
 * stale builds, not a determined attacker.
 */
@Injectable()
export class AppVersionGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    const platform = req.header('x-app-platform')?.toLowerCase();
    const version = req.header('x-app-version')?.trim();
    if ((platform !== 'ios' && platform !== 'android') || !version || !VERSION_RE.test(version)) {
      return true;
    }
    if (req.user?.role === 'ADMIN') return true;
    if (ALLOWED_PREFIXES.some((p) => req.path.startsWith(p))) return true;

    const { versions } = await this.config.get();
    const rule = versions[platform];
    if (rule.forceUpdate && compareVersions(version, rule.min) < 0) {
      throw new UpgradeRequiredException(rule.message, { min: rule.min, storeUrl: rule.storeUrl });
    }
    return true;
  }
}
