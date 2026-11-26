import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import {
  PushProvider,
  type PushPayload,
  type PushTicket,
} from '../src/modules/notifications/push.provider.js';

/** Records what would have gone to Expo; never touches the network. */
class FakePush extends PushProvider {
  readonly batchSize = 2; // tiny, so multi-batch delivery is exercised
  payloads: PushPayload[] = [];
  dead = new Set<string>();

  override async send(payloads: PushPayload[]): Promise<PushTicket[]> {
    this.payloads.push(...payloads);
    return payloads.map((p) =>
      this.dead.has(p.to) ? { ok: false, error: 'DeviceNotRegistered' } : { ok: true },
    );
  }
}

describe('push notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  const push = new FakePush();

  const RUN = `pn-${Date.now()}`;
  const id = (s: string) => `${RUN}-${s}`;
  const tok = (s: string) => `ExponentPushToken[${RUN}-${s}]`;
  const phone = (n: number) => `+9192${RUN.slice(-8)}${n}`;

  const adminId = id('admin');
  const ownerAId = id('ownerA');
  const ownerBId = id('ownerB');
  const [p1, p2, p3, p4, p5] = ['p1', 'p2', 'p3', 'p4', 'p5'].map(id);
  const venueA = id('venueA');
  const venueB = id('venueB');
  const resA = id('resA');
  const resB = id('resB');
  const userIds = [adminId, ownerAId, ownerBId, p1, p2, p3, p4, p5];

  let adminToken: string;
  let ownerAToken: string;
  let ownerBToken: string;
  let p1Token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PushProvider)
      .useValue(push)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    const u = (uid: string, n: number, role: 'USER' | 'ADMIN' | 'VENUE_OWNER', extra = {}) => ({
      id: uid,
      phone: phone(n),
      role,
      preferredSports: [] as string[],
      ...extra,
    });
    await prisma.user.createMany({
      data: [
        u(adminId, 1, 'ADMIN'),
        u(ownerAId, 2, 'VENUE_OWNER'),
        u(ownerBId, 3, 'VENUE_OWNER'),
        u(p1, 4, 'USER', { name: 'Alice' }),
        u(p2, 5, 'USER', { name: 'Bob' }),
        u(p3, 6, 'USER', { name: 'Cara' }),
        u(p4, 7, 'USER', { name: 'Dan', city: `Seg${RUN}`, preferredSports: [`sport-${RUN}`] }),
        u(p5, 8, 'USER', { name: 'Eve', isBlocked: true }),
      ],
    });

    const venue = (vid: string, owner: string, rid: string) => ({
      id: vid,
      ownerId: owner,
      name: `Push ${vid}`,
      slug: vid,
      addressLine: '1 Push Rd',
      city: 'PushCity',
      state: 'MH',
      pincode: '411001',
      lat: 18.5,
      lng: 73.85,
      contactPhone: '+919000000051',
      status: 'ACTIVE' as const,
      resources: {
        create: [{ id: rid, kind: 'TURF' as const, name: 'P', slotDurationMins: 60, basePricePaise: 100_000 }],
      },
    });
    await prisma.venue.create({ data: venue(venueA, ownerAId, resA) });
    await prisma.venue.create({ data: venue(venueB, ownerBId, resB) });

    // Devices: p1, p3, p4, p5 (blocked) have one; p2 has none.
    await prisma.device.createMany({
      data: [p1, p3, p4, p5].map((uid) => ({
        userId: uid,
        expoPushToken: tok(uid.slice(RUN.length + 1)),
        platform: 'android',
      })),
    });

    // Slots on distinct hours so the exclusion constraint never trips.
    const booking = (n: number, userId: string, resourceId: string, status: string, source = 'APP') => ({
      bookingCode: `PN-${RUN.slice(-6)}-${n}`,
      userId,
      resourceId,
      startsAt: new Date(Date.UTC(2032, 0, 1, n)),
      endsAt: new Date(Date.UTC(2032, 0, 1, n + 1)),
      status: status as never,
      source: source as never,
      amountPaise: 100_000,
      advancePaise: source === 'APP' ? 100_000 : 0,
    });
    await prisma.booking.createMany({
      data: [
        booking(1, p1, resA, 'CONFIRMED'),
        booking(2, p2, resA, 'COMPLETED'),
        booking(3, p5, resA, 'CONFIRMED'),
        booking(4, p4, resA, 'PENDING_PAYMENT'), // never completed checkout → not a customer
        booking(5, ownerAId, resA, 'CONFIRMED', 'WALK_IN'), // walk-in stored under the owner
        booking(6, p3, resB, 'CONFIRMED'),
      ],
    });

    adminToken = (await tokens.issuePair(adminId, 'ADMIN')).accessToken;
    ownerAToken = (await tokens.issuePair(ownerAId, 'VENUE_OWNER')).accessToken;
    ownerBToken = (await tokens.issuePair(ownerBId, 'VENUE_OWNER')).accessToken;
    p1Token = (await tokens.issuePair(p1, 'USER')).accessToken;
  });

  beforeEach(() => {
    push.payloads = [];
    push.dead.clear();
  });

  afterAll(async () => {
    await prisma.pushMessage.deleteMany({ where: { senderId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.device.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.booking.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.resource.deleteMany({ where: { venueId: { in: [venueA, venueB] } } });
    await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } });
    await prisma.refreshSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('authorization', `Bearer ${token}`),
    post: (url: string) => http().post(url).set('authorization', `Bearer ${token}`),
    put: (url: string) => http().put(url).set('authorization', `Bearer ${token}`),
  });

  /** Delivery runs after the response — wait for the row to leave QUEUED/SENDING. */
  const settled = async (messageId: string) => {
    for (let i = 0; i < 100; i++) {
      const m = await prisma.pushMessage.findUniqueOrThrow({ where: { id: messageId } });
      if (m.status === 'SENT' || m.status === 'FAILED') return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('push message never settled');
  };
  /** Only tokens belonging to this run's fixtures. */
  const delivered = () => push.payloads.map((p) => p.to).filter((t) => t.includes(RUN)).sort();

  describe('devices', () => {
    it('requires auth and a well-formed Expo token', async () => {
      await http().put('/api/v1/devices').send({ expoPushToken: tok('x'), platform: 'ios' }).expect(401);
      await as(p1Token).put('/api/v1/devices').send({ expoPushToken: 'nope', platform: 'ios' }).expect(400);
      await as(p1Token).put('/api/v1/devices').send({ expoPushToken: tok('x'), platform: 'web' }).expect(400);
    });

    it('moves a token to whoever signed in last, and unregister is scoped to the caller', async () => {
      const token = tok('shared');
      await as(p1Token).put('/api/v1/devices').send({ expoPushToken: token, platform: 'ios' }).expect(200);
      expect((await prisma.device.findUniqueOrThrow({ where: { expoPushToken: token } })).userId).toBe(p1);

      const ownerToken = (await tokens.issuePair(ownerAId, 'VENUE_OWNER')).accessToken;
      await as(ownerToken).put('/api/v1/devices').send({ expoPushToken: token, platform: 'ios' }).expect(200);
      expect((await prisma.device.findUniqueOrThrow({ where: { expoPushToken: token } })).userId).toBe(ownerAId);

      // p1 no longer owns it, so they cannot remove it.
      await as(p1Token).post('/api/v1/devices/unregister').send({ expoPushToken: token }).expect(200);
      expect(await prisma.device.count({ where: { expoPushToken: token } })).toBe(1);

      await as(ownerToken).post('/api/v1/devices/unregister').send({ expoPushToken: token }).expect(200);
      expect(await prisma.device.count({ where: { expoPushToken: token } })).toBe(0);
    });
  });

  describe('owner → own customers', () => {
    it('lists only completed-checkout app customers of that venue', async () => {
      const res = await as(ownerAToken).get(`/api/v1/owner/venues/${venueA}/customers`).expect(200);
      const byId = Object.fromEntries((res.body as { id: string }[]).map((c) => [c.id, c]));
      expect(Object.keys(byId).sort()).toEqual([p1, p2, p5].sort());
      expect(byId[p1].reachable).toBe(true);
      expect(byId[p2].reachable).toBe(false); // no device
      expect(byId[p5].reachable).toBe(false); // blocked
      expect(byId[p1].bookingCount).toBe(1);
    });

    it('ALL_CUSTOMERS reaches only reachable customers of the venue', async () => {
      const body = { title: 'Weekend offer', body: '20% off Saturday slots', audience: { type: 'ALL_CUSTOMERS' } };

      const preview = await as(ownerAToken)
        .post(`/api/v1/owner/venues/${venueA}/notifications/preview`)
        .send({ audience: body.audience })
        .expect(200);
      expect(preview.body).toEqual({ recipients: 2, devices: 1 }); // p1, p2 — blocked p5 is out

      const sent = await as(ownerAToken).post(`/api/v1/owner/venues/${venueA}/notifications`).send(body).expect(201);
      expect(sent.body).toMatchObject({ venueId: venueA, senderId: ownerAId, recipientCount: 2, deviceCount: 1 });

      const done = await settled(sent.body.id);
      expect(done).toMatchObject({ status: 'SENT', sentCount: 1, failedCount: 0 });
      expect(delivered()).toEqual([tok('p1')]);
      expect(push.payloads[0]).toMatchObject({ title: 'Weekend offer', body: '20% off Saturday slots' });
    });

    it('USERS targets a chosen customer', async () => {
      const sent = await as(ownerAToken)
        .post(`/api/v1/owner/venues/${venueA}/notifications`)
        .send({ title: 'Hi', body: 'Your gear is at the desk', audience: { type: 'USERS', userIds: [p1] } })
        .expect(201);
      await settled(sent.body.id);
      expect(delivered()).toEqual([tok('p1')]);
    });

    it("rejects a user who is not this venue's customer, with nothing sent or logged", async () => {
      for (const target of [p3 /* other venue */, p4 /* only a pending hold */, ownerAId, id('ghost')]) {
        const res = await as(ownerAToken)
          .post(`/api/v1/owner/venues/${venueA}/notifications`)
          .send({ title: 'x', body: 'y', audience: { type: 'USERS', userIds: [p1, target] } })
          .expect(400);
        expect(res.body.error.code).toBe('AUDIENCE_OUT_OF_SCOPE');
      }
      expect(push.payloads).toHaveLength(0);
      expect(await prisma.pushMessage.count({ where: { senderId: ownerAId, audience: { path: ['userIds'], array_contains: [p3] } } })).toBe(0);
    });

    it("blocks another owner, players, and an owner using an admin-only audience", async () => {
      const body = { title: 'x', body: 'y', audience: { type: 'ALL_CUSTOMERS' } };
      await as(ownerBToken).post(`/api/v1/owner/venues/${venueA}/notifications`).send(body).expect(403);
      await as(ownerBToken).get(`/api/v1/owner/venues/${venueA}/customers`).expect(403);
      await as(ownerBToken).get(`/api/v1/owner/venues/${venueA}/notifications`).expect(403);
      await as(p1Token).post(`/api/v1/owner/venues/${venueA}/notifications`).send(body).expect(403);
      // Venue-owner schema has no ALL / SEGMENT audiences.
      await as(ownerAToken)
        .post(`/api/v1/owner/venues/${venueA}/notifications`)
        .send({ title: 'x', body: 'y', audience: { type: 'ALL' } })
        .expect(400);
      await as(ownerAToken).post('/api/v1/admin/notifications').send({ title: 'x', body: 'y', audience: { type: 'ALL' } }).expect(403);
    });

    it('validates title and body', async () => {
      const audience = { type: 'ALL_CUSTOMERS' };
      const url = `/api/v1/owner/venues/${venueA}/notifications`;
      await as(ownerAToken).post(url).send({ title: '', body: 'y', audience }).expect(400);
      await as(ownerAToken).post(url).send({ title: 'x'.repeat(66), body: 'y', audience }).expect(400);
      await as(ownerAToken).post(url).send({ title: 'x', body: 'y'.repeat(241), audience }).expect(400);
    });

    it('shows history for the venue only', async () => {
      const a = await as(ownerAToken).get(`/api/v1/owner/venues/${venueA}/notifications`).expect(200);
      expect((a.body as { venueId: string }[]).length).toBeGreaterThan(0);
      expect((a.body as { venueId: string }[]).every((m) => m.venueId === venueA)).toBe(true);
    });

    it('rate limits owner sends per venue, but not admin', async () => {
      const limit = 5;
      await prisma.pushMessage.createMany({
        data: Array.from({ length: limit }, () => ({
          senderId: ownerBId,
          senderRole: 'VENUE_OWNER',
          venueId: venueB,
          title: 't',
          body: 'b',
          audience: { type: 'ALL_CUSTOMERS' },
          status: 'SENT' as const,
        })),
      });
      const body = { title: 'x', body: 'y', audience: { type: 'ALL_CUSTOMERS' } };
      const res = await as(ownerBToken).post(`/api/v1/owner/venues/${venueB}/notifications`).send(body).expect(429);
      expect(res.body.error.code).toBe('PUSH_RATE_LIMITED');

      // Admin acting on that venue is exempt.
      const ok = await as(adminToken).post(`/api/v1/owner/venues/${venueB}/notifications`).send(body).expect(201);
      await settled(ok.body.id);
    });
  });

  describe('admin', () => {
    const send = (audience: unknown) =>
      as(adminToken).post('/api/v1/admin/notifications').send({ title: 'Platform', body: 'News', audience });

    it('USERS: specific people, across venues', async () => {
      const res = await send({ type: 'USERS', userIds: [p1, p3] }).expect(201);
      await settled(res.body.id);
      expect(delivered()).toEqual([tok('p1'), tok('p3')]);
    });

    it('USERS: unknown id is a 400', async () => {
      const res = await send({ type: 'USERS', userIds: [p1, id('ghost')] }).expect(400);
      expect(res.body.error.code).toBe('AUDIENCE_OUT_OF_SCOPE');
    });

    it('ALL: every reachable player, never blocked users, owners or admins', async () => {
      const res = await send({ type: 'ALL' }).expect(201);
      await settled(res.body.id);
      expect(delivered()).toEqual([tok('p1'), tok('p3'), tok('p4')]); // p5 blocked, p2 no device
    });

    it("VENUE_CUSTOMERS: one venue's customers", async () => {
      const res = await send({ type: 'VENUE_CUSTOMERS', venueId: venueB }).expect(201);
      expect(res.body.venueId).toBe(venueB);
      await settled(res.body.id);
      expect(delivered()).toEqual([tok('p3')]);

      await send({ type: 'VENUE_CUSTOMERS', venueId: id('nope') }).expect(404);
    });

    it('SEGMENT: by city and by sport, case-insensitively', async () => {
      const byCity = await send({ type: 'SEGMENT', city: `seg${RUN}`.toLowerCase() }).expect(201);
      await settled(byCity.body.id);
      expect(delivered()).toEqual([tok('p4')]);

      push.payloads = [];
      const bySport = await send({ type: 'SEGMENT', sports: [`sport-${RUN}`] }).expect(201);
      await settled(bySport.body.id);
      expect(delivered()).toEqual([tok('p4')]);

      await send({ type: 'SEGMENT' }).expect(400);
    });

    it('previews reach without sending', async () => {
      const res = await as(adminToken)
        .post('/api/v1/admin/notifications/preview')
        .send({ audience: { type: 'USERS', userIds: [p1, p2] } })
        .expect(200);
      expect(res.body).toEqual({ recipients: 2, devices: 1 });
      expect(push.payloads).toHaveLength(0);
    });

    it('drops dead tokens Expo reports and marks an all-failed message FAILED', async () => {
      push.dead.add(tok('p1'));
      const res = await send({ type: 'USERS', userIds: [p1] }).expect(201);
      expect(await settled(res.body.id)).toMatchObject({ status: 'FAILED', sentCount: 0, failedCount: 1 });
      expect(await prisma.device.count({ where: { expoPushToken: tok('p1') } })).toBe(0);
      // Restore for later assertions.
      await prisma.device.create({ data: { userId: p1, expoPushToken: tok('p1'), platform: 'android' } });
    });

    it('with nobody reachable, still logs the message as SENT with zero deliveries', async () => {
      const res = await send({ type: 'USERS', userIds: [p2] }).expect(201);
      expect(res.body).toMatchObject({ status: 'SENT', deviceCount: 0, sentCount: 0 });
      expect(push.payloads).toHaveLength(0);
    });

    it('batches deliveries and writes an audit row', async () => {
      const res = await send({ type: 'USERS', userIds: [p1, p3, p4] }).expect(201); // 3 devices, batch size 2
      expect(await settled(res.body.id)).toMatchObject({ status: 'SENT', sentCount: 3 });
      expect(
        await prisma.auditLog.count({
          where: { actorId: adminId, action: 'notification.send', entityId: res.body.id },
        }),
      ).toBe(1);
    });

    it('lists history', async () => {
      const res = await as(adminToken).get('/api/v1/admin/notifications?limit=5').expect(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.length).toBeLessThanOrEqual(5);
    });
  });
});
