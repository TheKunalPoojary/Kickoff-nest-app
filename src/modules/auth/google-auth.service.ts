import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { TokenService, type TokenPair } from './token.service.js';
import { GoogleTokenVerifier } from './google-token-verifier.service.js';
import { AccountUnavailableException } from '../../common/errors/domain.errors.js';

type AuthResult = TokenPair & {
  user: { id: string; email: string | null; phone: string | null; name: string | null };
};

@Injectable()
export class GoogleAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly verifier: GoogleTokenVerifier,
  ) {}

  async login(idToken: string, deviceInfo?: string): Promise<AuthResult> {
    const profile = await this.verifier.verify(idToken);

    const identity = await this.prisma.socialIdentity.findUnique({
      where: { provider_providerId: { provider: 'GOOGLE', providerId: profile.providerId } },
      include: { user: true },
    });

    let user = identity?.user;

    if (!user) {
      // Auto-link: a Google-verified email matching an existing account (e.g.
      // registered with a password) is treated as the same person — Google
      // has already verified ownership of that email more strongly than an
      // in-app reset flow would.
      const existingByEmail = profile.emailVerified
        ? await this.prisma.user.findUnique({ where: { email: profile.email } })
        : null;

      user =
        existingByEmail ??
        (await this.prisma.user.create({
          data: { email: profile.email, name: profile.name, role: 'USER', preferredSports: [] },
        }));

      await this.prisma.socialIdentity.create({
        data: { userId: user.id, provider: 'GOOGLE', providerId: profile.providerId },
      });
    }

    if (user.isBlocked || user.deletedAt) throw new AccountUnavailableException();

    const pair = await this.tokens.issuePair(user.id, user.role, deviceInfo);
    return { ...pair, user: { id: user.id, email: user.email, phone: user.phone, name: user.name } };
  }
}
