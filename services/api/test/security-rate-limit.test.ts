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

describe.skipIf(!reachable)('security: rate-limit key behind a reverse proxy (trustProxy=127.0.0.1)', () => {
  // Mirrors production: IIS ARR on the same host connects from 127.0.0.1 and
  // writes X-Forwarded-For as "IP:port". server.inject's default
  // remoteAddress is 127.0.0.1, i.e. the trusted proxy.
  const dbHandle = makeTestDbHandle();
  const authEnv = loadAuthEnv({
    AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
    AUTH_COOKIE_SECURE: 'false',
  });

  async function buildProxiedServer() {
    const env = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_TRUST_PROXY: '127.0.0.1',
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_AUTH_MAX: '3',
      RATE_LIMIT_AUTH_TIMEWINDOW: '1 minute',
    });
    return buildServer({ env, authEnv, logger: createLogger(env), db: dbHandle.db });
  }

  function login(server: Awaited<ReturnType<typeof buildServer>>, xff: string, i: number) {
    return server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': xff },
      payload: { email: `proxy-rl-${i}@example.com`, password: 'AnyPass1!' },
    });
  }

  beforeAll(async () => {
    await truncateIdentityAndTenants(dbHandle.sql);
  });
  afterAll(async () => {
    await truncateIdentityAndTenants(dbHandle.sql);
    await dbHandle.close();
  });

  it('same IPv4 with a different port per request shares one bucket', async () => {
    const server = await buildProxiedServer();
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await login(server, `203.0.113.10:${60028 + i}`, i)).statusCode);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);

      // A different client IP is unaffected.
      expect((await login(server, '203.0.113.11:60028', 99)).statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('varying a malformed forwarded value cannot mint fresh buckets', async () => {
    const server = await buildProxiedServer();
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await login(server, `garbage-${i}`, i)).statusCode);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);

      // Valid clients keep their own buckets even after the invalid bucket
      // is exhausted.
      expect((await login(server, '203.0.113.10:60028', 99)).statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] security-rate-limit.test.ts: skipping — PG unreachable.');
}
