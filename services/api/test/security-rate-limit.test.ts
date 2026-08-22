import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { loadAuthEnv } from '../src/modules/auth/index.js';
import { buildServer } from '../src/server.js';

import { isPostgresReachable, makeTestDbHandle, truncateIdentityAndTenants } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('security: rate limiting on auth endpoints (ADIM 10.1 §Rate limiting)', () => {
  const dbHandle = makeTestDbHandle();
  // Aggressive limit so the test can trip it without spamming.
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_AUTH_MAX: '3',
    RATE_LIMIT_AUTH_TIMEWINDOW: '1 minute',
  });
  const authEnv = loadAuthEnv({
    AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
    AUTH_COOKIE_SECURE: 'false',
  });
  const logger = createLogger(env);
  const serverPromise = buildServer({ env, authEnv, logger, db: dbHandle.db });

  beforeAll(async () => {
    await truncateIdentityAndTenants(dbHandle.sql);
    await serverPromise;
  });
  afterAll(async () => {
    const server = await serverPromise;
    await server.close();
    await truncateIdentityAndTenants(dbHandle.sql);
    await dbHandle.close();
  });

  it('POST /v1/auth/login returns 429 after the configured max is exceeded', async () => {
    const server = await serverPromise;
    const attempts = [];
    for (let i = 0; i < 5; i++) {
      // Failed logins count against the same rate-limit bucket as successful
      // ones, which is the correct behavior — we care about request rate, not
      // outcome.
      attempts.push(
        await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: `rl-${i}@example.com`, password: 'AnyPass1!' },
        }),
      );
    }
    const statuses = attempts.map((r) => r.statusCode);
    // First MAX are handled (401 for unknown user); the rest are rate-limited.
    expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);

    const limited = attempts[4];
    expect(limited?.headers['content-type']).toContain('application/json');
  });

  it('non-auth routes (e.g. /health) are NOT rate-limited', async () => {
    const server = await serverPromise;
    for (let i = 0; i < 10; i++) {
      const res = await server.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe.skipIf(!reachable)('security: rate limiting can be disabled by env flag', () => {
  it('RATE_LIMIT_ENABLED=false leaves auth routes unlimited', async () => {
    const dbHandle = makeTestDbHandle();
    const env = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      RATE_LIMIT_ENABLED: 'false',
      RATE_LIMIT_AUTH_MAX: '1',
      RATE_LIMIT_AUTH_TIMEWINDOW: '1 minute',
    });
    const authEnv = loadAuthEnv({
      AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
      AUTH_COOKIE_SECURE: 'false',
    });
    const logger = createLogger(env);
    const server = await buildServer({ env, authEnv, logger, db: dbHandle.db });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await server.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: `off-${i}@example.com`, password: 'AnyPass1!' },
        });
        // Never 429.
        expect(res.statusCode).not.toBe(429);
      }
    } finally {
      await server.close();
      await dbHandle.close();
    }
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] security-rate-limit.test.ts: skipping — PG unreachable.');
}
