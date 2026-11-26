import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import {
  GoogleTokenVerifier,
  type GoogleProfile,
} from '../src/modules/auth/google-token-verifier.service.js';
import { GoogleTokenInvalidException } from '../src/common/errors/domain.errors.js';

/** Only "valid-token"/"other-valid-token" verify; anything else throws, same
 * as the real verifier does for a malformed/expired/forged token. */
class FakeGoogleTokenVerifier extends GoogleTokenVerifier {
  private readonly tokens: Record<string, GoogleProfile> = {};

  setToken(idToken: string, profile: GoogleProfile) {
    this.tokens[idToken] = profile;
  }

  override async verify(idToken: string): Promise<GoogleProfile> {
    const profile = this.tokens[idToken];
    if (!profile) throw new GoogleTokenInvalidException();
    return profile;
  }
}

describe('auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let googleVerifier: FakeGoogleTokenVerifier;
  const createdPhones: string[] = [];
  const createdEmails: string[] = [];

  // Unique per run so repeated runs never trip the per-phone hourly limit.
  let seq = 0;
  const nextPhone = () => {
    const phone = `+9199${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
    createdPhones.push(phone);
    return phone;
  };
  const nextEmail = () => {
    const email = `auth-e2e-${Date.now()}-${seq++}@example.com`;
    createdEmails.push(email);
    return email;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleTokenVerifier)
      .useFactory({
        factory: (config: ConfigService) => new FakeGoogleTokenVerifier(config as never),
        inject: [ConfigService],
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
    googleVerifier = app.get(GoogleTokenVerifier) as FakeGoogleTokenVerifier;
  });

  afterAll(async () => {
    await prisma.otpChallenge.deleteMany({
      where: { identifier: { in: [...createdPhones, ...createdEmails] } },
    });
    const users = await prisma.user.findMany({
      where: { OR: [{ phone: { in: createdPhones } }, { email: { in: createdEmails } }] },
      select: { id: true, email: true },
    });
    const ids = users.map((u) => u.id);
    await prisma.loginAttempt.deleteMany({ where: { identifier: { in: createdEmails } } });
    await prisma.socialIdentity.deleteMany({ where: { userId: { in: ids } } });
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
    it('rate limits one IP spraying requests across many phones', async () => {
      // Default OTP_MAX_REQUESTS_PER_HOUR_PER_IP is 20 — every request in this
      // file comes from the same loopback address via supertest, so this runs
      // FIRST, before any other test's otp/request calls share the quota, and
      // cleans up its own rows immediately after so later tests start fresh.
      const phonesUsed: string[] = [];
      for (let i = 0; i < 20; i++) {
        const phone = nextPhone();
        phonesUsed.push(phone);
        await http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      }

      const blockedPhone = nextPhone();
      phonesUsed.push(blockedPhone);
      const res = await http()
        .post('/api/v1/auth/otp/request')
        .send({ phone: blockedPhone })
        .expect(429);
      expect(res.body.error.code).toBe('OTP_RATE_LIMITED');

      await prisma.otpChallenge.deleteMany({ where: { identifier: { in: phonesUsed } } });
    });

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

  describe('email', () => {
    it('registers a new account and returns a session with the email set', async () => {
      const email = nextEmail();
      const res = await http()
        .post('/api/v1/auth/email/register')
        .send({ email, password: 'correcthorse1', name: 'Test User' })
        .expect(201);

      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.user.email).toBe(email);
    });

    it('rejects a duplicate email registration', async () => {
      const email = nextEmail();
      await http()
        .post('/api/v1/auth/email/register')
        .send({ email, password: 'correcthorse1' })
        .expect(201);

      const res = await http()
        .post('/api/v1/auth/email/register')
        .send({ email, password: 'correcthorse2' })
        .expect(409);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('rejects a weak password', async () => {
      const res = await http()
        .post('/api/v1/auth/email/register')
        .send({ email: nextEmail(), password: 'short1' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('logs in with the correct password', async () => {
      const email = nextEmail();
      await http()
        .post('/api/v1/auth/email/register')
        .send({ email, password: 'correcthorse1' })
        .expect(201);

      const res = await http()
        .post('/api/v1/auth/email/login')
        .send({ email, password: 'correcthorse1' })
        .expect(200);
      expect(res.body.accessToken).toBeTruthy();
    });

    it('gives an identical error for a wrong password and for an unknown email', async () => {
      const email = nextEmail();
      await http()
        .post('/api/v1/auth/email/register')
        .send({ email, password: 'correcthorse1' })
        .expect(201);

      const wrongPassword = await http()
        .post('/api/v1/auth/email/login')
        .send({ email, password: 'totally-wrong-1' })
        .expect(401);

      const unknownEmail = await http()
        .post('/api/v1/auth/email/login')
        .send({ email: nextEmail(), password: 'totally-wrong-1' })
        .expect(401);

      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknownEmail.body.error.code).toBe(wrongPassword.body.error.code);
      expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
    });

    it('rate limits repeated failed login attempts', async () => {
      const email = nextEmail();
      await http()
        .post('/api/v1/auth/email/register')
        .send({ email, password: 'correcthorse1' })
        .expect(201);

      // Default LOGIN_MAX_ATTEMPTS_PER_HOUR is 10.
      for (let i = 0; i < 10; i++) {
        await http()
          .post('/api/v1/auth/email/login')
          .send({ email, password: 'totally-wrong-1' })
          .expect(401);
      }

      const res = await http()
        .post('/api/v1/auth/email/login')
        .send({ email, password: 'totally-wrong-1' })
        .expect(429);
      expect(res.body.error.code).toBe('LOGIN_RATE_LIMITED');
    });

    it('refreshes and logs out an email-based session like any other', async () => {
      const email = nextEmail();
      await http()
        .post('/api/v1/auth/email/register')
        .send({ email, password: 'correcthorse1' })
        .expect(201);

      const session = await http()
        .post('/api/v1/auth/email/login')
        .send({ email, password: 'correcthorse1' })
        .expect(200);

      const rotated = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.body.refreshToken })
        .expect(200);
      expect(rotated.body.refreshToken).not.toBe(session.body.refreshToken);

      await http()
        .post('/api/v1/auth/logout')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(204);
    });
  });

  describe('code sign-in, then password', () => {
    // Every request shares one loopback IP, so the per-IP OTP quota (20/hour)
    // is shared across the whole file; free it between tests.
    afterEach(async () => {
      await prisma.otpChallenge.deleteMany({
        where: { identifier: { in: [...createdPhones, ...createdEmails] } },
      });
    });

    async function otpSignIn(identity: { phone: string } | { email: string }) {
      const req = await http().post('/api/v1/auth/otp/request').send(identity).expect(200);
      const res = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ ...identity, code: req.body.devCode })
        .expect(200);
      return res.body as {
        accessToken: string;
        refreshToken: string;
        user: { id: string; email: string | null; phone: string | null; hasPassword: boolean };
      };
    }

    it('rejects a body with both phone and email, or neither', async () => {
      const both = await http()
        .post('/api/v1/auth/otp/request')
        .send({ phone: nextPhone(), email: nextEmail() })
        .expect(400);
      expect(both.body.error.code).toBe('VALIDATION_FAILED');
      await http().post('/api/v1/auth/otp/request').send({}).expect(400);
    });

    it('signs in a brand-new email with a code, creating the user without a password', async () => {
      const email = nextEmail();
      const session = await otpSignIn({ email });
      expect(session.user.email).toBe(email);
      expect(session.user.hasPassword).toBe(false);
    });

    it('lets a code-signed-in user create a password once, then sign in with it by email', async () => {
      const email = nextEmail();
      const session = await otpSignIn({ email });

      await http()
        .post('/api/v1/auth/password/set')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ password: 'correcthorse1' })
        .expect(200);

      const login = await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'correcthorse1' })
        .expect(200);
      expect(login.body.user.id).toBe(session.user.id);
      expect(login.body.user.hasPassword).toBe(true);
    });

    it('signs in with a password by phone number too', async () => {
      const phone = nextPhone();
      const session = await otpSignIn({ phone });
      await http()
        .post('/api/v1/auth/password/set')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ password: 'correcthorse1' })
        .expect(200);

      const login = await http()
        .post('/api/v1/auth/login')
        .send({ phone, password: 'correcthorse1' })
        .expect(200);
      expect(login.body.user.id).toBe(session.user.id);

      await http().post('/api/v1/auth/login').send({ phone, password: 'wrong-pass-1' }).expect(401);
    });

    it('does not let a code sign in to an account that already has a password', async () => {
      const email = nextEmail();
      const session = await otpSignIn({ email });
      await http()
        .post('/api/v1/auth/password/set')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ password: 'correcthorse1' })
        .expect(200);

      const req = await http().post('/api/v1/auth/otp/request').send({ email }).expect(200);
      const res = await http()
        .post('/api/v1/auth/otp/verify')
        .send({ email, code: req.body.devCode })
        .expect(409);
      expect(res.body.error.code).toBe('PASSWORD_LOGIN_REQUIRED');
      expect(res.body.accessToken).toBeUndefined();
    });

    it('refuses to overwrite an existing password through set', async () => {
      const session = await otpSignIn({ email: nextEmail() });
      const set = (password: string) =>
        http()
          .post('/api/v1/auth/password/set')
          .set('Authorization', `Bearer ${session.accessToken}`)
          .send({ password });

      await set('correcthorse1').expect(200);
      const res = await set('anotherhorse2').expect(409);
      expect(res.body.error.code).toBe('PASSWORD_ALREADY_SET');
    });

    it('requires authentication and a strong password to set one', async () => {
      await http().post('/api/v1/auth/password/set').send({ password: 'correcthorse1' }).expect(401);

      const session = await otpSignIn({ email: nextEmail() });
      const res = await http()
        .post('/api/v1/auth/password/set')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ password: 'short1' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('password login fails identically for a code-only account and an unknown one', async () => {
      const email = nextEmail();
      await otpSignIn({ email });

      const noPassword = await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'correcthorse1' })
        .expect(401);
      const unknown = await http()
        .post('/api/v1/auth/login')
        .send({ email: nextEmail(), password: 'correcthorse1' })
        .expect(401);
      expect(noPassword.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(unknown.body.error.message).toBe(noPassword.body.error.message);
    });

    it('resets a forgotten password with a code and signs out every old session', async () => {
      const email = nextEmail();
      const first = await otpSignIn({ email });
      await http()
        .post('/api/v1/auth/password/set')
        .set('Authorization', `Bearer ${first.accessToken}`)
        .send({ password: 'correcthorse1' })
        .expect(200);

      const req = await http().post('/api/v1/auth/otp/request').send({ email }).expect(200);
      const reset = await http()
        .post('/api/v1/auth/password/reset')
        .send({ email, code: req.body.devCode, password: 'brandnewhorse2' })
        .expect(200);
      expect(reset.body.user.hasPassword).toBe(true);

      await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'correcthorse1' })
        .expect(401);
      await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'brandnewhorse2' })
        .expect(200);

      // The pre-reset refresh token was revoked.
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);
    });

    it('rejects a reset with a wrong code and leaves the password alone', async () => {
      const email = nextEmail();
      const first = await otpSignIn({ email });
      await http()
        .post('/api/v1/auth/password/set')
        .set('Authorization', `Bearer ${first.accessToken}`)
        .send({ password: 'correcthorse1' })
        .expect(200);

      const req = await http().post('/api/v1/auth/otp/request').send({ email }).expect(200);
      const wrong = req.body.devCode === '000000' ? '111111' : '000000';
      const res = await http()
        .post('/api/v1/auth/password/reset')
        .send({ email, code: wrong, password: 'brandnewhorse2' })
        .expect(401);
      expect(res.body.error.code).toBe('OTP_INVALID');

      await http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'correcthorse1' })
        .expect(200);
    });

    it('exposes hasPassword on /users/me', async () => {
      const session = await otpSignIn({ email: nextEmail() });
      const me = await http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      expect(me.body.hasPassword).toBe(false);
      expect(me.body.passwordHash).toBeUndefined();
    });
  });

  describe('google', () => {
    it('creates a new user on first sign-in', async () => {
      const email = nextEmail();
      googleVerifier.setToken('token-fresh', {
        providerId: `sub-${email}`,
        email,
        emailVerified: true,
        name: 'Google User',
      });

      const res = await http().post('/api/v1/auth/google').send({ idToken: 'token-fresh' }).expect(200);
      expect(res.body.user.email).toBe(email);
    });

    it('reuses the same user on a repeat login with the same Google account', async () => {
      const email = nextEmail();
      googleVerifier.setToken('token-repeat', {
        providerId: `sub-${email}`,
        email,
        emailVerified: true,
        name: 'Google User',
      });

      const first = await http().post('/api/v1/auth/google').send({ idToken: 'token-repeat' }).expect(200);
      const second = await http().post('/api/v1/auth/google').send({ idToken: 'token-repeat' }).expect(200);
      expect(second.body.user.id).toBe(first.body.user.id);
    });

    it('auto-links to an existing password account by matching verified email', async () => {
      const email = nextEmail();
      const registered = await http()
        .post('/api/v1/auth/email/register')
        .send({ email, password: 'correcthorse1' })
        .expect(201);

      googleVerifier.setToken('token-link', {
        providerId: `sub-${email}`,
        email,
        emailVerified: true,
        name: 'Google User',
      });

      const res = await http().post('/api/v1/auth/google').send({ idToken: 'token-link' }).expect(200);
      expect(res.body.user.id).toBe(registered.body.user.id);
    });

    it('rejects an unverifiable token', async () => {
      const res = await http()
        .post('/api/v1/auth/google')
        .send({ idToken: 'not-a-real-token' })
        .expect(401);
      expect(res.body.error.code).toBe('GOOGLE_TOKEN_INVALID');
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
