import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { SearchVenuesDto } from './venues.schemas.js';

export interface VenueSearchRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  lat: number;
  lng: number;
  photos: string[];
  amenities: string[];
  ratingAvg: number;
  ratingCount: number;
  minPricePaise: number | null;
  distanceKm: number | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const EARTH_RADIUS_KM = 6371;

@Injectable()
export class VenuesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Search is one SQL query rather than filter-then-sort in application code:
   * distance ordering and keyset pagination have to happen in the same place,
   * or pages overlap and drop rows.
   */
  async search(params: SearchVenuesDto): Promise<Page<VenueSearchRow>> {
    const { lat, lng, radiusKm, limit, cursor } = params;
    const hasGeo = lat !== undefined && lng !== undefined;

    const where: Prisma.Sql[] = [
      Prisma.sql`v."deletedAt" IS NULL`,
      Prisma.sql`v."status" = 'ACTIVE'`,
    ];

    if (params.city) where.push(Prisma.sql`v."city" ILIKE ${params.city}`);
    if (params.q) where.push(Prisma.sql`v."name" ILIKE ${`%${params.q}%`}`);

    // kind / sport / price must all be satisfied by the SAME resource — a venue
    // with a cheap pool table and an expensive turf should not match
    // "arcade under 400" via the turf's kind.
    const resourceConds: Prisma.Sql[] = [
      Prisma.sql`r."venueId" = v."id"`,
      Prisma.sql`r."isActive" = true`,
      Prisma.sql`r."deletedAt" IS NULL`,
    ];
    if (params.kind) {
      resourceConds.push(Prisma.sql`r."kind" = ${params.kind}::"ResourceKind"`);
    }
    if (params.sport) {
      resourceConds.push(Prisma.sql`r."attributes"->>'sport' = ${params.sport}`);
    }
    if (params.minPricePaise !== undefined) {
      resourceConds.push(Prisma.sql`r."basePricePaise" >= ${params.minPricePaise}`);
    }
    if (params.maxPricePaise !== undefined) {
      resourceConds.push(Prisma.sql`r."basePricePaise" <= ${params.maxPricePaise}`);
    }

    where.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "Resource" r WHERE ${Prisma.join(resourceConds, ' AND ')})`,
    );

    if (hasGeo) {
      // Bounding box first so the (lat,lng) index can be used; the exact
      // Haversine filter then trims the corners of the box.
      const latDelta = radiusKm / 111.32;
      const lngDelta = radiusKm / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
      where.push(Prisma.sql`v."lat" BETWEEN ${lat - latDelta} AND ${lat + latDelta}`);
      where.push(Prisma.sql`v."lng" BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}`);
    }

    const distance = hasGeo
      ? Prisma.sql`${EARTH_RADIUS_KM} * acos(LEAST(1.0, GREATEST(-1.0,
          cos(radians(${lat})) * cos(radians(v."lat")) *
          cos(radians(v."lng") - radians(${lng})) +
          sin(radians(${lat})) * sin(radians(v."lat"))
        )))`
      : Prisma.sql`NULL::double precision`;

    // Keyset, not OFFSET: a venue added mid-scroll would otherwise shift every
    // later page and duplicate a row.
    const keyset = this.decodeCursor(cursor);
    const outerConds: Prisma.Sql[] = [];

    if (hasGeo) {
      outerConds.push(Prisma.sql`"distanceKm" <= ${radiusKm}`);
      if (keyset) {
        outerConds.push(
          Prisma.sql`("distanceKm", "id") > (${keyset.sort}::double precision, ${keyset.id})`,
        );
      }
    } else if (keyset) {
      // Both columns descend, so a row comparison is valid here.
      outerConds.push(
        Prisma.sql`("ratingAvg", "id") < (${keyset.sort}::double precision, ${keyset.id})`,
      );
    }

    const outerWhere =
      outerConds.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(outerConds, ' AND ')}`
        : Prisma.empty;

    const orderBy = hasGeo
      ? Prisma.sql`ORDER BY "distanceKm" ASC, "id" ASC`
      : Prisma.sql`ORDER BY "ratingAvg" DESC, "id" DESC`;

    // Fetch one extra to detect whether another page exists, without a count query.
    const rows = await this.prisma.$queryRaw<VenueSearchRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT
          v."id", v."name", v."slug", v."description", v."addressLine",
          v."city", v."state", v."pincode", v."lat", v."lng",
          v."photos", v."amenities", v."ratingAvg", v."ratingCount",
          (
            SELECT MIN(r2."basePricePaise") FROM "Resource" r2
            WHERE r2."venueId" = v."id" AND r2."isActive" = true AND r2."deletedAt" IS NULL
          ) AS "minPricePaise",
          ${distance} AS "distanceKm"
        FROM "Venue" v
        WHERE ${Prisma.join(where, ' AND ')}
      )
      SELECT * FROM candidates
      ${outerWhere}
      ${orderBy}
      LIMIT ${limit + 1}
    `);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);

    return {
      items: items.map((r) => ({
        ...r,
        // Postgres returns MIN() as a string via some drivers; normalise.
        minPricePaise: r.minPricePaise === null ? null : Number(r.minPricePaise),
        distanceKm: r.distanceKm === null ? null : Number(r.distanceKm.toFixed(2)),
      })),
      nextCursor:
        hasMore && last
          ? this.encodeCursor(hasGeo ? (last.distanceKm ?? 0) : last.ratingAvg, last.id)
          : null,
    };
  }

  async findById(id: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id, deletedAt: null, status: 'ACTIVE' },
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
        ratingAvg: true,
        ratingCount: true,
        hours: {
          select: { weekday: true, opensAt: true, closesAt: true },
          orderBy: { weekday: 'asc' },
        },
        resources: {
          where: { isActive: true, deletedAt: null },
          select: {
            id: true,
            kind: true,
            name: true,
            attributes: true,
            slotDurationMins: true,
            basePricePaise: true,
            maxPlayers: true,
          },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!venue) {
      throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found.' });
    }

    return venue;
  }

  async listResources(venueId: string) {
    // Confirms the venue exists and is visible, so a bad id 404s rather than
    // silently returning an empty list.
    await this.findById(venueId);

    return this.prisma.resource.findMany({
      where: { venueId, isActive: true, deletedAt: null },
      select: {
        id: true,
        kind: true,
        name: true,
        attributes: true,
        slotDurationMins: true,
        bufferMins: true,
        basePricePaise: true,
        maxPlayers: true,
        priceRules: {
          select: {
            id: true,
            name: true,
            weekdayMask: true,
            startMin: true,
            endMin: true,
            pricePaise: true,
            priority: true,
          },
          orderBy: { priority: 'desc' },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  private encodeCursor(sort: number, id: string): string {
    return Buffer.from(JSON.stringify({ sort, id })).toString('base64url');
  }

  private decodeCursor(cursor?: string): { sort: number; id: string } | null {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (typeof parsed?.sort === 'number' && typeof parsed?.id === 'string') return parsed;
    } catch {
      // A malformed cursor is a client bug, not a server error — start over
      // rather than 500.
    }
    return null;
  }
}
