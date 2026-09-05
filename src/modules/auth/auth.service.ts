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
import { TokenService, type TokenPair } from './token.service.js';
import type { Env } from '../../infra/config/env.schema.js';

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
  private hashCode(phone: string, code: string): string {
    const pepper = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    return createHash('sha256').update(`${phone}:${code}:${pepper}`).digest('hex');
  }

  async requestOtp(phone: string, ipAddress?: string): Promise<OtpRequestResult> {
    const maxPerHour = this.config.get('OTP_MAX_REQUESTS_PER_HOUR', { infer: true });
    const maxPerHourPerIp = this.config.get('OTP_MAX_REQUESTS_PER_HOUR_PER_IP', {
      infer: true,
    });
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recent = await this.prisma.otpChallenge.count({
      where: { phone, createdAt: { gte: oneHourAgo } },
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
        phone,
        codeHash: this.hashCode(phone, code),
        expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
        ipAddress,
      },
    });

    const isProduction = this.config.get('NODE_ENV', { infer: true }) === 'production';

    if (isProduction) {
      // TODO(phase 1): send via SMS provider.
      this.logger.log(`OTP issued for ${this.maskPhone(phone)}`);
    } else {
      this.logger.debug(`OTP for ${phone}: ${code}`);
    }

    return {
      sent: true,
      expiresInSeconds: ttlMinutes * 60,
      ...(isProduction ? {} : { devCode: code }),
    };
  }

  async verifyOtp(
    phone: string,
    code: string,
    deviceInfo?: string,
  ): Promise<TokenPair & { user: { id: string; phone: string | null; name: string | null } }> {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
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

    if (!this.codesMatch(challenge.codeHash, this.hashCode(phone, code))) {
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

    // A verified phone is the identity. Sign-up and sign-in are the same flow —
    // asking a first-time user to "register" separately is friction for no gain.
    const user = await this.prisma.user.upsert({
      where: { phone },
      create: { phone, role: 'USER', preferredSports: [] },
      update: {},
    });

    if (user.isBlocked || user.deletedAt) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'This account is no longer active.',
      });
    }

    const pair = await this.tokens.issuePair(user.id, user.role, deviceInfo);

    return { ...pair, user: { id: user.id, phone: user.phone, name: user.name } };
  }

  /** Constant-time compare, so response latency cannot leak the code. */
  private codesMatch(storedHex: string, candidateHex: string): boolean {
    const a = Buffer.from(storedHex, 'hex');
    const b = Buffer.from(candidateHex, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private maskPhone(phone: string): string {
    return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
  }
}
