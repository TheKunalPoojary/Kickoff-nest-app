import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';

describe('availability (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  const RUN = `av-${Date.now()}`;
  const ownerId = `${RUN}-owner`;
  const otherOwnerId = `${RUN}-other`;
  const playerId = `${RUN}-player`;
  const venueId = `${RUN}-venue`;
  const nyVenueId = `${RUN}-venue-ny`;

  // bufferMins 0 — the plain case.
  const resId = `${RUN}-res`;
  // bufferMins 30 — cleanup gap.
  const bufResId = `${RUN}-res-buffer`;
  // Different timezone, to prove local rendering follows the VENUE.
  const nyResId = `${RUN}-res-ny`;

  let ownerToken: string;
  let otherOwnerToken: string;

  // A Saturday and a Wednesday, far enough out that nothing is in the past.
  const SATURDAY = '2030-06-01';
  const WEDNESDAY = '2030-06-05';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    await prisma.user.createMany({
      data: [
        { id: ownerId, phone: `+9197${RUN.slice(-8)}1`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: otherOwnerId, phone: `+9197${RUN.slice(-8)}2`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: playerId, phone: `+9197${RUN.slice(-8)}3`, role: 'USER', preferredSports: [] },
      ],
    });
    ownerToken = (await tokens.issuePair(ownerId, 'VENUE_OWNER')).accessToken;
    otherOwnerToken = (await tokens.issuePair(otherOwnerId, 'VENUE_OWNER')).accessToken;

    await prisma.venue.create({
      data: {
        id: venueId,
        ownerId,
        name: 'Availability Test Venue',
        slug: `${RUN}-venue`,
        addressLine: '1 Test Rd',
        city: `AvCity${RUN}`,
        state: 'MH',
        pincode: '411001',
        lat: 18.5,
        lng: 73.85,
        timezone: 'Asia/Kolkata',
        contactPhone: '+919000000011',
        status: 'ACTIVE',
        hours: {
          create: [
            // Sat (6): 06:00 -> 01:00 next day.
            { weekday: 6, opensAt: 360, closesAt: 1500 },
            // Wed (3): 09:00 -> 12:00, a short window for exact-count asserts.
            { weekday: 3, opensAt: 540, closesAt: 720 },
            // Sunday (0) deliberately absent: the venue is closed.
          ],
        },
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
                  name: 'Weekend',
                  weekdayMask: 0b1000001,
                  startMin: 360,
                  endMin: 1500,
                  pricePaise: 150_000,
                  priority: 20,
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

    await prisma.venue.create({
      data: {
        id: nyVenueId,
        ownerId,
        name: 'NY Test Venue',
        slug: `${RUN}-venue-ny`,
        addressLine: '1 Broadway',
        city: `AvCityNY${RUN}`,
        state: 'NY',
        pincode: '100001',
        lat: 40.7,
        lng: -74.0,
        timezone: 'America/New_York',
        contactPhone: '+919000000012',
        status: 'ACTIVE',
        hours: { create: [{ weekday: 3, opensAt: 540, closesAt: 720 }] },
        resources: {
          create: {
            id: nyResId,
            kind: 'TURF',
            name: 'NY Pitch',
            attributes: { sport: 'football' },
            slotDurationMins: 60,
            basePricePaise: 100_000,
          },
        },
      },
    });
  });

  afterAll(async () => {
    const ids = [ownerId, otherOwnerId, playerId];
    await prisma.blackout.deleteMany({ where: { resource: { venue: { ownerId: { in: ids } } } } });
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

  const getSlots = async (resource: string, date: string) => {
    const res = await http()
      .get(`/api/v1/resources/${resource}/availability?date=${date}`)
      .expect(200);
    return res.body as {
      timezone: string;
      slots: {
        startsAt: string;
        endsAt: string;
        localStart: string;
        localEnd: string;
        state: string;
        pricePaise: number;
      }[];
    };
  };

  describe('slot generation', () => {
    it('generates one slot per interval across the operating window', async () => {
      // Wed 09:00-12:00 with 60-minute slots.
      const { slots } = await getSlots(resId, WEDNESDAY);
      expect(slots).toHaveLength(3);
      expect(slots.map((s) => s.localStart)).toEqual(['09:00', '10:00', '11:00']);
    });

    it('rolls past midnight when the venue closes after 00:00', async () => {
      // Sat opens 06:00 and closes 01:00 the NEXT day (closesAt 1500 > 1440).
      const { slots } = await getSlots(resId, SATURDAY);
      expect(slots).toHaveLength(19);

      const last = slots.at(-1)!;
      expect(last.localStart).toBe('00:00');
      expect(last.localEnd).toBe('01:00');
      // 00:00 IST on the 2nd is 18:30 UTC on the 1st.
      expect(last.startsAt).toBe('2030-06-01T18:30:00.000Z');
    });

    it('converts venue-local time to the correct UTC instant', async () => {
      const { slots } = await getSlots(resId, WEDNESDAY);
      // 09:00 IST = 03:30 UTC.
      expect(slots[0].startsAt).toBe('2030-06-05T03:30:00.000Z');
    });

    it('renders local times in the VENUE timezone, not the server or caller', async () => {
      const ny = await getSlots(nyResId, WEDNESDAY);
      expect(ny.timezone).toBe('America/New_York');
      expect(ny.slots[0].localStart).toBe('09:00');
      // 09:00 EDT (June, DST active) = 13:00 UTC — not 14:00, which is what a
      // hardcoded -5 offset would produce.
      expect(ny.slots[0].startsAt).toBe('2030-06-05T13:00:00.000Z');
    });

    it('returns no slots on a day with no operating hours', async () => {
      const sunday = '2030-06-02';
      const { slots } = await getSlots(resId, sunday);
      expect(slots).toEqual([]);
    });

    it('404s an unknown resource', async () => {
      const res = await http()
        .get(`/api/v1/resources/nope/availability?date=${WEDNESDAY}`)
        .expect(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('rejects a malformed date', async () => {
      const res = await http()
        .get(`/api/v1/resources/${resId}/availability?date=05-06-2030`)
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('pricing', () => {
    it('applies the highest-priority matching rule', async () => {
      const { slots } = await getSlots(resId, SATURDAY);
      expect(slots.every((s) => s.pricePaise === 150_000)).toBe(true);
    });

    it('falls back to the base price when no rule matches', async () => {
      const { slots } = await getSlots(resId, WEDNESDAY);
      expect(slots.every((s) => s.pricePaise === 90_000)).toBe(true);
    });
  });

  describe('conflicts', () => {
    const bookSlot = (
      id: string,
      startsAt: string,
      endsAt: string,
      status: 'CONFIRMED' | 'PENDING_PAYMENT',
      holdsUntil?: Date,
    ) =>
      prisma.booking.create({
        data: {
          id: `${RUN}-${id}`,
          bookingCode: `KO-${RUN}-${id}`,
          userId: playerId,
          resourceId: resId,
          startsAt: new Date(startsAt),
          endsAt: new Date(endsAt),
          status,
          amountPaise: 90_000,
          holdsUntil,
        },
      });

    it('marks a confirmed booking as BOOKED', async () => {
      // 09:00-10:00 IST on the Wednesday.
      await bookSlot('b1', '2030-06-05T03:30:00Z', '2030-06-05T04:30:00Z', 'CONFIRMED');

      const { slots } = await getSlots(resId, WEDNESDAY);
      expect(slots[0].state).toBe('BOOKED');
      expect(slots[1].state).toBe('AVAILABLE');
    });

    it('marks a live hold as HELD, distinct from BOOKED', async () => {
      await bookSlot(
        'b2',
        '2030-06-05T04:30:00Z',
        '2030-06-05T05:30:00Z',
        'PENDING_PAYMENT',
        new Date(Date.now() + 10 * 60_000),
      );

      const { slots } = await getSlots(resId, WEDNESDAY);
      // Users accept losing a slot; they do not accept one that looked free.
      expect(slots[1].state).toBe('HELD');
    });

    it('ignores an expired hold rather than showing a phantom booking', async () => {
      // The sweeper runs every 60s; until it does, this row still exists with
      // status PENDING_PAYMENT. It must not hide the slot.
      await bookSlot(
        'b3',
        '2030-06-05T05:30:00Z',
        '2030-06-05T06:30:00Z',
        'PENDING_PAYMENT',
        new Date(Date.now() - 60_000),
      );

      const { slots } = await getSlots(resId, WEDNESDAY);
      expect(slots[2].state).toBe('AVAILABLE');
    });

    it('enforces the cleanup buffer by widening the occupied range', async () => {
      // Lane 1 has bufferMins 30. A booking stored 09:00-10:30 IST (one hour of
      // play plus its cleanup gap) must also take out the 10:00 slot.
      await prisma.booking.create({
        data: {
          id: `${RUN}-buf`,
          bookingCode: `KO-${RUN}-buf`,
          userId: playerId,
          resourceId: bufResId,
          startsAt: new Date('2030-06-05T03:30:00Z'),
          endsAt: new Date('2030-06-05T05:00:00Z'),
          status: 'CONFIRMED',
          amountPaise: 50_000,
        },
      });

      const res = await http()
        .get(`/api/v1/resources/${bufResId}/availability?date=${WEDNESDAY}`)
        .expect(200);
      const slots = res.body.slots as { localStart: string; state: string }[];

      expect(slots.find((s) => s.localStart === '09:00')?.state).toBe('BOOKED');
      expect(slots.find((s) => s.localStart === '10:00')?.state).toBe('BOOKED');
      expect(slots.find((s) => s.localStart === '11:00')?.state).toBe('AVAILABLE');
    });

    it('marks past slots as PAST', async () => {
      // Step back to the most recent Wednesday or Saturday — the only days this
      // venue opens. Using plain "yesterday" would usually land on a closed day
      // and pass without asserting anything.
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      while (![3, 6].includes(d.getUTCDay())) {
        d.setUTCDate(d.getUTCDate() - 1);
      }
      const pastDate = d.toISOString().slice(0, 10);

      const { slots } = await getSlots(resId, pastDate);

      expect(slots.length).toBeGreaterThan(0);
      expect(slots.every((s) => s.state === 'PAST')).toBe(true);
    });
  });

  describe('blackouts', () => {
    it('requires ownership to create one', async () => {
      const res = await http()
        .post(`/api/v1/owner/resources/${resId}/blackouts`)
        .set('authorization', `Bearer ${otherOwnerToken}`)
        .send({
          startsAt: '2030-06-05T06:30:00Z',
          endsAt: '2030-06-05T07:30:00Z',
          reason: 'Hijack attempt',
        })
        .expect(403);
      expect(res.body.error.code).toBe('NOT_VENUE_OWNER');
    });

    it('hides the covered slot from availability', async () => {
      // 12:00-13:00 IST does not exist on Wed (closes 12:00), so use the
      // Saturday window instead: 12:00-13:00 IST = 06:30-07:30 UTC.
      const created = await http()
        .post(`/api/v1/owner/resources/${resId}/blackouts`)
        .set('authorization', `Bearer ${ownerToken}`)
        .send({
          startsAt: '2030-06-01T06:30:00Z',
          endsAt: '2030-06-01T07:30:00Z',
          reason: 'Maintenance',
        })
        .expect(201);

      expect(created.body.conflictingBookings).toBe(0);

      const { slots } = await getSlots(resId, SATURDAY);
      expect(slots.find((s) => s.localStart === '12:00')?.state).toBe('BLACKED_OUT');
      expect(slots.find((s) => s.localStart === '13:00')?.state).toBe('AVAILABLE');

      await http()
        .delete(`/api/v1/owner/resources/${resId}/blackouts/${created.body.id}`)
        .set('authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const after = await getSlots(resId, SATURDAY);
      expect(after.slots.find((s) => s.localStart === '12:00')?.state).toBe('AVAILABLE');
    });

    it('rejects a blackout that ends before it starts', async () => {
      await http()
        .post(`/api/v1/owner/resources/${resId}/blackouts`)
        .set('authorization', `Bearer ${ownerToken}`)
        .send({ startsAt: '2030-06-01T08:00:00Z', endsAt: '2030-06-01T07:00:00Z' })
        .expect(400);
    });

    it('reports how many bookings a blackout would disrupt, without blocking it', async () => {
      // A venue closing for a burst pipe must be able to say so; the affected
      // bookings still need cancelling and refunding, which is phase 5's job.
      const res = await http()
        .post(`/api/v1/owner/resources/${resId}/blackouts`)
        .set('authorization', `Bearer ${ownerToken}`)
        .send({
          startsAt: '2030-06-05T03:30:00Z',
          endsAt: '2030-06-05T04:30:00Z',
          reason: 'Emergency repair',
        })
        .expect(201);

      expect(res.body.conflictingBookings).toBe(1);
    });
  });
});
