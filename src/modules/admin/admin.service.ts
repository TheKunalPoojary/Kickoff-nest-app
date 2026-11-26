import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import { EmailAlreadyRegisteredException } from '../../common/errors/domain.errors.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { hashPassword } from '../auth/password.util.js';
import { OwnerVenuesService } from '../venues/owner-venues.service.js';
import type {
  AdminBookingsDto,
  AdminCreateVenueDto,
  AdminUpdateVenueDto,
  CreateOwnerDto,
  ListUsersDto,
  ListVenuesDto,
  UpdateUserDto,
} from './admin.schemas.js';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isBlocked: true,
  createdAt: true,
} as const;

/**
 * Platform-level administration. Every mutation writes an AuditLog row in the
 * same transaction — disputes ("who suspended my venue?") are unresolvable
 * without it.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly venues: OwnerVenuesService,
  ) {}

  // ---------------------------------------------------------------- owners

  async createOwner(actor: AuthUser, dto: CreateOwnerDto) {
    const clash = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, ...(dto.phone ? [{ phone: dto.phone }] : [])] },
      select: { email: true },
    });
    if (clash) {
      if (clash.email === dto.email) throw new EmailAlreadyRegisteredException();
      throw new BadRequestException({
        code: 'PHONE_ALREADY_REGISTERED',
        message: 'An account with this phone number already exists.',
      });
    }

    const passwordHash = await hashPassword(dto.tempPassword);

    return this.prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          role: 'VENUE_OWNER',
          preferredSports: [],
        },
        select: USER_SELECT,
      });
      await this.audit(tx, actor, 'owner.create', 'User', owner.id, null, owner);
      return owner;
    });
  }

  listOwners() {
    return this.prisma.user.findMany({
      where: { role: 'VENUE_OWNER', deletedAt: null },
      select: {
        ...USER_SELECT,
        venues: { where: { deletedAt: null }, select: { id: true, name: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---------------------------------------------------------------- users

  listUsers(query: ListUsersDto) {
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(query.role ? { role: query.role } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { email: { contains: query.q, mode: 'insensitive' } },
                { phone: { contains: query.q } },
              ],
            }
          : {}),
      },
      select: USER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
  }

  async updateUser(actor: AuthUser, userId: string, dto: UpdateUserDto) {
    if (userId === actor.id) {
      // An admin blocking or demoting themselves can lock everyone out.
      throw new BadRequestException({
        code: 'CANNOT_MODIFY_SELF',
        message: 'You cannot change your own account here.',
      });
    }

    const before = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_SELECT,
    });
    if (!before) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    if (before.role === 'ADMIN') {
      throw new BadRequestException({
        code: 'CANNOT_MODIFY_ADMIN',
        message: 'Admin accounts can only be changed directly in the database.',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const after = await tx.user.update({ where: { id: userId }, data: dto, select: USER_SELECT });

      // Blocking or changing role ends every refresh session, so the user
      // cannot mint a fresh access token carrying the old role. An access
      // token already issued lives out its short TTL (JWT_ACCESS_TTL).
      await tx.refreshSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await this.audit(tx, actor, 'user.update', 'User', userId, before, after);
      return after;
    });
  }

  // ---------------------------------------------------------------- venues

  listVenues(query: ListVenuesDto) {
    return this.prisma.venue
      .findMany({
        where: {
          deletedAt: null,
          ...(query.status ? { status: query.status } : {}),
          ...(query.ownerId ? { ownerId: query.ownerId } : {}),
          ...(query.q
            ? {
                OR: [
                  { name: { contains: query.q, mode: 'insensitive' } },
                  { city: { contains: query.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
          city: true,
          status: true,
          commissionPct: true,
          advancePct: true,
          createdAt: true,
          owner: { select: { id: true, name: true, email: true, phone: true } },
          _count: { select: { resources: { where: { deletedAt: null } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
      })
      .then((rows) => rows.map((v) => ({ ...v, commissionPct: Number(v.commissionPct) })));
  }

  async createVenue(actor: AuthUser, dto: AdminCreateVenueDto) {
    const { ownerId, ...venue } = dto;
    const owner = await this.prisma.user.findFirst({
      where: { id: ownerId, role: 'VENUE_OWNER', deletedAt: null },
      select: { id: true },
    });
    if (!owner) {
      throw new BadRequestException({
        code: 'OWNER_NOT_FOUND',
        message: 'ownerId must be an existing venue owner.',
      });
    }

    const created = await this.venues.createVenue(ownerId, venue);
    await this.audit(this.prisma, actor, 'venue.create', 'Venue', created.id, null, created);
    return created;
  }

  async updateVenue(actor: AuthUser, venueId: string, dto: AdminUpdateVenueDto) {
    const before = await this.prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true, status: true, commissionPct: true, advancePct: true },
    });
    if (!before) throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found.' });

    return this.prisma.$transaction(async (tx) => {
      const after = await tx.venue.update({
        where: { id: venueId },
        data: dto,
        select: { id: true, name: true, status: true, commissionPct: true, advancePct: true },
      });
      await this.audit(tx, actor, 'venue.update', 'Venue', venueId, before, after);
      return { ...after, commissionPct: Number(after.commissionPct) };
    });
  }

  // ---------------------------------------------------------------- bookings

  async listBookings(query: AdminBookingsDto) {
    const rows = await this.prisma.booking.findMany({
      where: {
        ...(query.venueId ? { resource: { venueId: query.venueId } } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to
          ? { startsAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } }
          : {}),
      },
      select: {
        id: true,
        bookingCode: true,
        status: true,
        source: true,
        startsAt: true,
        endsAt: true,
        amountPaise: true,
        advancePaise: true,
        balanceCollectedPaise: true,
        customerName: true,
        createdAt: true,
        user: { select: { id: true, name: true, phone: true, email: true } },
        resource: {
          select: {
            id: true,
            name: true,
            bufferMins: true,
            venue: { select: { id: true, name: true, timezone: true } },
          },
        },
      },
      orderBy: { startsAt: 'desc' },
      take: query.limit,
    });

    // Same presentation rule as the player API: show the play window, not
    // the buffer-widened range the exclusion constraint stores.
    return rows.map((b) => ({
      ...b,
      endsAt: new Date(b.endsAt.getTime() - b.resource.bufferMins * 60_000),
      occupiedUntil: b.endsAt,
    }));
  }

  /** Recent admin actions, newest first. */
  auditLog(limit = 100) {
    return this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  }

  private audit(
    db: Pick<Prisma.TransactionClient, 'auditLog'>,
    actor: AuthUser,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ) {
    // Round-trip through JSON so Dates and Decimals land as plain JSON values.
    const json = (v: unknown) =>
      v === null ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);
    return db.auditLog.create({
      data: {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        entityType,
        entityId,
        before: json(before),
        after: json(after),
      },
    });
  }
}
