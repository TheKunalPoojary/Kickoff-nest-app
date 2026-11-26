import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/decorators/current-user.decorator.js';
import {
  AudienceOutOfScopeException,
  PushRateLimitedException,
  VenueNotFoundException,
} from '../../common/errors/domain.errors.js';
import type { Env } from '../../infra/config/env.schema.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type {
  Audience,
  CustomersQueryDto,
  HistoryQueryDto,
  RegisterDeviceDto,
  SendDto,
} from './notifications.schemas.js';
import { PushProvider, type PushPayload } from './push.provider.js';

/** Bookings that make someone a "customer": anything past checkout, incl. cancelled and no-show. */
const NOT_A_CUSTOMER_STATUSES = ['PENDING_PAYMENT', 'EXPIRED'] as const;

interface Resolved {
  users: number;
  devices: { id: string; token: string }[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PushProvider,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ---------------------------------------------------------------- devices

  /**
   * Upsert by token. A token belongs to a physical install, so when a second
   * user signs in on the same phone the row MOVES to them — otherwise the
   * previous user's notifications would keep arriving on that phone.
   */
  async registerDevice(userId: string, dto: RegisterDeviceDto) {
    await this.prisma.device.upsert({
      where: { expoPushToken: dto.expoPushToken },
      create: { userId, expoPushToken: dto.expoPushToken, platform: dto.platform },
      update: { userId, platform: dto.platform },
    });
    return { registered: true };
  }

  async unregisterDevice(userId: string, expoPushToken: string) {
    // Scoped to the caller: nobody can unregister someone else's device.
    await this.prisma.device.deleteMany({ where: { expoPushToken, userId } });
    return { unregistered: true };
  }

  // ---------------------------------------------------------------- audience

  /** Users who completed a booking at the venue through the app (walk-ins have no player account). */
  private customersOf(venueId: string): Prisma.UserWhereInput {
    return {
      deletedAt: null,
      bookings: {
        some: {
          source: 'APP',
          status: { notIn: [...NOT_A_CUSTOMER_STATUSES] },
          resource: { venueId },
        },
      },
    };
  }

  /**
   * Turns an audience into concrete users + device tokens.
   *
   * `venueScope` is set for owner sends: the audience is then restricted to that
   * venue's customers no matter what was asked for.
   */
  private async resolve(audience: Audience, venueScope?: string): Promise<Resolved & { venueId: string | null }> {
    const reachable: Prisma.UserWhereInput = { deletedAt: null, isBlocked: false };
    let scope: Prisma.UserWhereInput;
    let venueId: string | null = venueScope ?? null;

    switch (audience.type) {
      case 'USERS': {
        const ids = [...new Set(audience.userIds)];
        const base: Prisma.UserWhereInput = venueScope ? this.customersOf(venueScope) : { deletedAt: null };
        // Count BEFORE the blocked filter: a blocked customer is still in scope,
        // just not reachable. An out-of-scope or unknown id fails identically.
        const inScope = await this.prisma.user.count({ where: { AND: [base, { id: { in: ids } }] } });
        if (inScope !== ids.length) throw new AudienceOutOfScopeException();
        scope = { id: { in: ids } };
        break;
      }
      case 'ALL_CUSTOMERS':
        if (!venueScope) throw new AudienceOutOfScopeException();
        scope = this.customersOf(venueScope);
        break;
      case 'VENUE_CUSTOMERS': {
        const venue = await this.prisma.venue.findFirst({
          where: { id: audience.venueId, deletedAt: null },
          select: { id: true },
        });
        if (!venue) throw new VenueNotFoundException();
        venueId = venue.id;
        scope = this.customersOf(venue.id);
        break;
      }
      case 'ALL':
        scope = { role: 'USER' };
        break;
      case 'SEGMENT':
        scope = {
          role: 'USER',
          ...(audience.city ? { city: { equals: audience.city, mode: 'insensitive' } } : {}),
          ...(audience.sports ? { preferredSports: { hasSome: audience.sports } } : {}),
        };
        break;
    }

    const users = await this.prisma.user.findMany({
      where: { AND: [reachable, scope] },
      select: { id: true, devices: { select: { id: true, expoPushToken: true } } },
    });

    return {
      venueId,
      users: users.length,
      devices: users.flatMap((u) => u.devices.map((d) => ({ id: d.id, token: d.expoPushToken }))),
    };
  }

  /** Dry run for the "this will reach N people" confirmation — sends nothing. */
  async preview(audience: Audience, venueScope?: string) {
    const r = await this.resolve(audience, venueScope);
    return { recipients: r.users, devices: r.devices.length };
  }

  // ---------------------------------------------------------------- send

  async send(actor: AuthUser, dto: SendDto, venueScope?: string) {
    // Owners are rate limited per venue; admins are not.
    if (actor.role !== 'ADMIN' && venueScope) {
      const limit = this.config.get('PUSH_OWNER_MAX_PER_DAY', { infer: true });
      const sent = await this.prisma.pushMessage.count({
        where: {
          venueId: venueScope,
          senderRole: { not: 'ADMIN' },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
      if (sent >= limit) throw new PushRateLimitedException(limit);
    }

    const resolved = await this.resolve(dto.audience, venueScope);
    const nothingToSend = resolved.devices.length === 0;

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.pushMessage.create({
        data: {
          senderId: actor.id,
          senderRole: actor.role,
          venueId: resolved.venueId,
          title: dto.title,
          body: dto.body,
          audience: dto.audience as unknown as Prisma.InputJsonValue,
          recipientCount: resolved.users,
          deviceCount: resolved.devices.length,
          status: nothingToSend ? 'SENT' : 'QUEUED',
          completedAt: nothingToSend ? new Date() : null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'notification.send',
          entityType: 'PushMessage',
          entityId: created.id,
          after: {
            audience: dto.audience,
            recipientCount: created.recipientCount,
            deviceCount: created.deviceCount,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return created;
    });

    // Delivery runs after the response: a broadcast is many Expo round trips and
    // must not hold the HTTP request open. A crash mid-delivery leaves the row in
    // QUEUED/SENDING, which is visible in the history rather than silently lost.
    if (!nothingToSend) {
      void this.deliver(message.id, dto, resolved.devices).catch((err) =>
        this.logger.error(`Push delivery ${message.id} crashed: ${String(err)}`),
      );
    }

    return message;
  }

  private async deliver(messageId: string, dto: SendDto, devices: Resolved['devices']) {
    await this.prisma.pushMessage.update({ where: { id: messageId }, data: { status: 'SENDING' } });

    let sent = 0;
    let failed = 0;
    const dead: string[] = [];
    const size = this.provider.batchSize;

    for (let i = 0; i < devices.length; i += size) {
      const batch = devices.slice(i, i + size);
      const payloads: PushPayload[] = batch.map((d) => ({
        to: d.token,
        title: dto.title,
        body: dto.body,
        data: { messageId },
      }));

      try {
        const tickets = await this.provider.send(payloads);
        tickets.forEach((t, idx) => {
          if (t.ok) sent++;
          else {
            failed++;
            if (t.error === 'DeviceNotRegistered') dead.push(batch[idx]!.id);
          }
        });
      } catch (err) {
        // Transport failure: count the whole batch failed and keep going — the
        // other batches are independent.
        failed += batch.length;
        this.logger.warn(`Push batch for ${messageId} failed: ${String(err)}`);
      }
    }

    // Expo says the app was uninstalled / token revoked; keeping it would just
    // waste a slot in every future broadcast.
    if (dead.length) await this.prisma.device.deleteMany({ where: { id: { in: dead } } });

    await this.prisma.pushMessage.update({
      where: { id: messageId },
      data: {
        sentCount: sent,
        failedCount: failed,
        status: sent === 0 && failed > 0 ? 'FAILED' : 'SENT',
        completedAt: new Date(),
      },
    });
  }

  // ---------------------------------------------------------------- reads

  listForVenue(venueId: string, query: HistoryQueryDto) {
    return this.prisma.pushMessage.findMany({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
  }

  listAll(query: HistoryQueryDto) {
    return this.prisma.pushMessage.findMany({ orderBy: { createdAt: 'desc' }, take: query.limit });
  }

  /** Picker data for the owner's "selected customers" audience. */
  async customers(venueId: string, query: CustomersQueryDto) {
    const venueBookings: Prisma.BookingWhereInput = {
      source: 'APP',
      status: { notIn: [...NOT_A_CUSTOMER_STATUSES] },
      resource: { venueId },
    };
    const q = query.q;
    const users = await this.prisma.user.findMany({
      where: {
        AND: [
          this.customersOf(venueId),
          q
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { phone: { contains: q } },
                  { email: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      orderBy: { name: 'asc' },
      take: query.limit,
      select: {
        id: true,
        name: true,
        phone: true,
        isBlocked: true,
        _count: { select: { devices: true } },
        bookings: {
          where: venueBookings,
          orderBy: { startsAt: 'desc' },
          select: { startsAt: true },
        },
      },
    });

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      bookingCount: u.bookings.length,
      lastBookingAt: u.bookings[0]?.startsAt ?? null,
      // Blocked users and users without a registered device cannot be reached.
      reachable: !u.isBlocked && u._count.devices > 0,
    }));
  }
}
