import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { HoldSweeperService } from '../src/modules/bookings/hold-sweeper.service.js';

describe('bookings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let sweeper: HoldSweeperService;

  const RUN = `bk-${Date.now()}`;
  const ownerId = `${RUN}-owner`;
  const userAId = `${RUN}-user-a`;
  const userBId = `${RUN}-user-b`;
  const venueId = `${RUN}-venue`;
  const resId = `${RUN}-res`;
  const bufResId = `${RUN}-res-buf`;

  let tokenA: string;
  let tokenB: string;

  // A far-future Wednesday: 09:00-13:00 IST, 60-minute slots.
  const DATE = '2031-06-04';
  const SLOT_09 = '2031-06-04T03:30:00.000Z';
  const SLOT_10 = '2031-06-04T04:30:00.000Z';
  const SLOT_11 = '2031-06-04T05:30:00.000Z';
  const SLOT_12 = '2031-06-04T06:30:00.000Z';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    sweeper = app.get(HoldSweeperService);

    await prisma.user.createMany({
      data: [
        { id: ownerId, phone: `+9196${RUN.slice(-8)}1`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: userAId, phone: `+9196${RUN.slice(-8)}2`, role: 'USER', preferredSports: [] },
        { id: userBId, phone: `+9196${RUN.slice(-8)}3`, role: 'USER', preferredSports: [] },
      ],
    });
    tokenA = (await tokens.issuePair(userAId, 'USER')).accessToken;
    tokenB = (await tokens.issuePair(userBId, 'USER')).accessToken;

    await prisma.venue.create({
      data: {
        id: venueId,
        ownerId,
        name: 'Booking Test Venue',
        slug: `${RUN}-venue`,
        addressLine: '1 Test Rd',
        city: `BkCity${RUN}`,
        state: 'MH',
        pincode: '411001',
        lat: 18.5,
        lng: 73.85,
        timezone: 'Asia/Kolkata',
        contactPhone: '+919000000021',
        status: 'ACTIVE',
        // Wednesday only, 09:00-13:00 → four 60-minute slots.
        hours: { create: [{ weekday: 3, opensAt: 540, closesAt: 780 }] },
        resources: {
          create: [
            {
              id: resId,
              kind: 'TURF',
              name: 'Pitch 1',
              attributes: { sport: 'football' },
              slotDurationMins: 60,
              bufferMins: 0,
              basePricePaise: 90_000,
              priceRules: {
                create: {
                  name: 'Midday premium',
                  weekdayMask: 0b1111111,
                  startMin: 660, // 11:00
                  endMin: 780, // 13:00
                  pricePaise: 120_000,
                  priority: 10,
                },
              },
            },
            {
              id: bufResId,
              kind: 'ARCADE',
              name: 'Lane 1',
              attributes: { game: 'bowling' },
              slotDurationMins: 60,
              bufferMins: 30,
              basePricePaise: 50_000,
            },
          ],
        },
      },
    });
  });

  beforeEach(async () => {
    await prisma.booking.deleteMany({ where: { resource: { venueId } } });
  });

  afterAll(async () => {
    const ids = [ownerId, userAId, userBId];
    await prisma.booking.deleteMany({ where: { resource: { venue: { ownerId: { in: ids } } } } });
    await prisma.refreshSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.priceRule.deleteMany({ where: { resource: { venue: { ownerId: { in: ids } } } } });
    await prisma.operatingHours.deleteMany({ where: { venue: { ownerId: { in: ids } } } });
    await prisma.resource.deleteMany({ where: { venue: { ownerId: { in: ids } } } });
    await prisma.venue.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const book = (token: string, body: Record<string, unknown>, idempotencyKey?: string) => {
    const req = http().post('/api/v1/bookings').set('authorization', `Bearer ${token}`);
    if (idempotencyKey) req.set('idempotency-key', idempotencyKey);
    return req.send(body);
  };

  describe('creating', () => {
    it('requires authentication', async () => {
      await http()
        .post('/api/v1/bookings')
        .send({ resourceId: resId, startsAt: SLOT_09 })
        .expect(401);
    });

    it('creates a hold with a server-computed price', async () => {
      const res = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);

      expect(res.body.status).toBe('PENDING_PAYMENT');
      expect(res.body.amountPaise).toBe(90_000);
      expect(res.body.bookingCode).toMatch(/^KO-[0-9A-Z]{5}$/);
      expect(new Date(res.body.holdsUntil).getTime()).toBeGreaterThan(Date.now());
    });

    it('prices from the matching rule, not the base price', async () => {
      // 11:00 falls inside the midday premium window.
      const res = await book(tokenA, { resourceId: resId, startsAt: SLOT_11 }).expect(201);
      expect(res.body.amountPaise).toBe(120_000);
    });

    it('ignores any amount the client sends', async () => {
      // Unknown fields are stripped by the schema; the price is always derived
      // server-side, or anyone could book a ₹1200 pitch for ₹1.
      const res = await book(tokenA, {
        resourceId: resId,
        startsAt: SLOT_11,
        amountPaise: 100,
      }).expect(201);

      expect(res.body.amountPaise).toBe(120_000);
    });

    it('rejects a start time that is not a real slot boundary', async () => {
      const res = await book(tokenA, {
        resourceId: resId,
        startsAt: '2031-06-04T03:45:00.000Z',
      }).expect(409);

      expect(res.body.error.code).toBe('INVALID_SLOT');
    });

    it('rejects a slot outside operating hours', async () => {
      const res = await book(tokenA, {
        resourceId: resId,
        startsAt: '2031-06-04T20:00:00.000Z',
      }).expect(409);
      expect(res.body.error.code).toBe('INVALID_SLOT');
    });

    it('404s an unknown resource', async () => {
      const res = await book(tokenA, { resourceId: 'nope', startsAt: SLOT_09 }).expect(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('multi-slot', () => {
    it('books consecutive slots as ONE row spanning the range', async () => {
      const res = await book(tokenA, {
        resourceId: resId,
        startsAt: SLOT_09,
        slots: 2,
      }).expect(201);

      // One range, one constraint check, one refund.
      expect(res.body.startsAt).toBe(SLOT_09);
      expect(res.body.endsAt).toBe(SLOT_11);
      expect(res.body.amountPaise).toBe(180_000);

      const rows = await prisma.booking.count({ where: { resourceId: resId } });
      expect(rows).toBe(1);
    });

    it('sums per-slot prices across a rule boundary', async () => {
      // 10:00 at base (90000) + 11:00 at premium (120000).
      const res = await book(tokenA, {
        resourceId: resId,
        startsAt: SLOT_10,
        slots: 2,
      }).expect(201);
      expect(res.body.amountPaise).toBe(210_000);
    });

    it('refuses when the venue closes before the booking would end', async () => {
      // 12:00 is the last slot; asking for two runs past 13:00.
      const res = await book(tokenA, {
        resourceId: resId,
        startsAt: SLOT_12,
        slots: 2,
      }).expect(409);
      expect(res.body.error.code).toBe('INVALID_SLOT');
    });

    it('refuses when any slot in the span is taken', async () => {
      await book(tokenB, { resourceId: resId, startsAt: SLOT_10 }).expect(201);

      const res = await book(tokenA, {
        resourceId: resId,
        startsAt: SLOT_09,
        slots: 2,
      }).expect(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    });
  });

  describe('conflicts', () => {
    it('returns 409 when the slot is already held by someone else', async () => {
      await book(tokenB, { resourceId: resId, startsAt: SLOT_09 }).expect(201);

      const res = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('lets exactly one of many simultaneous requests win', async () => {
      const attempts = Array.from({ length: 12 }, () =>
        book(tokenA, { resourceId: resId, startsAt: SLOT_09 }),
      );
      const results = await Promise.all(attempts);

      const created = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 409);

      expect(created).toHaveLength(1);
      expect(rejected).toHaveLength(11);
      expect(rejected.every((r) => r.body.error.code === 'SLOT_UNAVAILABLE')).toBe(true);
    });

    it('recovers inline when the blocking hold has already expired', async () => {
      // The constraint's WHERE cannot reference now(), so this expired hold
      // still blocks the slot until something updates its status. The request
      // must clear it and succeed rather than 409.
      await prisma.booking.create({
        data: {
          id: `${RUN}-stale`,
          bookingCode: 'KO-STALE',
          userId: userBId,
          resourceId: resId,
          startsAt: new Date(SLOT_09),
          endsAt: new Date(SLOT_10),
          status: 'PENDING_PAYMENT',
          amountPaise: 90_000,
          holdsUntil: new Date(Date.now() - 60_000),
        },
      });

      const res = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);
      expect(res.body.status).toBe('PENDING_PAYMENT');

      const stale = await prisma.booking.findUnique({ where: { id: `${RUN}-stale` } });
      expect(stale?.status).toBe('EXPIRED');
    });

    it('still 409s when the blocking hold is live', async () => {
      await prisma.booking.create({
        data: {
          id: `${RUN}-live`,
          bookingCode: 'KO-LIVE1',
          userId: userBId,
          resourceId: resId,
          startsAt: new Date(SLOT_09),
          endsAt: new Date(SLOT_10),
          status: 'PENDING_PAYMENT',
          amountPaise: 90_000,
          holdsUntil: new Date(Date.now() + 10 * 60_000),
        },
      });

      await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(409);
    });
  });

  describe('idempotency', () => {
    it('collapses retries with the same key into one booking', async () => {
      const key = `${RUN}-idem-1`;

      const first = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }, key).expect(201);
      const retry = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }, key).expect(201);

      expect(retry.body.id).toBe(first.body.id);

      const count = await prisma.booking.count({ where: { resourceId: resId } });
      expect(count).toBe(1);
    });

    it('without a key, a repeat request conflicts instead of double-booking', async () => {
      await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);
      await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(409);
    });
  });

  describe('buffer', () => {
    it('stores the widened range but reports the play window', async () => {
      const res = await book(tokenA, { resourceId: bufResId, startsAt: SLOT_09 }).expect(201);

      // Client sees the hour they actually play.
      expect(res.body.endsAt).toBe(SLOT_10);
      // The stored range carries the 30-minute cleanup gap.
      expect(res.body.occupiedUntil).toBe('2031-06-04T05:00:00.000Z');

      const row = await prisma.booking.findUnique({ where: { id: res.body.id } });
      expect(row?.endsAt.toISOString()).toBe('2031-06-04T05:00:00.000Z');
    });

    it('blocks the following slot through the cleanup gap', async () => {
      await book(tokenA, { resourceId: bufResId, startsAt: SLOT_09 }).expect(201);

      const res = await book(tokenB, { resourceId: bufResId, startsAt: SLOT_10 }).expect(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    });
  });

  describe('availability integration', () => {
    it('shows a new hold as HELD, then AVAILABLE again after cancelling', async () => {
      const created = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);

      const held = await http()
        .get(`/api/v1/resources/${resId}/availability?date=${DATE}`)
        .expect(200);
      expect(held.body.slots[0].state).toBe('HELD');

      await http()
        .post(`/api/v1/bookings/${created.body.id}/cancel`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({ reason: 'changed my mind' })
        .expect(200);

      const freed = await http()
        .get(`/api/v1/resources/${resId}/availability?date=${DATE}`)
        .expect(200);
      expect(freed.body.slots[0].state).toBe('AVAILABLE');
    });
  });

  describe('reading', () => {
    it('lists only the caller’s own bookings', async () => {
      await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);
      await book(tokenB, { resourceId: resId, startsAt: SLOT_10 }).expect(201);

      const mine = await http()
        .get('/api/v1/bookings/me')
        .set('authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].startsAt).toBe(SLOT_09);
    });

    it('404s another user’s booking rather than 403ing and confirming it exists', async () => {
      const created = await book(tokenB, { resourceId: resId, startsAt: SLOT_09 }).expect(201);

      const res = await http()
        .get(`/api/v1/bookings/${created.body.id}`)
        .set('authorization', `Bearer ${tokenA}`)
        .expect(404);
      expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
    });
  });

  describe('cancelling', () => {
    it('previews the refund without performing the cancellation', async () => {
      const created = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);

      const preview = await http()
        .get(`/api/v1/bookings/${created.body.id}/cancellation-preview`)
        .set('authorization', `Bearer ${tokenA}`)
        .expect(200);

      // Booked far in the future, so a full refund.
      expect(preview.body).toMatchObject({ tier: 'FULL_EARLY', cancellable: true });
      expect(preview.body.refundPaise).toBe(90_000);

      const still = await prisma.booking.findUnique({ where: { id: created.body.id } });
      expect(still?.status).toBe('PENDING_PAYMENT');
    });

    it('cancels and returns the refund decision', async () => {
      const created = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);

      const res = await http()
        .post(`/api/v1/bookings/${created.body.id}/cancel`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(200);

      expect(res.body.booking.status).toBe('CANCELLED');
      expect(res.body.refund.refundPaise).toBe(90_000);
    });

    it('refuses to cancel twice', async () => {
      const created = await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);
      const url = `/api/v1/bookings/${created.body.id}/cancel`;

      await http().post(url).set('authorization', `Bearer ${tokenA}`).send({}).expect(200);

      const res = await http()
        .post(url)
        .set('authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(409);
      expect(res.body.error.code).toBe('BOOKING_NOT_CANCELLABLE');
    });

    it('will not let one user cancel another’s booking', async () => {
      const created = await book(tokenB, { resourceId: resId, startsAt: SLOT_09 }).expect(201);

      await http()
        .post(`/api/v1/bookings/${created.body.id}/cancel`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(404);

      const row = await prisma.booking.findUnique({ where: { id: created.body.id } });
      expect(row?.status).toBe('PENDING_PAYMENT');
    });
  });

  describe('hold sweeper', () => {
    it('expires holds past holdsUntil and frees the slot', async () => {
      await prisma.booking.create({
        data: {
          id: `${RUN}-sweep`,
          bookingCode: 'KO-SWEEP',
          userId: userBId,
          resourceId: resId,
          startsAt: new Date(SLOT_09),
          endsAt: new Date(SLOT_10),
          status: 'PENDING_PAYMENT',
          amountPaise: 90_000,
          holdsUntil: new Date(Date.now() - 60_000),
        },
      });

      const expired = await sweeper.expireHolds();
      expect(expired).toBeGreaterThanOrEqual(1);

      const row = await prisma.booking.findUnique({ where: { id: `${RUN}-sweep` } });
      expect(row?.status).toBe('EXPIRED');

      // And the slot is bookable again.
      await book(tokenA, { resourceId: resId, startsAt: SLOT_09 }).expect(201);
    });

    it('leaves live holds alone', async () => {
      await prisma.booking.create({
        data: {
          id: `${RUN}-keep`,
          bookingCode: 'KO-KEEP1',
          userId: userBId,
          resourceId: resId,
          startsAt: new Date(SLOT_09),
          endsAt: new Date(SLOT_10),
          status: 'PENDING_PAYMENT',
          amountPaise: 90_000,
          holdsUntil: new Date(Date.now() + 10 * 60_000),
        },
      });

      await sweeper.expireHolds();

      const row = await prisma.booking.findUnique({ where: { id: `${RUN}-keep` } });
      expect(row?.status).toBe('PENDING_PAYMENT');
    });
  });
});
