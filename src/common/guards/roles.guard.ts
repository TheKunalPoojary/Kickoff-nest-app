import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthUser } from '../decorators/current-user.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { UserRole } from '../../generated/prisma/enums.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const role = req.user?.role;

    // ADMIN is a superset of every role, so admin tooling does not need a
    // second annotation on every owner route.
    if (role && (required.includes(role) || role === 'ADMIN')) return true;

    throw new ForbiddenException({
      code: 'INSUFFICIENT_ROLE',
      message: 'You do not have access to this resource.',
    });
  }
}
