import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const createdPhones: string[] = [];

  // Unique per run so repeated runs never trip the per-phone hourly limit.
  let seq = 0;
  const nextPhone = () => {
    const phone = `+9199${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
    createdPhones.push(phone);
    return phone;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.otpChallenge.deleteMany({ where: { phone: { in: createdPhones } } });
    const users = await prisma.user.findMany({
      where: { phone: { in: createdPhones } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    await prisma.refreshSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function signIn(phone: string) {
    const req = await http()
      .post('/api/v1/auth/otp/request')
      .send({ phone })
      .expect(200);

    const res = await http()
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code: req.body.devCode })
      .expect(200);

    return res.body as {
      accessToken: string;
      refreshToken: string;
      user: { id: string };
    };
  }

  describe('otp', () => {
    it('rejects a phone number without a country code', async () => {
      const res = await http()
        .post('/api/v1/auth/otp/request')
        .send({ phone: '9876543210' })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('signs in a brand-new phone number, creating the user', async () => {
      const phone = nextPhone();
      const session = await signIn(phone);

      expect(session.accessToken).toBeTruthy();
      expect(session.refreshToken).toBeTruthy();
      expect(session.user.id).toBeTruthy();
    });

    it('rejects an incorrect code', async () => {
      const phone = nextPhone();
      const req = await http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const wrong = req.body.devCode === '000000' ? '111111' : '000000';

      const res = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ phone, code: wrong })
        .expect(401);

      expect(res.body.error.code).toBe('OTP_INVALID');
    });

    it('consumes the code, so it cannot be replayed', async () => {
      const phone = nextPhone();
      const req = await http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const code = req.body.devCode;

      await http().post('/api/v1/auth/otp/verify').send({ phone, code }).expect(200);

      const replay = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ phone, code })
        .expect(401);

      expect(replay.body.error.code).toBe('OTP_INVALID');
    });

    it('caps attempts, so a code cannot be brute-forced', async () => {
      const phone = nextPhone();
      const req = await http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const real = req.body.devCode;
      const wrong = real === '000000' ? '111111' : '000000';

      // Default OTP_MAX_ATTEMPTS is 5.
      for (let i = 0; i < 5; i++) {
        await http().post('/api/v1/auth/otp/verify').send({ phone, code: wrong }).expect(401);
      }

      const blocked = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ phone, code: wrong })
        .expect(401);
      expect(blocked.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');

      // Even the CORRECT code must now fail — the challenge was burned.
      const withReal = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ phone, code: real })
        .expect(401);
      expect(withReal.body.error.code).toBe('OTP_INVALID');
    });

    it('rate limits repeated requests for one phone', async () => {
      const phone = nextPhone();

      // Default OTP_MAX_REQUESTS_PER_HOUR is 3.
      for (let i = 0; i < 3; i++) {
        await http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      }

      const res = await http().post('/api/v1/auth/otp/request').send({ phone }).expect(429);
      expect(res.body.error.code).toBe('OTP_RATE_LIMITED');
    });
  });

  describe('guards', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await http().get('/api/v1/users/me').expect(401);
      expect(res.body.error.code).toBe('MISSING_TOKEN');
    });

    it('rejects a malformed token', async () => {
      const res = await http()
        .get('/api/v1/users/me')
        .set('authorization', 'Bearer not-a-jwt')
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });

    it('allows a valid token and returns the caller', async () => {
      const phone = nextPhone();
      const session = await signIn(phone);

      const res = await http()
        .get('/api/v1/users/me')
        .set('authorization', `Bearer ${session.accessToken}`)
        .expect(200);

      expect(res.body).toMatchObject({ id: session.user.id, phone, role: 'USER' });
    });

    it('leaves /health public for uptime monitors', async () => {
      await http().get('/health').expect(200);
    });
  });

  describe('refresh rotation', () => {
    it('issues a new pair and invalidates the old token', async () => {
      const session = await signIn(nextPhone());

      const rotated = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      expect(rotated.body.refreshToken).not.toBe(session.refreshToken);
      expect(rotated.body.accessToken).toBeTruthy();
    });

    it('revokes the whole family when a spent token is replayed', async () => {
      // Two parties holding one token is indistinguishable from theft, so
      // both are cut off rather than guessing which is legitimate.
      const session = await signIn(nextPhone());

      const rotated = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);

      const replay = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

      // The token the honest client is holding must die too.
      const afterBreach = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(401);
      expect(afterBreach.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('rejects an unknown refresh token', async () => {
      const res = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'totally-made-up' })
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('logout revokes only the presented session', async () => {
      const phone = nextPhone();
      const first = await signIn(phone);
      const second = await signIn(phone);

      await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: first.refreshToken })
        .expect(204);

      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);

      // The other device stays signed in.
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: second.refreshToken })
        .expect(200);
    });
  });
});
