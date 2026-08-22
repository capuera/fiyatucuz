import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { loadAuthEnv } from '../src/modules/auth/index.js';
import { buildServer } from '../src/server.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)(
  'security: helmet security headers (ADIM 10.1 §Security headers)',
  () => {
    const dbHandle = makeTestDbHandle();
    const env = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
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

    it('sets X-Content-Type-Options: nosniff', async () => {
      const server = await serverPromise;
      const res = await server.inject({ method: 'GET', url: '/health' });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets X-Frame-Options (deny/sameorigin) to prevent clickjacking', async () => {
      const server = await serverPromise;
      const res = await server.inject({ method: 'GET', url: '/health' });
      const xfo = String(res.headers['x-frame-options'] ?? '').toUpperCase();
      expect(['DENY', 'SAMEORIGIN']).toContain(xfo);
    });

    it('does NOT set HSTS when AUTH_COOKIE_SECURE=false (no HTTPS asserted)', async () => {
      const server = await serverPromise;
      const res = await server.inject({ method: 'GET', url: '/health' });
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });
  },
);

describe.skipIf(!reachable)('security: HSTS enabled when AUTH_COOKIE_SECURE=true', () => {
  it('sets Strict-Transport-Security with a long max-age', async () => {
    const dbHandle = makeTestDbHandle();
    const env = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
    });
    const authEnv = loadAuthEnv({
      AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
      AUTH_COOKIE_SECURE: 'true',
    });
    const logger = createLogger(env);
    const server = await buildServer({ env, authEnv, logger, db: dbHandle.db });
    try {
      const res = await server.inject({ method: 'GET', url: '/health' });
      const hsts = String(res.headers['strict-transport-security'] ?? '');
      expect(hsts).toContain('max-age=');
      expect(hsts).toContain('includeSubDomains');
    } finally {
      await server.close();
      await dbHandle.close();
    }
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] security-headers.test.ts: skipping — PG unreachable.');
}
