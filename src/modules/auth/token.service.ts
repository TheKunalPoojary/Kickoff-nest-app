import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { Env } from '../../infra/config/env.schema.js';
import type { UserRole } from '../../generated/prisma/enums.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Refresh tokens are opaque random strings, not JWTs — they must be
   * revocable, and a self-validating token cannot be revoked. Only the SHA-256
   * hash is stored, so a database dump does not yield usable sessions.
   */
  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async issuePair(
    userId: string,
    role: UserRole,
    deviceInfo?: string,
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, role },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
      },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const days = this.config.get('JWT_REFRESH_TTL_DAYS', { infer: true });

    await this.prisma.refreshSession.create({
      data: {
        userId,
        tokenHash: this.hash(refreshToken),
        familyId,
        deviceInfo,
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    };
  }

  /**
   * Rotate a refresh token.
   *
   * Presenting a token that was already rotated means two parties hold the
   * same token — the legitimate client and a thief. There is no way to tell
   * which one is calling, so the entire family is revoked and both must sign
   * in again. Annoying once, versus an attacker holding a renewable session
   * indefinitely.
   */
  async rotate(rawToken: string, deviceInfo?: string): Promise<TokenPair> {
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash: this.hash(rawToken) },
      include: { user: true },
    });

    if (!session) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Please sign in again.',
      });
    }

    if (session.revokedAt) {
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REUSED',
        message: 'Your session was ended for security reasons. Please sign in again.',
      });
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Please sign in again.',
      });
    }

    if (session.user.isBlocked || session.user.deletedAt) {
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException({
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'This account is no longer active.',
      });
    }

    // Mark spent before issuing the replacement, so a crash in between leaves
    // the old token dead rather than leaving two live tokens.
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.issuePair(
      session.userId,
      session.user.role,
      deviceInfo ?? session.deviceInfo ?? undefined,
      session.familyId,
    );
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Logout. Revokes only the presented session, not every device. */
  async revokeOne(rawToken: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
