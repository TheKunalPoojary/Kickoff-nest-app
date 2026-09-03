import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';

describe('venues (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  const RUN = `vt-${Date.now()}`;
  const ownerAId = `${RUN}-owner-a`;
  const ownerBId = `${RUN}-owner-b`;
  const playerId = `${RUN}-player`;
  const venueAId = `${RUN}-venue-a`;
  const resourceAId = `${RUN}-res-a`;

  let ownerAToken: string;
  let ownerBToken: string;
  let playerToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    // Minted directly rather than via OTP: the OTP endpoint is rate limited to
    // 3/hour per phone, which would make repeated test runs flaky.
    await prisma.user.createMany({
      data: [
        { id: ownerAId, phone: `+9198${RUN.slice(-8)}1`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: ownerBId, phone: `+9198${RUN.slice(-8)}2`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: playerId, phone: `+9198${RUN.slice(-8)}3`, role: 'USER', preferredSports: [] },
      ],
    });

    ownerAToken = (await tokens.issuePair(ownerAId, 'VENUE_OWNER')).accessToken;
    ownerBToken = (await tokens.issuePair(ownerBId, 'VENUE_OWNER')).accessToken;
    playerToken = (await tokens.issuePair(playerId, 'USER')).accessToken;

    await prisma.venue.create({
      data: {
        id: venueAId,
        ownerId: ownerAId,
        name: 'Owner A Turf',
        slug: `${RUN}-owner-a-turf`,
        addressLine: '1 Test Rd',
        city: `TestCity${RUN}`,
        state: 'MH',
        pincode: '411001',
        lat: 18.5,
        lng: 73.85,
        contactPhone: '+919000000009',
        status: 'ACTIVE',
        resources: {
          create: {
            id: resourceAId,
            kind: 'TURF',
            name: 'Pitch 1',
            attributes: { sport: 'football' },
            basePricePaise: 100_000,
          },
        },
      },
    });
  });

  afterAll(async () => {
    const ids = [ownerAId, ownerBId, playerId];
    await prisma.refreshSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.priceRule.deleteMany({ where: { resource: { venue: { ownerId: { in: ids } } } } });
    await prisma.operatingHours.deleteMany({ where: { venue: { ownerId: { in: ids } } } });
    await prisma.resource.deleteMany({ where: { venue: { ownerId: { in: ids } } } });
    await prisma.venue.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('public browsing', () => {
    it('lists venues without a token', async () => {
      const res = await http().get('/api/v1/venues').expect(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('returns venue detail with hours and resources', async () => {
      const res = await http().get(`/api/v1/venues/${venueAId}`).expect(200);
      expect(res.body.name).toBe('Owner A Turf');
      expect(res.body.resources).toHaveLength(1);
      expect(res.body.timezone).toBe('Asia/Kolkata');
    });

    it('404s an unknown venue rather than returning an empty object', async () => {
      const res = await http().get('/api/v1/venues/nope').expect(404);
      expect(res.body.error.code).toBe('VENUE_NOT_FOUND');
    });

    it('404s resources of an unknown venue rather than an empty list', async () => {
      const res = await http().get('/api/v1/venues/nope/resources').expect(404);
      expect(res.body.error.code).toBe('VENUE_NOT_FOUND');
    });

    it('filters by kind', async () => {
      const res = await http()
        .get(`/api/v1/venues?city=TestCity${RUN}&kind=TURF`)
        .expect(200);
      expect(res.body.items.map((v: { id: string }) => v.id)).toContain(venueAId);

      const arcade = await http()
        .get(`/api/v1/venues?city=TestCity${RUN}&kind=ARCADE`)
        .expect(200);
      expect(arcade.body.items).toHaveLength(0);
    });

    it('requires kind and price to be satisfied by the SAME resource', async () => {
      // The venue has one TURF at 100000. Asking for a TURF under 50000 must
      // not match just because the venue exists.
      const res = await http()
        .get(`/api/v1/venues?city=TestCity${RUN}&kind=TURF&maxPricePaise=50000`)
        .expect(200);
      expect(res.body.items).toHaveLength(0);
    });

    it('returns distance when given coordinates, and honours the radius', async () => {
      const near = await http()
        .get(`/api/v1/venues?lat=18.5&lng=73.85&radiusKm=5&city=TestCity${RUN}`)
        .expect(200);
      expect(near.body.items[0].distanceKm).toBeLessThan(1);

      const far = await http()
        .get(`/api/v1/venues?lat=28.6&lng=77.2&radiusKm=5&city=TestCity${RUN}`)
        .expect(200);
      expect(far.body.items).toHaveLength(0);
    });

    it('rejects lat without lng', async () => {
      const res = await http().get('/api/v1/venues?lat=18.5').expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('treats a malformed cursor as the first page instead of erroring', async () => {
      await http().get('/api/v1/venues?cursor=%21%21not-base64').expect(200);
    });

    it('paginates without duplicating or dropping rows', async () => {
      const all = await http().get(`/api/v1/venues?city=TestCity${RUN}&limit=50`).expect(200);
      const expected = all.body.items.map((v: { id: string }) => v.id);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const url =
          `/api/v1/venues?city=TestCity${RUN}&limit=1` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const page: { body: { items: { id: string }[]; nextCursor: string | null } } =
          await http().get(url).expect(200);
        seen.push(...page.body.items.map((v) => v.id));
        cursor = page.body.nextCursor;
        if (!cursor) break;
      }

      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  describe('owner routes', () => {
    it('rejects an anonymous caller', async () => {
      await http().get('/api/v1/owner/venues').expect(401);
    });

    it('rejects a plain USER by role', async () => {
      const res = await http()
        .get('/api/v1/owner/venues')
        .set('authorization', `Bearer ${playerToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
    });

    it('lists only the calling owner’s venues', async () => {
      const res = await http()
        .get('/api/v1/owner/venues')
        .set('authorization', `Bearer ${ownerAToken}`)
        .expect(200);
      expect(res.body.map((v: { id: string }) => v.id)).toEqual([venueAId]);

      const bList = await http()
        .get('/api/v1/owner/venues')
        .set('authorization', `Bearer ${ownerBToken}`)
        .expect(200);
      expect(bList.body).toHaveLength(0);
    });

    it('lets an owner update their own venue', async () => {
      const res = await http()
        .patch(`/api/v1/owner/venues/${venueAId}`)
        .set('authorization', `Bearer ${ownerAToken}`)
        .send({ description: 'Updated by owner A' })
        .expect(200);
      expect(res.body.id).toBe(venueAId);
    });

    it('BLOCKS a different owner from updating that venue', async () => {
      // The whole point of VenueOwnershipGuard. Role alone would allow this.
      const res = await http()
        .patch(`/api/v1/owner/venues/${venueAId}`)
        .set('authorization', `Bearer ${ownerBToken}`)
        .send({ description: 'Hijacked by owner B' })
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENUE_OWNER');

      const venue = await prisma.venue.findUnique({ where: { id: venueAId } });
      expect(venue?.description).toBe('Updated by owner A');
    });

    it('BLOCKS a different owner from editing that venue’s resource', async () => {
      const res = await http()
        .patch(`/api/v1/owner/resources/${resourceAId}`)
        .set('authorization', `Bearer ${ownerBToken}`)
        .send({ basePricePaise: 1 })
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENUE_OWNER');

      const resource = await prisma.resource.findUnique({ where: { id: resourceAId } });
      expect(resource?.basePricePaise).toBe(100_000);
    });

    it('creates a venue as PENDING_APPROVAL, not instantly live', async () => {
      const res = await http()
        .post('/api/v1/owner/venues')
        .set('authorization', `Bearer ${ownerBToken}`)
        .send({
          name: `Owner B Arena ${RUN}`,
          addressLine: '9 New Rd',
          city: `TestCity${RUN}`,
          state: 'MH',
          pincode: '411002',
          lat: 18.51,
          lng: 73.86,
          contactPhone: '+919000000010',
        })
        .expect(201);

      expect(res.body.status).toBe('PENDING_APPROVAL');
      expect(res.body.slug).toBeTruthy();

      // And therefore must not appear in public search yet.
      const publicList = await http()
        .get(`/api/v1/venues?city=TestCity${RUN}&limit=50`)
        .expect(200);
      expect(publicList.body.items.map((v: { id: string }) => v.id)).not.toContain(res.body.id);
    });

    it('replaces operating hours wholesale rather than merging', async () => {
      await http()
        .put(`/api/v1/owner/venues/${venueAId}/hours`)
        .set('authorization', `Bearer ${ownerAToken}`)
        .send({ hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt: 360, closesAt: 1380 })) })
        .expect(200);

      const res = await http()
        .put(`/api/v1/owner/venues/${venueAId}/hours`)
        .set('authorization', `Bearer ${ownerAToken}`)
        .send({ hours: [{ weekday: 6, opensAt: 480, closesAt: 1560 }] })
        .expect(200);

      // Old weekdays must be gone — a merge would leave the venue accepting
      // bookings on days it just closed.
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ weekday: 6, opensAt: 480, closesAt: 1560 });
    });

    it('rejects hours where closing precedes opening', async () => {
      const res = await http()
        .put(`/api/v1/owner/venues/${venueAId}/hours`)
        .set('authorization', `Bearer ${ownerAToken}`)
        .send({ hours: [{ weekday: 1, opensAt: 1200, closesAt: 600 }] })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a duplicate weekday', async () => {
      await http()
        .put(`/api/v1/owner/venues/${venueAId}/hours`)
        .set('authorization', `Bearer ${ownerAToken}`)
        .send({
          hours: [
            { weekday: 1, opensAt: 360, closesAt: 1380 },
            { weekday: 1, opensAt: 400, closesAt: 1300 },
          ],
        })
        .expect(400);
    });

    it('archives a resource without destroying its booking history', async () => {
      const created = await http()
        .post(`/api/v1/owner/venues/${venueAId}/resources`)
        .set('authorization', `Bearer ${ownerAToken}`)
        .send({ kind: 'ARCADE', name: 'Temp Lane', basePricePaise: 50_000 })
        .expect(201);

      await http()
        .delete(`/api/v1/owner/resources/${created.body.id}`)
        .set('authorization', `Bearer ${ownerAToken}`)
        .expect(200);

      // Soft delete: the row survives so bookings referencing it stay valid.
      const row = await prisma.resource.findUnique({ where: { id: created.body.id } });
      expect(row).not.toBeNull();
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.isActive).toBe(false);

      // But it disappears from the public listing.
      const listed = await http().get(`/api/v1/venues/${venueAId}/resources`).expect(200);
      expect(listed.body.map((r: { id: string }) => r.id)).not.toContain(created.body.id);
    });
  });
});
