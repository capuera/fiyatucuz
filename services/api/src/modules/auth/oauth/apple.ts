import type { AuthEnv } from '../env.js';

import {
  NotImplementedError,
  type OAuthProvider,
  type OAuthVerifiedIdentity,
} from './index.js';

/**
 * Apple "Sign in with Apple" provider — foundation stub.
 *
 * TODO (later sprint — see ADR-0014 §Follow-ups):
 *   1. Fetch Apple's JWKS from https://appleid.apple.com/auth/keys
 *      (cache).
 *   2. Verify the id_token JWS with the matching JWK.
 *   3. Validate iss === https://appleid.apple.com, aud === AUTH_APPLE_CLIENT_ID,
 *      exp > now, nonce matches value set at authorize-time.
 *   4. Construct a client_secret JWT (ES256) signed with AUTH_APPLE_PRIVATE_KEY
 *      when performing token exchange (Apple's server-to-server call).
 *   5. Extract sub (stable account id) + email (if included and verified).
 *   6. Return { provider: 'apple', providerAccountId: sub, emailAtProvider }.
 *
 * The private key material MUST come from AUTH_APPLE_PRIVATE_KEY — never
 * hard-coded, never logged.
 */

class AppleProvider implements OAuthProvider {
  readonly name = 'apple' as const;

  constructor(
    private readonly clientId: string | undefined,
    private readonly teamId: string | undefined,
    private readonly keyId: string | undefined,
    private readonly privateKey: string | undefined,
  ) {}

  isConfigured(): boolean {
    return (
      typeof this.clientId === 'string' && this.clientId.length > 0 &&
      typeof this.teamId === 'string' && this.teamId.length > 0 &&
      typeof this.keyId === 'string' && this.keyId.length > 0 &&
      typeof this.privateKey === 'string' && this.privateKey.length > 0
    );
  }

  async verifyIdToken(_idToken: string): Promise<OAuthVerifiedIdentity> {
    throw new NotImplementedError('apple');
  }
}

export function createAppleProvider(env: AuthEnv): OAuthProvider {
  return new AppleProvider(
    env.AUTH_APPLE_CLIENT_ID,
    env.AUTH_APPLE_TEAM_ID,
    env.AUTH_APPLE_KEY_ID,
    env.AUTH_APPLE_PRIVATE_KEY,
  );
}
