import { createAuthService, loadAuthEnv, type AuthService } from '../src/modules/auth/index.js';

import { makeTestDbHandle } from './helpers.js';

/**
 * Build an auth service backed by the local Docker PG. The HMAC secret is a
 * fixed dev value; tests never write real secrets and never send Set-Cookie
 * bodies to real HTTPS endpoints.
 */
export function makeTestAuthService(): {
  authService: AuthService;
  close: () => Promise<void>;
} {
  const handle = makeTestDbHandle();
  const env = loadAuthEnv({
    AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
    AUTH_SESSION_TTL_SECONDS: '3600',
    AUTH_REFRESH_TTL_SECONDS: '86400',
    AUTH_COOKIE_SECURE: 'false',
  });
  const authService = createAuthService({ db: handle.db, env });
  return { authService, close: () => handle.close() };
}

/** Utility for tests that need to poke the DB directly (e.g. force expiry). */
export function reopenDbHandle(): ReturnType<typeof makeTestDbHandle> {
  return makeTestDbHandle();
}
