import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { AppConfigService } from '../src/modules/app-config/app-config.service.js';

describe('admin + app config (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let appConfig: AppConfigService;

  const RUN = `ad-${Date.now()}`;
  const adminId = `${RUN}-admin`;
  const ownerId = `${RUN}-owner`;
  const playerId = `${RUN}-player`;
  const newOwnerEmail = `${RUN}@owner.test`;

  let adminToken: string;
  let ownerToken: string;
  let playerToken: string;
  let originalSettings: { key: string; value: unknown }[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    appConfig = app.get(AppConfigService);

    originalSettings = await prisma.appSetting.findMany({ select: { key: true, value: true } });

    await prisma.user.createMany({
      data: [
        { id: adminId, phone: `+9193${RUN.slice(-8)}1`, role: 'ADMIN', preferredSports: [] },
        { id: ownerId, phone: `+9193${RUN.slice(-8)}2`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: playerId, phone: `+9193${RUN.slice(-8)}3`, role: 'USER', preferredSports: [] },
      ],
    });
    adminToken = (await tokens.issuePair(adminId, 'ADMIN')).accessToken;
    ownerToken = (await tokens.issuePair(ownerId, 'VENUE_OWNER')).accessToken;
    playerToken = (await tokens.issuePair(playerId, 'USER')).accessToken;
  });

  /** Restores app settings exactly as they were, and drops the 15s cache. */
  const restoreSettings = async () => {
    await prisma.appSetting.deleteMany({});
    for (const s of originalSettings) {
      await prisma.appSetting.create({ data: { key: s.key, value: s.value as never } });
    }
    (appConfig as unknown as { cache: unknown }).cache = null;
  };

  afterEach(restoreSettings);

  afterAll(async () => {
    const createdOwner = await prisma.user.findUnique({ where: { email: newOwnerEmail } });
    const users = [adminId, ownerId, playerId, ...(createdOwner ? [createdOwner.id] : [])];

    await prisma.operatingHours.deleteMany({ where: { venue: { ownerId: { in: users } } } });
    await prisma.resource.deleteMany({ where: { venue: { ownerId: { in: users } } } });
    await prisma.venue.deleteMany({ where: { ownerId: { in: users } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.loginAttempt.deleteMany({ where: { identifier: newOwnerEmail } });
    await prisma.refreshSession.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await restoreSettings();
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('authorization', `Bearer ${token}`),
    post: (url: string) => http().post(url).set('authorization', `Bearer ${token}`),
    patch: (url: string) => http().patch(url).set('authorization', `Bearer ${token}`),
    put: (url: string) => http().put(url).set('authorization', `Bearer ${token}`),
  });
  const admin = () => as(adminToken);

  const venueBody = {
    name: `Admin Test Venue ${RUN}`,
    addressLine: '1 Admin Rd',
    city: `AdCity${RUN}`,
    state: 'MH',
    pincode: '411001',
    lat: 18.5,
    lng: 73.85,
    contactPhone: '+919000000051',
  };

  describe('access', () => {
    it('refuses owners and players', async () => {
      await as(ownerToken).get('/api/v1/admin/users').expect(403);
      await as(playerToken).get('/api/v1/admin/venues').expect(403);
      await as(playerToken).put('/api/v1/admin/config').send({}).expect(403);
    });
  });

  describe('owner onboarding', () => {
    it('creates an owner who can log in and create a pending venue that admin approves', async () => {
      const created = await admin()
        .post('/api/v1/admin/owners')
        .send({ name: 'New Owner', email: newOwnerEmail, tempPassword: 'Temp-pass-123' })
        .expect(201);
      expect(created.body.role).toBe('VENUE_OWNER');
      expect(created.body).not.toHaveProperty('passwordHash');

      const login = await http()
        .post('/api/v1/auth/email/login')
        .send({ email: newOwnerEmail, password: 'Temp-pass-123' })
        .expect(200);
      expect(login.body.user.role).toBe('VENUE_OWNER');

      const venue = await as(login.body.accessToken)
        .post('/api/v1/owner/venues')
        .send(venueBody)
        .expect(201);
      expect(venue.body.status).toBe('PENDING_APPROVAL');
      // Public search lists venues by their bookable resources.
      await as(login.body.accessToken)
        .post(`/api/v1/owner/venues/${venue.body.id}/resources`)
        .send({ kind: 'TURF', name: 'Pitch 1', basePricePaise: 100_000 })
        .expect(201);

      // Not publicly listed until approved.
      const before = await http().get(`/api/v1/venues?city=${venueBody.city}`).expect(200);
      expect(before.body.items ?? before.body.data ?? before.body).toHaveLength(0);

      await admin()
        .patch(`/api/v1/admin/venues/${venue.body.id}`)
        .send({ status: 'ACTIVE', advancePct: 25 })
        .expect(200);

      const after = await http().get(`/api/v1/venues?city=${venueBody.city}`).expect(200);
      expect(after.body.items ?? after.body.data ?? after.body).toHaveLength(1);

      const audit = await prisma.auditLog.findFirst({
        where: { entityId: venue.body.id, action: 'venue.update' },
      });
      expect(audit?.actorId).toBe(adminId);
    });

    it('refuses a duplicate email', async () => {
      await admin()
        .post('/api/v1/admin/owners')
        .send({ name: 'Dup', email: newOwnerEmail, tempPassword: 'Temp-pass-123' })
        .expect(409);
    });
  });

  describe('users', () => {
    it('blocking revokes refresh sessions', async () => {
      const pair = await tokens.issuePair(playerId, 'USER');

      await admin().patch(`/api/v1/admin/users/${playerId}`).send({ isBlocked: true }).expect(200);

      await http().post('/api/v1/auth/refresh').send({ refreshToken: pair.refreshToken }).expect(401);
      await admin().patch(`/api/v1/admin/users/${playerId}`).send({ isBlocked: false }).expect(200);
    });

    it('cannot promote anyone to ADMIN or modify itself', async () => {
      await admin().patch(`/api/v1/admin/users/${playerId}`).send({ role: 'ADMIN' }).expect(400);
      await admin().patch(`/api/v1/admin/users/${adminId}`).send({ isBlocked: true }).expect(400);
    });
  });

  describe('app config', () => {
    it('is readable without signing in', async () => {
      const res = await http().get('/api/v1/config/app').expect(200);
      expect(res.body.versions.android.min).toMatch(/^\d+\.\d+\.\d+$/);
      expect(res.body.maintenance).toHaveProperty('enabled');
    });

    it('rejects a min version newer than latest', async () => {
      await admin()
        .put('/api/v1/admin/config')
        .send({
          versions: {
            ios: { min: '2.0.0', latest: '1.0.0', storeUrl: '' },
            android: { min: '1.0.0', latest: '1.0.0', storeUrl: '' },
          },
        })
        .expect(400);
    });

    it('stores per-platform update switches and defaults them for legacy rows', async () => {
      await admin()
        .put('/api/v1/admin/config')
        .send({
          versions: {
            ios: { min: '1.0.0', latest: '1.2.0', storeUrl: '', forceUpdate: false, promptEnabled: true, message: 'New!' },
            android: { min: '1.0.0', latest: '1.0.0', storeUrl: '' },
          },
        })
        .expect(200);
      const res = await http().get('/api/v1/config/app').expect(200);
      expect(res.body.versions.ios).toMatchObject({ forceUpdate: false, promptEnabled: true, message: 'New!' });
      // Omitted fields default to the pre-existing behaviour: enforce min, show popup.
      expect(res.body.versions.android).toMatchObject({ forceUpdate: true, promptEnabled: true, message: '' });
    });

    it('updates feature flags', async () => {
      await admin().put('/api/v1/admin/config').send({ features: { arcade: false } }).expect(200);
      const res = await http().get('/api/v1/config/app').expect(200);
      expect(res.body.features).toEqual({ arcade: false });
    });

    it('refuses app builds below min with 426 when forceUpdate is on', async () => {
      const rule = { min: '1.5.0', latest: '1.5.0', storeUrl: '', forceUpdate: true, promptEnabled: true, message: 'Please update' };
      await admin()
        .put('/api/v1/admin/config')
        .send({ versions: { ios: rule, android: { ...rule, forceUpdate: false } } })
        .expect(200);

      const app = (platform: string, version: string) =>
        http().get('/api/v1/venues').set('x-app-platform', platform).set('x-app-version', version);

      const blocked = await app('ios', '1.4.9').expect(426);
      expect(blocked.body.error).toMatchObject({
        code: 'UPGRADE_REQUIRED',
        message: 'Please update',
        details: { min: '1.5.0' },
      });
      await app('ios', '1.10.0').expect(200); // numeric, not lexical, comparison
      await app('ios', '1.5.0').expect(200);
      await app('android', '1.0.0').expect(200); // android forceUpdate is off
      await http().get('/api/v1/venues').expect(200); // no headers (portal, MCP): never blocked
      await app('ios', 'garbage').expect(200); // malformed: fail open

      // An outdated build can still read config and sign in, and admins are never blocked.
      await http().get('/api/v1/config/app').set('x-app-platform', 'ios').set('x-app-version', '1.0.0').expect(200);
      await as(adminToken).get('/api/v1/admin/users').set('x-app-platform', 'ios').set('x-app-version', '1.0.0').expect(200);
    });

    it('maintenance blocks the app but not health, config, auth, webhooks or admins', async () => {
      await admin()
        .put('/api/v1/admin/config')
        .send({ maintenance: { enabled: true, message: 'Back at 6pm' } })
        .expect(200);

      const blocked = await as(playerToken).get('/api/v1/bookings/me').expect(503);
      expect(blocked.body.error).toMatchObject({ code: 'MAINTENANCE', message: 'Back at 6pm' });
      await http().get('/api/v1/venues').expect(503);

      await http().get('/health').expect((r) => expect(r.status).not.toBe(503));
      await http().get('/api/v1/config/app').expect(200);
      await http()
        .post('/api/v1/auth/email/login')
        .send({ email: 'nobody@x.test', password: 'x' })
        .expect(401);
      // Unsigned, so 4xx — but it got past maintenance to the signature check.
      await http()
        .post('/api/v1/payments/webhook')
        .send({})
        .expect((r) => expect(r.status).not.toBe(503));
      await admin().get('/api/v1/admin/users').expect(200);
    });
  });
});
