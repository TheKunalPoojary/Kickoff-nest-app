import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { RazorpayClient } from '../src/modules/payments/razorpay.client.js';

/** Network calls faked; the real HMAC verification still runs. */
class FakeRazorpay extends RazorpayClient {
  orders: { amountPaise: number; receipt: string }[] = [];
  refunds: { paymentId: string; amountPaise: number }[] = [];
  private seq = 0;

  override async createOrder(params: { amountPaise: number; receipt: string }) {
    this.orders.push(params);
    return {
      id: `order_op_${++this.seq}_${Date.now()}`,
      amount: params.amountPaise,
      currency: 'INR',
      status: 'created',
      receipt: params.receipt,
    };
  }

  override async refund(paymentId: string, amountPaise: number) {
    this.refunds.push({ paymentId, amountPaise });
    return { id: `rfnd_${++this.seq}`, payment_id: paymentId, amount: amountPaise, status: 'processed' };
  }
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('owner portal (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let razorpay: FakeRazorpay;
  let webhookSecret: string;
  let uploadDir: string;

  const RUN = `op-${Date.now()}`;
  const ownerId = `${RUN}-owner`;
  const otherOwnerId = `${RUN}-owner-2`;
  const playerId = `${RUN}-player`;
  const venueId = `${RUN}-venue`;
  const otherVenueId = `${RUN}-venue-2`;
  const resId = `${RUN}-res`;
  const res2Id = `${RUN}-res-2`;
  const otherResId = `${RUN}-other-res`;

  let ownerToken: string;
  let otherOwnerToken: string;
  let playerToken: string;

  // A far-future Wednesday: 09:00-13:00 IST, 60-minute slots, ₹1000 base.
  const DATE = '2031-06-04';
  const SLOT_09 = '2031-06-04T03:30:00.000Z';
  const SLOT_10 = '2031-06-04T04:30:00.000Z';
  const SLOT_11 = '2031-06-04T05:30:00.000Z';
  const DAY_START = '2031-06-03T18:30:00.000Z';
  const DAY_END = '2031-06-04T18:30:00.000Z';

  const venueData = (id: string, owner: string, resourceId: string, extra = {}) => ({
    id,
    ownerId: owner,
    name: `Owner Portal ${id}`,
    slug: id,
    addressLine: '1 Test Rd',
    city: `OpCity${RUN}`,
    state: 'MH',
    pincode: '411001',
    lat: 18.5,
    lng: 73.85,
    timezone: 'Asia/Kolkata',
    contactPhone: '+919000000041',
    status: 'ACTIVE' as const,
    commissionPct: 10,
    hours: { create: [{ weekday: 3, opensAt: 540, closesAt: 780 }] },
    resources: {
      create: [
        {
          id: resourceId,
          kind: 'TURF' as const,
          name: 'Pitch 1',
          attributes: { sport: 'football' },
          slotDurationMins: 60,
          basePricePaise: 100_000,
        },
      ],
    },
    ...extra,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RazorpayClient)
      .useFactory({
        factory: (config: ConfigService) => new FakeRazorpay(config as never),
        inject: [ConfigService],
      })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    razorpay = app.get(RazorpayClient) as FakeRazorpay;
    const config = app.get(ConfigService);
    webhookSecret = config.get('RAZORPAY_WEBHOOK_SECRET') as string;
    uploadDir = resolve(config.get('UPLOAD_DIR') as string);

    await prisma.user.createMany({
      data: [
        { id: ownerId, phone: `+9194${RUN.slice(-8)}1`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: otherOwnerId, phone: `+9194${RUN.slice(-8)}2`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: playerId, phone: `+9194${RUN.slice(-8)}3`, role: 'USER', preferredSports: [] },
      ],
    });
    ownerToken = (await tokens.issuePair(ownerId, 'VENUE_OWNER')).accessToken;
    otherOwnerToken = (await tokens.issuePair(otherOwnerId, 'VENUE_OWNER')).accessToken;
    playerToken = (await tokens.issuePair(playerId, 'USER')).accessToken;

    await prisma.venue.create({ data: venueData(venueId, ownerId, resId) });
    await prisma.resource.create({
      data: {
        id: res2Id,
        venueId,
        kind: 'TURF',
        name: 'Pitch 2',
        attributes: {},
        slotDurationMins: 60,
        basePricePaise: 100_000,
      },
    });
    await prisma.venue.create({ data: venueData(otherVenueId, otherOwnerId, otherResId) });
  });

