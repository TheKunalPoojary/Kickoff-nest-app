import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PG_UNIQUE_VIOLATION, hasPgCode } from '../../common/errors/domain.errors.js';
import type {
  CreateResourceDto,
  CreateVenueDto,
  OperatingHoursDto,
  UpdateResourceDto,
  UpdateVenueDto,
} from './owner.schemas.js';

@Injectable()
export class OwnerVenuesService {
  constructor(private readonly prisma: PrismaService) {}

  listMine(ownerId: string) {
    return this.prisma.venue.findMany({
      where: { ownerId, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        city: true,
        status: true,
        ratingAvg: true,
        ratingCount: true,
        _count: { select: { resources: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createVenue(ownerId: string, dto: CreateVenueDto) {
    // New venues are not publicly visible until reviewed. Letting anyone list
    // instantly is how a marketplace fills with junk and fake listings.
    const slug = await this.uniqueSlug(dto.name);

    return this.prisma.venue.create({
      data: { ...dto, slug, ownerId, status: 'PENDING_APPROVAL' },
      select: { id: true, name: true, slug: true, status: true },
    });
  }

  async updateVenue(venueId: string, dto: UpdateVenueDto) {
    await this.assertVenueExists(venueId);

    return this.prisma.venue.update({
      where: { id: venueId },
      data: dto,
      select: { id: true, name: true, slug: true, status: true, updatedAt: true },
    });
  }

  async replaceHours(venueId: string, dto: OperatingHoursDto) {
    await this.assertVenueExists(venueId);

    // Replace rather than merge: a partial update would silently leave a stale
    // weekday behind, and the venue would keep taking bookings on a day it
    // meant to close.
    return this.prisma.$transaction(async (tx) => {
      await tx.operatingHours.deleteMany({ where: { venueId } });
      await tx.operatingHours.createMany({
        data: dto.hours.map((h) => ({ ...h, venueId })),
      });
      return tx.operatingHours.findMany({
        where: { venueId },
        select: { weekday: true, opensAt: true, closesAt: true },
        orderBy: { weekday: 'asc' },
      });
    });
  }

  async createResource(venueId: string, dto: CreateResourceDto) {
    await this.assertVenueExists(venueId);

    return this.prisma.resource.create({
      // Zod gives a plain Record; Prisma wants its own JSON input type. The
      // shape is validated above, so the cast is at a checked boundary.
      data: { ...dto, attributes: dto.attributes as Prisma.InputJsonObject, venueId },
      select: { id: true, kind: true, name: true, basePricePaise: true, isActive: true },
    });
  }

  async updateResource(resourceId: string, dto: UpdateResourceDto) {
    const existing = await this.prisma.resource.findFirst({
      where: { id: resourceId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Resource not found.',
      });
    }

    const { attributes, ...rest } = dto;

    return this.prisma.resource.update({
      where: { id: resourceId },
      data: {
        ...rest,
        ...(attributes !== undefined
          ? { attributes: attributes as Prisma.InputJsonObject }
          : {}),
      },
      select: {
        id: true,
        kind: true,
        name: true,
        basePricePaise: true,
        slotDurationMins: true,
        bufferMins: true,
        isActive: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Soft delete. Existing bookings reference this resource and are financial
   * records — a hard delete would orphan them.
   */
  async archiveResource(resourceId: string) {
    await this.updateResource(resourceId, {});

    return this.prisma.resource.update({
      where: { id: resourceId },
      data: { isActive: false, deletedAt: new Date() },
      select: { id: true, isActive: true, deletedAt: true },
    });
  }

  private async assertVenueExists(venueId: string): Promise<void> {
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true },
    });
    if (!venue) {
      throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found.' });
    }
  }

  /**
   * Slugs are unique only among live venues (partial index), so a soft-deleted
   * venue releases its slug. Retries on the race between checking and writing.
   */
  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'venue';

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.venue.findFirst({
        where: { slug: candidate, deletedAt: null },
        select: { id: true },
      });
      if (!taken) return candidate;
    }

    return `${base}-${Date.now().toString(36)}`;
  }

  /** Exposed for callers that need to distinguish a slug collision. */
  static isSlugCollision(err: unknown): boolean {
    return hasPgCode(err, PG_UNIQUE_VIOLATION);
  }
}
