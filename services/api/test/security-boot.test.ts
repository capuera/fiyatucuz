import { describe, expect, it } from 'vitest';

import {
  assertProductionCookieSecurity,
  InsecureProductionCookieError,
  loadAuthEnv,
} from '../src/modules/auth/index.js';

const BASE = {
  AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
};

describe('security: production cookie boot assertion (ADIM 10.1 §Production cookie security)', () => {
  it('throws when NODE_ENV=production and AUTH_COOKIE_SECURE=false', () => {
    const env = loadAuthEnv({ ...BASE, AUTH_COOKIE_SECURE: 'false' });
    expect(() => assertProductionCookieSecurity(env, 'production')).toThrow(
      InsecureProductionCookieError,
    );
  });

  it('passes when NODE_ENV=production and AUTH_COOKIE_SECURE=true', () => {
    const env = loadAuthEnv({ ...BASE, AUTH_COOKIE_SECURE: 'true' });
    expect(() => assertProductionCookieSecurity(env, 'production')).not.toThrow();
  });

  it('passes when NODE_ENV=development even with AUTH_COOKIE_SECURE=false', () => {
    const env = loadAuthEnv({ ...BASE, AUTH_COOKIE_SECURE: 'false' });
    expect(() => assertProductionCookieSecurity(env, 'development')).not.toThrow();
  });

  it('passes when NODE_ENV=test even with AUTH_COOKIE_SECURE=false', () => {
    const env = loadAuthEnv({ ...BASE, AUTH_COOKIE_SECURE: 'false' });
    expect(() => assertProductionCookieSecurity(env, 'test')).not.toThrow();
  });

  it('does not silently override the value — the env still reports false', () => {
    const env = loadAuthEnv({ ...BASE, AUTH_COOKIE_SECURE: 'false' });
    expect(env.AUTH_COOKIE_SECURE).toBe(false);
    // Only the assertion enforces prod; the value itself is preserved.
    try {
      assertProductionCookieSecurity(env, 'production');
    } catch {
      // expected
    }
    expect(env.AUTH_COOKIE_SECURE).toBe(false);
  });
});