  const resources = () => [resId, res2Id, otherResId];

  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { booking: { resourceId: { in: resources() } } } });
    await prisma.payment.deleteMany({ where: { booking: { resourceId: { in: resources() } } } });
    await prisma.booking.deleteMany({ where: { resourceId: { in: resources() } } });
    await prisma.blackout.deleteMany({ where: { resourceId: { in: resources() } } });
    await prisma.priceRule.deleteMany({ where: { resourceId: { in: resources() } } });
    await prisma.venue.update({ where: { id: venueId }, data: { advancePct: 100 } });
    await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: RUN } } });
  });

  afterAll(async () => {
    const owners = [ownerId, otherOwnerId];
    const ids = [...owners, playerId];
    await prisma.ledgerEntry.deleteMany({ where: { booking: { resourceId: { in: resources() } } } });
    await prisma.payment.deleteMany({ where: { booking: { resourceId: { in: resources() } } } });
    await prisma.booking.deleteMany({ where: { resourceId: { in: resources() } } });
    await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: RUN } } });
    await prisma.refreshSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.blackout.deleteMany({ where: { resourceId: { in: resources() } } });
    await prisma.priceRule.deleteMany({ where: { resourceId: { in: resources() } } });
    await prisma.operatingHours.deleteMany({ where: { venue: { ownerId: { in: owners } } } });
    await prisma.resource.deleteMany({ where: { venue: { ownerId: { in: owners } } } });
    await prisma.venue.deleteMany({ where: { ownerId: { in: owners } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await rm(join(uploadDir, `venue-${venueId}`), { recursive: true, force: true });
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('authorization', `Bearer ${token}`),
    post: (url: string) => http().post(url).set('authorization', `Bearer ${token}`),
    patch: (url: string) => http().patch(url).set('authorization', `Bearer ${token}`),
    delete: (url: string) => http().delete(url).set('authorization', `Bearer ${token}`),
  });
  const owner = () => as(ownerToken);

  const slotState = async (startsAt: string, resourceId = resId) => {
    const res = await http().get(`/api/v1/resources/${resourceId}/availability?date=${DATE}`).expect(200);
    return (res.body.slots as { startsAt: string; state: string; pricePaise: number }[]).find(
      (s) => s.startsAt === startsAt,
    )!;
  };

  const walkIn = (body: Record<string, unknown> = {}, resourceId = resId) =>
    owner()
      .post(`/api/v1/owner/resources/${resourceId}/bookings`)
      .send({ startsAt: SLOT_09, customerName: 'Walk-in Wally', ...body });

  describe('venue workspace', () => {
    it('returns full venue detail to its owner', async () => {
      const res = await owner().get(`/api/v1/owner/venues/${venueId}`).expect(200);
      expect(res.body.resources).toHaveLength(2);
      expect(res.body.hours).toHaveLength(1);
      expect(res.body.advancePct).toBe(100);
      expect(res.body.commissionPct).toBe(10);
    });

    it("refuses another owner's venue", async () => {
      await as(otherOwnerToken).get(`/api/v1/owner/venues/${venueId}`).expect(403);
    });

    it('refuses a player', async () => {
      await as(playerToken).get(`/api/v1/owner/venues/${venueId}`).expect(403);
    });
  });

  describe('price rules', () => {
    const rule = {
      name: 'Morning peak',
      weekdayMask: 0b1111111,
      startMin: 540,
      endMin: 600,
      pricePaise: 150_000,
      priority: 5,
    };

    it('creates a rule that availability prices from on the next request', async () => {
      const res = await owner().post(`/api/v1/owner/resources/${resId}/price-rules`).send(rule).expect(201);
      expect(res.body.id).toBeTruthy();

      expect((await slotState(SLOT_09)).pricePaise).toBe(150_000);
      expect((await slotState(SLOT_10)).pricePaise).toBe(100_000);
    });

    it('updates and deletes a rule', async () => {
      const { body } = await owner()
        .post(`/api/v1/owner/resources/${resId}/price-rules`)
        .send(rule)
        .expect(201);

      await owner().patch(`/api/v1/owner/price-rules/${body.id}`).send({ pricePaise: 80_000 }).expect(200);
      expect((await slotState(SLOT_09)).pricePaise).toBe(80_000);

      await owner().delete(`/api/v1/owner/price-rules/${body.id}`).expect(200);
      expect((await slotState(SLOT_09)).pricePaise).toBe(100_000);
    });

    it('rejects an inverted window, including one created by a partial update', async () => {
      await owner()
        .post(`/api/v1/owner/resources/${resId}/price-rules`)
        .send({ ...rule, startMin: 600, endMin: 540 })
        .expect(400);

      const { body } = await owner()
        .post(`/api/v1/owner/resources/${resId}/price-rules`)
        .send(rule)
        .expect(201);
      await owner().patch(`/api/v1/owner/price-rules/${body.id}`).send({ endMin: 500 }).expect(400);
    });

    it("cannot touch another owner's rule, and the rule is unchanged", async () => {
      const { body } = await owner()
        .post(`/api/v1/owner/resources/${resId}/price-rules`)
        .send(rule)
        .expect(201);

      await as(otherOwnerToken)
        .patch(`/api/v1/owner/price-rules/${body.id}`)
        .send({ pricePaise: 1 })
        .expect(403);
      await as(otherOwnerToken).delete(`/api/v1/owner/price-rules/${body.id}`).expect(403);

      const stored = await prisma.priceRule.findUnique({ where: { id: body.id } });
      expect(stored?.pricePaise).toBe(150_000);
    });
  });

  describe('closures', () => {
    it('closes every resource of the venue for a day', async () => {
      const res = await owner()
        .post(`/api/v1/owner/venues/${venueId}/closures`)
        .send({ startsAt: DAY_START, endsAt: DAY_END, reason: 'Diwali' })
        .expect(201);
      expect(res.body.resourcesClosed).toBe(2);

      expect((await slotState(SLOT_09, resId)).state).toBe('BLACKED_OUT');
      expect((await slotState(SLOT_09, res2Id)).state).toBe('BLACKED_OUT');

      const list = await owner().get(`/api/v1/owner/venues/${venueId}/blackouts?from=${DAY_START}`).expect(200);
      expect(list.body).toHaveLength(2);
    });

    it("cannot delete another venue's blackout by pairing it with an own resource id", async () => {
      const theirs = await prisma.blackout.create({
        data: {
          resourceId: otherResId,
          startsAt: new Date(DAY_START),
          endsAt: new Date(DAY_END),
          createdBy: otherOwnerId,
        },
      });

      await owner().delete(`/api/v1/owner/resources/${resId}/blackouts/${theirs.id}`).expect(404);
      expect(await prisma.blackout.findUnique({ where: { id: theirs.id } })).not.toBeNull();
    });
  });

  describe('walk-in bookings', () => {
    it('creates a confirmed walk-in that blocks the slot', async () => {
      const res = await walkIn({ customerPhone: '+919812345678', collectedPaise: 40_000 }).expect(201);

      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.source).toBe('WALK_IN');
      expect(res.body.amountPaise).toBe(100_000);
      expect(res.body.advancePaise).toBe(0);
      expect(res.body.balanceDuePaise).toBe(60_000);
      expect(res.body.holdsUntil).toBeNull();
      expect((await slotState(SLOT_09)).state).toBe('BOOKED');
    });

    it('rejects a slot that is already taken', async () => {
      await walkIn().expect(201);
      const res = await walkIn().expect(409);
      expect(res.body.error.code).toBe('SLOT_UNAVAILABLE');
    });

    it('a walk-in racing an app booking for one slot produces exactly one winner', async () => {
      const results = await Promise.all([
        walkIn(),
        as(playerToken).post('/api/v1/bookings').send({ resourceId: resId, startsAt: SLOT_09 }),
        walkIn(),
        as(playerToken).post('/api/v1/bookings').send({ resourceId: resId, startsAt: SLOT_09 }),
      ]);

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      const live = await prisma.booking.count({
        where: { resourceId: resId, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
      });
      expect(live).toBe(1);
    });

    it("is not allowed on another owner's resource", async () => {
      await walkIn({}, otherResId).expect(403);
    });

    it("does not show up in the owner's own My Bookings", async () => {
      await walkIn().expect(201);
      const res = await owner().get('/api/v1/bookings/me').expect(200);
      expect(res.body).toHaveLength(0);
    });

    it('records balance collected, refusing more than is due', async () => {
      const { body } = await walkIn().expect(201);

      const res = await owner()
        .post(`/api/v1/owner/bookings/${body.id}/collect-balance`)
        .send({ amountPaise: 100_000 })
        .expect(200);
      expect(res.body.balanceDuePaise).toBe(0);

      await owner()
        .post(`/api/v1/owner/bookings/${body.id}/collect-balance`)
        .send({ amountPaise: 1 })
        .expect(400);
    });
  });

  describe('listing and summary', () => {
    it('lists the venue bookings in a window with customer details', async () => {
      await walkIn().expect(201);
      await as(playerToken)
        .post('/api/v1/bookings')
        .send({ resourceId: resId, startsAt: SLOT_10 })
        .expect(201);

      const res = await owner()
        .get(`/api/v1/owner/venues/${venueId}/bookings?from=${DAY_START}&to=${DAY_END}`)
        .expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].customerName).toBe('Walk-in Wally');
      expect(res.body[1].user.id).toBe(playerId);
    });

    it("refuses another owner's booking list", async () => {
      await as(otherOwnerToken)
        .get(`/api/v1/owner/venues/${venueId}/bookings?from=${DAY_START}&to=${DAY_END}`)
        .expect(403);
    });

    it('rejects a window longer than 62 days', async () => {
      await owner()
        .get(`/api/v1/owner/venues/${venueId}/bookings?from=2031-01-01&to=2031-06-01`)
        .expect(400);
    });

    it('summarises booked value and money still due', async () => {
      await walkIn({ collectedPaise: 30_000 }).expect(201);
      await walkIn({ startsAt: SLOT_10 }).expect(201);

      const res = await owner()
        .get(`/api/v1/owner/venues/${venueId}/summary?from=${DAY_START}&to=${DAY_END}`)
        .expect(200);
      expect(res.body.counts.confirmed).toBe(2);
      expect(res.body.counts.walkIn).toBe(2);
      expect(res.body.bookedValuePaise).toBe(200_000);
      expect(res.body.balanceCollectedPaise).toBe(30_000);
      expect(res.body.balanceDuePaise).toBe(170_000);
    });
  });

  describe('advance payments', () => {
    const postWebhook = (event: string, payload: Record<string, unknown>, eventId: string) => {
      const raw = JSON.stringify({ event, payload });
      const signature = createHmac('sha256', webhookSecret).update(raw).digest('hex');
      return http()
        .post('/api/v1/payments/webhook')
        .set('content-type', 'application/json')
        .set('x-razorpay-event-id', eventId)
        .set('x-razorpay-signature', signature)
        .send(raw);
    };

    /** Books SLOT_11 at 30% advance and captures the advance via the webhook. */
    const paidAdvanceBooking = async () => {
      await prisma.venue.update({ where: { id: venueId }, data: { advancePct: 30 } });

      const booking = await as(playerToken)
        .post('/api/v1/bookings')
        .send({ resourceId: resId, startsAt: SLOT_11 })
        .expect(201);
      expect(booking.body.amountPaise).toBe(100_000);
      expect(booking.body.advancePaise).toBe(30_000);

      const order = await as(playerToken)
        .post('/api/v1/payments/order')
        .send({ bookingId: booking.body.id })
        .expect(200);
      expect(order.body.amountPaise).toBe(30_000);

      await postWebhook(
        'payment.captured',
        {
          payment: {
            entity: {
              id: `pay_${RUN}_${Date.now()}`,
              order_id: order.body.orderId,
              amount: 30_000,
              method: 'upi',
            },
          },
        },
        `${RUN}-cap-${Date.now()}`,
      ).expect(200);

      return booking.body.id as string;
    };

    it('charges only the advance online and takes commission on the full price', async () => {
      const bookingId = await paidAdvanceBooking();

      const stored = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(stored?.status).toBe('CONFIRMED');

      const ledger = await prisma.ledgerEntry.findMany({ where: { bookingId } });
      const sum = (account: string) =>
        ledger.filter((l) => l.account === account).reduce((s, l) => s + l.amountPaise, 0);
      expect(sum('PLATFORM_CASH')).toBe(30_000);
      // 10% of the full ₹1000, not of the ₹300 advance.
      expect(sum('COMMISSION')).toBe(10_000);
      expect(sum(`OWNER_PAYABLE:${venueId}`)).toBe(20_000);

      const listed = await owner()
        .get(`/api/v1/owner/venues/${venueId}/bookings?from=${DAY_START}&to=${DAY_END}`)
        .expect(200);
      expect(listed.body[0].balanceDuePaise).toBe(70_000);
    });

    it('owner cancel releases the slot and refunds nothing', async () => {
      const bookingId = await paidAdvanceBooking();
      razorpay.refunds.length = 0;

      const res = await owner()
        .post(`/api/v1/owner/bookings/${bookingId}/cancel`)
        .send({ reason: 'Pitch flooded' })
        .expect(200);

      expect(res.body.booking.status).toBe('CANCELLED');
      expect(res.body.refund).toMatchObject({ refundPaise: 0, tier: 'NONE_VENUE_CANCELLED' });
      expect(res.body.refundIssued).toBe(false);
      expect(razorpay.refunds).toHaveLength(0);
      expect((await slotState(SLOT_11)).state).toBe('AVAILABLE');
    });

    it("cannot cancel another owner's booking", async () => {
      const bookingId = await paidAdvanceBooking();
      await as(otherOwnerToken).post(`/api/v1/owner/bookings/${bookingId}/cancel`).send({}).expect(403);
      const stored = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(stored?.status).toBe('CONFIRMED');
    });

    it('a player cancellation refunds according to policy, on the advance only', async () => {
      const bookingId = await paidAdvanceBooking();
      razorpay.refunds.length = 0;

      const res = await as(playerToken)
        .post(`/api/v1/bookings/${bookingId}/cancel`)
        .send({})
        .expect(200);

      // Far-future slot → full-refund tier, of the ₹300 actually paid.
      expect(res.body.refund.refundPaise).toBe(30_000);
      expect(razorpay.refunds[0].amountPaise).toBe(30_000);

      const ledger = await prisma.ledgerEntry.findMany({ where: { bookingId } });
      const debits = ledger.filter((l) => l.direction === 'DEBIT').reduce((s, l) => s + l.amountPaise, 0);
      const credits = ledger.filter((l) => l.direction === 'CREDIT').reduce((s, l) => s + l.amountPaise, 0);
      expect(debits).toBe(credits);
    });
  });

  describe('photos', () => {
    it('uploads a PNG, serves nothing executable, and removes it', async () => {
      const res = await owner()
        .post(`/api/v1/owner/venues/${venueId}/photos`)
        .attach('file', PNG_1PX, { filename: 'pitch.png', contentType: 'image/png' })
        .expect(201);

      const url = res.body.photos.at(-1) as string;
      expect(url).toMatch(/\/uploads\/venue-.+\.png$/);
      const file = join(uploadDir, url.split('/uploads/')[1]);
      expect(existsSync(file)).toBe(true);

      await owner().delete(`/api/v1/owner/venues/${venueId}/photos`).send({ url }).expect(200);
      expect(existsSync(file)).toBe(false);
    });

    it('rejects a non-image whatever its declared type', async () => {
      const res = await owner()
        .post(`/api/v1/owner/venues/${venueId}/photos`)
        .attach('file', Buffer.from('<svg onload="alert(1)"/>'), {
          filename: 'x.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_UPLOAD');
    });

    it("refuses uploads to another owner's venue", async () => {
      await as(otherOwnerToken)
        .post(`/api/v1/owner/venues/${venueId}/photos`)
        .attach('file', PNG_1PX, { filename: 'pitch.png', contentType: 'image/png' })
        .expect(403);
    });
  });
});
