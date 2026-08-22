import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { loadAuthEnv } from '../src/modules/auth/index.js';
import { buildServer } from '../src/server.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('security: CORS allowlist (ADIM 10.1 §CORS)', () => {
  const dbHandle = makeTestDbHandle();
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    CORS_ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
  });
  const authEnv = loadAuthEnv({
    AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
    AUTH_COOKIE_SECURE: 'false',
  });
  const logger = createLogger(env);
  const serverPromise = buildServer({ env, authEnv, logger, db: dbHandle.db });

  beforeAll(async () => {
    await serverPromise;
  });
  afterAll(async () => {
    const server = await serverPromise;
    await server.close();
    await dbHandle.close();
  });

  it('allows GET from an allowlisted origin (echoes Origin, credentials true)', async () => {
    const server = await serverPromise;
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('denies a disallowed origin (no ACAO header echoed)', async () => {
    const server = await serverPromise;
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    // Fastify still serves the body (CORS is browser-enforced), but MUST NOT
    // echo the disallowed origin — that is the actual server-side guarantee.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never returns the wildcard "*" origin', async () => {
    const server = await serverPromise;
    const withOrigin = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.example.com' },
    });
    expect(withOrigin.headers['access-control-allow-origin']).not.toBe('*');

    const disallowed = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(disallowed.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('handles OPTIONS preflight for an allowed origin', async () => {
    const server = await serverPromise;
    const res = await server.inject({
      method: 'OPTIONS',
      url: '/v1/auth/login',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const allowedMethods = String(res.headers['access-control-allow-methods'] ?? '');
    expect(allowedMethods.toUpperCase()).toContain('POST');
  });

  it('accepts non-browser (no Origin header) requests — CORS is browser-defense', async () => {
    const server = await serverPromise;
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('security: CORS production allowlist required', () => {
  it('buildServer throws when NODE_ENV=production and CORS_ALLOWED_ORIGINS is empty', async () => {
    const dbHandle = makeTestDbHandle();
    try {
      const env = loadApiEnv({
        NODE_ENV: 'production',
        LOG_LEVEL: 'error',
        API_HOST: '127.0.0.1',
      });
      const authEnv = loadAuthEnv({
        AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
        AUTH_COOKIE_SECURE: 'true',
      });
      const logger = createLogger(env);
      await expect(buildServer({ env, authEnv, logger, db: dbHandle.db })).rejects.toThrow(
        /CORS_ALLOWED_ORIGINS/,
      );
    } finally {
      await dbHandle.close();
    }
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] security-cors.test.ts: skipping — PG unreachable.');
}
