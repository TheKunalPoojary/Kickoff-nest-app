import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { TokenService } from './token.service.js';
import type { Env } from '../../infra/config/env.schema.js';
import {
  AccountUnavailableException,
  PasswordLoginRequiredException,
} from '../../common/errors/domain.errors.js';
import { maskIdentifier, type Identifier } from './identifier.js';
import { authUser, type AuthResult } from './auth-result.js';

export interface OtpRequestResult {
  sent: true;
  expiresInSeconds: number;
  /** Present only outside production, so the flow is testable without SMS. */
  devCode?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Codes are hashed with a server-side pepper. A 6-digit code has only a
   * million possibilities, so a bare hash is trivially reversible with a
   * rainbow table — the pepper is what makes the stored value useless on its
   * own. Attempt caps do the rest.
   */
  private hashCode(identifier: string, code: string): string {
    const pepper = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    return createHash('sha256').update(`${identifier}:${code}:${pepper}`).digest('hex');
  }

  async requestOtp(id: Identifier, ipAddress?: string): Promise<OtpRequestResult> {
    const maxPerHour = this.config.get('OTP_MAX_REQUESTS_PER_HOUR', { infer: true });
    const maxPerHourPerIp = this.config.get('OTP_MAX_REQUESTS_PER_HOUR_PER_IP', {
      infer: true,
    });
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recent = await this.prisma.otpChallenge.count({
      where: { identifier: id.value, createdAt: { gte: oneHourAgo } },
    });

    if (recent >= maxPerHour) {
      // 429, not 400: the client should back off and show a wait, rather than
      // prompt the user to retype something that was never wrong.
      throw new HttpException(
        {
          code: 'OTP_RATE_LIMITED',
          message: 'Too many codes requested. Please try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Catches what the per-phone limit can't: one attacker spraying requests
    // across many numbers from a single source. Skipped when the IP is
    // unknown rather than blocking on a false "unlimited" positive.
    if (ipAddress) {
      const recentFromIp = await this.prisma.otpChallenge.count({
        where: { ipAddress, createdAt: { gte: oneHourAgo } },
      });

      if (recentFromIp >= maxPerHourPerIp) {
        throw new HttpException(
          {
            code: 'OTP_RATE_LIMITED',
            message: 'Too many codes requested. Please try again later.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const ttlMinutes = this.config.get('OTP_TTL_MINUTES', { infer: true });
    // randomInt is CSPRNG-backed; Math.random is predictable and must never
    // generate a credential.
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    await this.prisma.otpChallenge.create({
      data: {
        identifier: id.value,
        codeHash: this.hashCode(id.value, code),
        expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
        ipAddress,
      },
    });

    const isProduction = this.config.get('NODE_ENV', { infer: true }) === 'production';

    if (isProduction) {
      // TODO: deliver via the SMS provider (phone) / transactional email
      // provider (email) — neither is wired yet, so production sends nothing.
      this.logger.log(`OTP issued for ${maskIdentifier(id)}`);
    } else {
      this.logger.debug(`OTP for ${id.value}: ${code}`);
    }

    return {
      sent: true,
      expiresInSeconds: ttlMinutes * 60,
      ...(isProduction ? {} : { devCode: code }),
    };
  }

  /**
   * Checks the code against the newest live challenge and burns it. Shared by
   * OTP sign-in and password reset, so both get the same attempt cap and
   * single-use guarantee.
   */
  async consumeOtp(id: Identifier, code: string): Promise<void> {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { identifier: id.value, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge) {
      throw new UnauthorizedException({
        code: 'OTP_INVALID',
        message: 'That code is invalid or has expired.',
      });
    }

    const maxAttempts = this.config.get('OTP_MAX_ATTEMPTS', { infer: true });

    if (challenge.attempts >= maxAttempts) {
      // Burn it, so brute force cannot continue against the same challenge.
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      throw new UnauthorizedException({
        code: 'OTP_ATTEMPTS_EXCEEDED',
        message: 'Too many incorrect attempts. Request a new code.',
      });
    }

    if (!this.codesMatch(challenge.codeHash, this.hashCode(id.value, code))) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException({
        code: 'OTP_INVALID',
        message: 'That code is invalid or has expired.',
      });
    }

    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
  }

  /**
   * A verified phone/email is the identity. Sign-up and sign-in are the same
   * flow — asking a first-time user to "register" separately is friction for
   * no gain. Call only after `consumeOtp` succeeded.
   */
  async findOrCreateVerifiedUser(id: Identifier) {
    const user =
      id.kind === 'phone'
        ? await this.prisma.user.upsert({
            where: { phone: id.value },
            create: { phone: id.value, role: 'USER', preferredSports: [] },
            update: {},
          })
        : await this.prisma.user.upsert({
            where: { email: id.value },
            create: { email: id.value, role: 'USER', preferredSports: [] },
            update: {},
          });

    if (user.isBlocked || user.deletedAt) {
      throw new AccountUnavailableException();
    }

    return user;
  }

  /**
   * Sign-UP only. A code proves the phone/email is yours, which creates the
   * account (or resumes one that never got a password); it is NOT a way to
   * sign in. Once a password exists, signing in is password-only — letting a
   * code in as well would make the password optional for anyone who can
   * receive SMS/email. The check runs after the code is consumed, so only
   * someone who proved ownership learns the account exists.
   */
  async verifyOtp(id: Identifier, code: string, deviceInfo?: string): Promise<AuthResult> {
    await this.consumeOtp(id, code);
    const user = await this.findOrCreateVerifiedUser(id);
    if (user.passwordHash) throw new PasswordLoginRequiredException();
    const pair = await this.tokens.issuePair(user.id, user.role, deviceInfo);
    return { ...pair, user: authUser(user) };
  }

  /** Constant-time compare, so response latency cannot leak the code. */
  private codesMatch(storedHex: string, candidateHex: string): boolean {
    const a = Buffer.from(storedHex, 'hex');
    const b = Buffer.from(candidateHex, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
