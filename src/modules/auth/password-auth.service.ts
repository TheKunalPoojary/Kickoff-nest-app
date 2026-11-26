import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { TokenService } from './token.service.js';
import { AuthService } from './auth.service.js';
import { authUser, type AuthResult } from './auth-result.js';
import type { Identifier } from './identifier.js';
import type { Env } from '../../infra/config/env.schema.js';
import { hashPassword, verifyPassword } from './password.util.js';
import {
  AccountUnavailableException,
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
  PasswordAlreadySetException,
} from '../../common/errors/domain.errors.js';

@Injectable()
export class PasswordAuthService {
  /**
   * A hash computed once and reused for every "no such user" login attempt,
   * so argon2.verify still runs and response latency cannot be used to
   * enumerate which emails are registered.
   */
  private readonly dummyHash: Promise<string> = hashPassword(
    'no-such-account-timing-safety-filler',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService<Env, true>,
    private readonly otp: AuthService,
  ) {}

  async register(email: string, password: string, name?: string): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new EmailAlreadyRegisteredException();

    const passwordHash = await hashPassword(password);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, name, role: 'USER', preferredSports: [] },
    });

    const pair = await this.tokens.issuePair(user.id, user.role);
    return { ...pair, user: authUser(user) };
  }

  /** Password login by phone or email. Wrong password, unknown account and
   * "account has no password yet" are deliberately indistinguishable. */
  async login(
    id: Identifier,
    password: string,
    ipAddress?: string,
    deviceInfo?: string,
  ): Promise<AuthResult> {
    await this.enforceRateLimit(id.value, ipAddress);

    const user =
      id.kind === 'phone'
        ? await this.prisma.user.findUnique({ where: { phone: id.value } })
        : await this.prisma.user.findUnique({ where: { email: id.value } });

    const ok = user?.passwordHash
      ? await verifyPassword(user.passwordHash, password)
      : await verifyPassword(await this.dummyHash, password).catch(() => false);

    await this.prisma.loginAttempt.create({
      data: { identifier: id.value, ipAddress, success: ok },
    });

    if (!ok || !user) throw new InvalidCredentialsException();
    if (user.isBlocked || user.deletedAt) throw new AccountUnavailableException();

    const pair = await this.tokens.issuePair(user.id, user.role, deviceInfo);
    return { ...pair, user: authUser(user) };
  }

  /**
   * First password for a user who signed in with a code (or Google). Refuses
   * to overwrite an existing one — changing it must go through `resetPassword`
   * (fresh OTP), otherwise a stolen access token could lock the owner out.
   */
  async setPassword(userId: string, password: string): Promise<{ hasPassword: true }> {
    const passwordHash = await hashPassword(password);
    // Conditional on `passwordHash: null` so two racing calls cannot both win.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, passwordHash: null, deletedAt: null },
      data: { passwordHash },
    });
    if (count === 0) throw new PasswordAlreadySetException();
    return { hasPassword: true };
  }

  /**
   * Forgot-password / change-password. A fresh OTP to the phone/email proves
   * ownership; every existing session is then revoked, so whoever may have
   * known the old password is signed out everywhere.
   */
  async resetPassword(
    id: Identifier,
    code: string,
    password: string,
    deviceInfo?: string,
  ): Promise<AuthResult> {
    await this.otp.consumeOtp(id, code);
    const user = await this.otp.findOrCreateVerifiedUser(id);

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    });
    await this.tokens.revokeAllForUser(user.id);

    const pair = await this.tokens.issuePair(user.id, user.role, deviceInfo);
    return { ...pair, user: authUser(updated) };
  }

  private async enforceRateLimit(identifier: string, ipAddress?: string): Promise<void> {
    const maxPerHour = this.config.get('LOGIN_MAX_ATTEMPTS_PER_HOUR', { infer: true });
    const maxPerHourPerIp = this.config.get('LOGIN_MAX_ATTEMPTS_PER_HOUR_PER_IP', {
      infer: true,
    });
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recentFailed = await this.prisma.loginAttempt.count({
      where: { identifier, success: false, createdAt: { gte: oneHourAgo } },
    });

    if (recentFailed >= maxPerHour) {
      throw new HttpException(
        { code: 'LOGIN_RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (ipAddress) {
      const recentFailedFromIp = await this.prisma.loginAttempt.count({
        where: { ipAddress, success: false, createdAt: { gte: oneHourAgo } },
      });

      if (recentFailedFromIp >= maxPerHourPerIp) {
        throw new HttpException(
          { code: 'LOGIN_RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }
}
