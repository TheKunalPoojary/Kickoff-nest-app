import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import type { Env } from '../../infra/config/env.schema.js';
import { GoogleTokenInvalidException } from '../../common/errors/domain.errors.js';

export interface GoogleProfile {
  providerId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Isolated behind its own injectable class, and not folded into
 * GoogleAuthService, purely so e2e tests can substitute a fake via
 * `overrideProvider` — the same DI-substitution pattern used for
 * RazorpayClient, since real Google ID token verification cannot run in CI
 * without a live token.
 */
@Injectable()
export class GoogleTokenVerifier {
  private readonly client = new OAuth2Client();

  constructor(private readonly config: ConfigService<Env, true>) {}

  async verify(idToken: string): Promise<GoogleProfile> {
    const audience = this.config.get('GOOGLE_OAUTH_CLIENT_IDS', { infer: true });

    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) throw new Error('missing sub/email claim');

      return {
        providerId: payload.sub,
        email: payload.email.toLowerCase(),
        emailVerified: payload.email_verified === true,
        name: payload.name ?? null,
      };
    } catch {
      throw new GoogleTokenInvalidException();
    }
  }
}
