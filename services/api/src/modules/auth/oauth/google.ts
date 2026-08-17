import type { AuthEnv } from '../env.js';

import {
  NotImplementedError,
  type OAuthProvider,
  type OAuthVerifiedIdentity,
} from './index.js';

/**
 * Google OAuth provider — foundation stub.
 *
 * TODO (later sprint — see ADR-0014 §Follow-ups):
 *   1. Fetch Google's JWKS from https://www.googleapis.com/oauth2/v3/certs
 *      (cache with the response's Cache-Control max-age).
 *   2. Verify the ID token JWS with the matching JWK.
 *   3. Validate iss ∈ {https://accounts.google.com, accounts.google.com},
 *      aud === AUTH_GOOGLE_CLIENT_ID, exp > now, nonce matches the value
 *      set at authorize-time.
 *   4. Extract sub (stable account id) + email (if verified).
 *   5. Return { provider: 'google', providerAccountId: sub, emailAtProvider }.
 *
 * The verify path lives here (not in service.ts) so future OAuth work does
 * not touch the register/login/refresh service surface.
 */

class GoogleProvider implements OAuthProvider {
  readonly name = 'google' as const;

  constructor(
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
  ) {}

  isConfigured(): boolean {
    return typeof this.clientId === 'string' && this.clientId.length > 0
      && typeof this.clientSecret === 'string' && this.clientSecret.length > 0;
  }

  async verifyIdToken(_idToken: string): Promise<OAuthVerifiedIdentity> {
    // Never accepted a real Google token yet. Fail loudly if anyone tries.
    throw new NotImplementedError('google');
  }
}

export function createGoogleProvider(env: AuthEnv): OAuthProvider {
  return new GoogleProvider(env.AUTH_GOOGLE_CLIENT_ID, env.AUTH_GOOGLE_CLIENT_SECRET);
}
