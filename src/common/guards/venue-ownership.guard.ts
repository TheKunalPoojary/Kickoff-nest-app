import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../decorators/current-user.decorator.js';
import { NotVenueOwnerException } from '../errors/domain.errors.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/**
 * Role and ownership are two different questions.
 *
 * `@Roles('VENUE_OWNER')` only says "this user is an owner" — it does NOT say
 * they own THIS venue. Without this guard, any owner could edit any other
 * owner's pricing and read their bookings. That is the classic marketplace
 * data leak, and it is why every owner-scoped route needs both.
 *
 * Resolves `:venueId` / `:id` directly, or `:resourceId` via its venue.
 */
@Injectable()
export class VenueOwnershipGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<
      Request & { user?: AuthUser; params: Record<string, string> }
    >();
    const user = req.user;
    if (!user) return false;

    // Admins and support staff act across all venues by design.
    if (user.role === 'ADMIN' || user.role === 'SUPPORT') return true;

    const ownerId = await this.resolveOwner(req.params);

    if (ownerId === null) {
      throw new NotFoundException({
        code: 'VENUE_NOT_FOUND',
        message: 'Venue not found.',
      });
    }

    if (ownerId !== user.id) {
      // 403 rather than 404: the caller is a legitimate owner, just not of
      // this venue. Hiding existence buys nothing here — venues are public.
      throw new NotVenueOwnerException();
    }

    return true;
  }

  private async resolveOwner(params: Record<string, string>): Promise<string | null> {
    const resourceId = params.resourceId;
    if (resourceId) {
      const resource = await this.prisma.resource.findFirst({
        where: { id: resourceId, deletedAt: null },
        select: { venue: { select: { ownerId: true } } },
      });
      return resource?.venue.ownerId ?? null;
    }

    const venueId = params.venueId ?? params.id;
    if (!venueId) return null;

    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { ownerId: true },
    });
    return venue?.ownerId ?? null;
  }
}
