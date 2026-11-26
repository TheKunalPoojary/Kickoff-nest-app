import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  InvalidUploadException,
  PG_UNIQUE_VIOLATION,
  hasPgCode,
} from '../../common/errors/domain.errors.js';
import { StorageService } from '../../infra/storage/storage.service.js';
import { detectImageType } from '../../infra/storage/image-type.js';
import type {
  CreateResourceDto,
  CreateVenueDto,
  OperatingHoursDto,
  UpdateResourceDto,
  UpdateVenueDto,
} from './owner.schemas.js';

export const MAX_VENUE_PHOTOS = 20;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

@Injectable()
export class OwnerVenuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

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

  /** Everything the portal's venue workspace needs, in one round trip. */
  async getMine(venueId: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        addressLine: true,
        city: true,
        state: true,
        pincode: true,
        lat: true,
        lng: true,
        timezone: true,
        photos: true,
        amenities: true,
        contactPhone: true,
        status: true,
        ratingAvg: true,
        ratingCount: true,
        // Set by the platform admin; shown read-only to the owner.
        commissionPct: true,
        advancePct: true,
        hours: {
          select: { weekday: true, opensAt: true, closesAt: true },
          orderBy: { weekday: 'asc' },
        },
        resources: {
          where: { deletedAt: null },
          select: {
            id: true,
            kind: true,
            name: true,
            attributes: true,
            slotDurationMins: true,
            bufferMins: true,
            basePricePaise: true,
            maxPlayers: true,
            isActive: true,
            priceRules: {
              select: {
                id: true,
                name: true,
                weekdayMask: true,
                startMin: true,
                endMin: true,
                pricePaise: true,
                priority: true,
                validFrom: true,
                validUntil: true,
              },
              orderBy: [{ priority: 'desc' }, { startMin: 'asc' }],
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!venue) {
      throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found.' });
    }
    return { ...venue, commissionPct: Number(venue.commissionPct) };
  }

  async addPhoto(venueId: string, file: { buffer: Buffer; size: number } | undefined) {
    if (!file) throw new InvalidUploadException('Attach an image in the "file" field.');
    if (file.size > MAX_PHOTO_BYTES) throw new InvalidUploadException('Images must be 5 MB or smaller.');

    const type = detectImageType(file.buffer);
    if (!type) throw new InvalidUploadException('Only JPEG, PNG and WebP images are accepted.');

    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { photos: true },
    });
    if (!venue) {
      throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found.' });
    }
    if (venue.photos.length >= MAX_VENUE_PHOTOS) {
      throw new InvalidUploadException(`A venue can have at most ${MAX_VENUE_PHOTOS} photos.`);
    }

    const { url } = await this.storage.save(file.buffer, type, `venue-${venueId}`);

    // `push` is an atomic array append, so two concurrent uploads cannot
    // overwrite each other's URL.
    return this.prisma.venue.update({
      where: { id: venueId },
      data: { photos: { push: url } },
      select: { id: true, photos: true },
    });
  }

  async removePhoto(venueId: string, url: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { photos: true },
    });
    if (!venue) {
      throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found.' });
    }
    if (!venue.photos.includes(url)) {
      throw new NotFoundException({ code: 'PHOTO_NOT_FOUND', message: 'Photo not found.' });
    }

    const updated = await this.prisma.venue.update({
      where: { id: venueId },
      data: { photos: venue.photos.filter((p) => p !== url) },
      select: { id: true, photos: true },
    });
    // After the DB write: a stray file is harmless, a dangling URL is a broken image.
    await this.storage.remove(url);
    return updated;
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
