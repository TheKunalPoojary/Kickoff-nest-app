import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { CreateBlackoutDto } from './availability.schemas.js';

@Injectable()
export class BlackoutsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(resourceId: string, from?: Date) {
    await this.assertResourceExists(resourceId);

    return this.prisma.blackout.findMany({
      where: { resourceId, endsAt: { gte: from ?? new Date() } },
      select: { id: true, startsAt: true, endsAt: true, reason: true, createdAt: true },
      orderBy: { startsAt: 'asc' },
    });
  }

  async create(resourceId: string, createdBy: string, dto: CreateBlackoutDto) {
    await this.assertResourceExists(resourceId);

    // Deliberately allowed to overlap existing CONFIRMED bookings: a venue
    // closing for a burst pipe must be able to say so. Those bookings still
    // need cancelling and refunding — that is phase 5's override flow, not a
    // reason to block the blackout here.
    const conflicting = await this.prisma.booking.count({
      where: {
        resourceId,
        status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] },
        startsAt: { lt: dto.endsAt },
        endsAt: { gt: dto.startsAt },
      },
    });

    const blackout = await this.prisma.blackout.create({
      data: { resourceId, createdBy, ...dto },
      select: { id: true, startsAt: true, endsAt: true, reason: true },
    });

    return { ...blackout, conflictingBookings: conflicting };
  }

  /** Blackouts across every resource of a venue — the portal's closures calendar. */
  listForVenue(venueId: string, from?: Date) {
    return this.prisma.blackout.findMany({
      where: { resource: { venueId, deletedAt: null }, endsAt: { gte: from ?? new Date() } },
      select: {
        id: true,
        resourceId: true,
        startsAt: true,
        endsAt: true,
        reason: true,
        createdAt: true,
        resource: { select: { name: true } },
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  /**
   * Closes the whole venue for a range — one blackout per active resource, in
   * one transaction so a failure never leaves the venue half-closed.
   */
  async closeVenue(venueId: string, createdBy: string, dto: CreateBlackoutDto) {
    const resources = await this.prisma.resource.findMany({
      where: { venueId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    const resourceIds = resources.map((r) => r.id);

    const [conflicting, created] = await this.prisma.$transaction([
      this.prisma.booking.count({
        where: {
          resourceId: { in: resourceIds },
          status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] },
          startsAt: { lt: dto.endsAt },
          endsAt: { gt: dto.startsAt },
        },
      }),
      this.prisma.blackout.createMany({
        data: resourceIds.map((resourceId) => ({ resourceId, createdBy, ...dto })),
      }),
    ]);

    return { resourcesClosed: created.count, conflictingBookings: conflicting };
  }

  /**
   * Scoped to the resource the ownership guard checked. Looking the blackout up
   * by id alone would let an owner delete another venue's blackout by pairing
   * their own resource id with someone else's blackout id.
   */
  async remove(resourceId: string, blackoutId: string) {
    const existing = await this.prisma.blackout.findFirst({
      where: { id: blackoutId, resourceId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'BLACKOUT_NOT_FOUND',
        message: 'Blackout not found.',
      });
    }

    await this.prisma.blackout.delete({ where: { id: blackoutId } });
    return { id: blackoutId, deleted: true };
  }

  private async assertResourceExists(resourceId: string): Promise<void> {
    const resource = await this.prisma.resource.findFirst({
      where: { id: resourceId, deletedAt: null },
      select: { id: true },
    });
    if (!resource) {
      throw new NotFoundException({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Resource not found.',
      });
    }
  }
}
