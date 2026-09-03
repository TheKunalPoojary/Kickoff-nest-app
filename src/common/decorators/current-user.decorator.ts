import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { UserRole } from '../../generated/prisma/enums.js';

export interface AuthUser {
  id: string;
  role: UserRole;
}

/** Populated by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (!req.user) {
      // Only reachable if a route is @Public() but still asks for the user.
      throw new Error('CurrentUser used on a route without JwtAuthGuard');
    }
    return req.user;
  },
);
