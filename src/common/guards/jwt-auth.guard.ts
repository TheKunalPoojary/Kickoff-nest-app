import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AuthUser } from '../decorators/current-user.decorator.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import type { Env } from '../../infra/config/env.schema.js';

export interface AccessTokenPayload {
  sub: string;
  role: AuthUser['role'];
}

/**
 * Registered globally, so every route is private unless explicitly marked
 * @Public(). Uses @nestjs/jwt directly rather than Passport — one less
 * dependency and one less layer of indirection for a single strategy.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = this.extractBearer(req);

    if (!token) {
      throw new UnauthorizedException({
        code: 'MISSING_TOKEN',
        message: 'Authentication required.',
      });
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
      req.user = { id: payload.sub, role: payload.role };
      return true;
    } catch {
      // Expired and malformed are deliberately indistinguishable to the
      // client; the app just refreshes on any 401 with this code.
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Your session has expired. Please sign in again.',
      });
    }
  }

  private extractBearer(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
