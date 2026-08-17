import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { loadAuthEnv } from '../src/modules/auth/index.js';
import { buildServer } from '../src/server.js';

import { isPostgresReachable, makeTestDbHandle, truncateIdentityAndTenants } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('auth — HTTP routes (integration via server.inject)', () => {
  const dbHandle = makeTestDbHandle();
  // Reuse loadApiEnv to inherit reasonable defaults; loadAuthEnv gets a
  // fixed-length dev HMAC secret sufficient for tests.
  // Tests use server.inject(); listen() is never called, so API_PORT here is
  // just schema-satisfying — the schema requires min=1.
  const env = loadApiEnv({ NODE_ENV: 'test', LOG_LEVEL: 'error', API_HOST: '127.0.0.1' });
  const authEnv = loadAuthEnv({
    AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
    AUTH_SESSION_TTL_SECONDS: '3600',
    AUTH_REFRESH_TTL_SECONDS: '86400',
    AUTH_COOKIE_SECURE: 'false',
  });
  const logger = createLogger(env);
  const serverPromise = buildServer({ env, authEnv, logger, db: dbHandle.db });

  beforeAll(async () => {
    await truncateIdentityAndTenants(dbHandle.sql);
    await serverPromise; // ready fastify
  });
  afterEach(async () => {
    await truncateIdentityAndTenants(dbHandle.sql);
  });
  afterAll(async () => {
    const server = await serverPromise;
    await server.close();
    await dbHandle.close();
  });

  it('POST /v1/auth/register → 201 with cookies', async () => {
    const server = await serverPromise;
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'r@example.com', password: 'ValidPass1!' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { user: { email: string }; memberships: unknown[]; session: unknown };
    expect(body.user.email).toBe('r@example.com');
    expect(body.memberships).toEqual([]);

    const cookies = res.cookies.map((c) => c.name);
    expect(cookies).toContain('fu_session');
    expect(cookies).toContain('fu_refresh');

    // Raw token values MUST NOT appear in the body.
    const raw = res.body;
    for (const c of res.cookies) {
      expect(raw).not.toContain(c.value);
    }
  });

  it('POST /v1/auth/register → 400 on invalid input (short password)', async () => {
    const server = await serverPromise;
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'r@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('POST /v1/auth/register → 409 on duplicate email', async () => {
    const server = await serverPromise;
    await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'dup@example.com', password: 'ValidPass1!' },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'DUP@Example.com', password: 'Other2Pass!' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('USER_ALREADY_EXISTS');
  });

  it('POST /v1/auth/login → 401 on wrong password', async () => {
    const server = await serverPromise;
    await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'lo@example.com', password: 'ValidPass1!' },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'lo@example.com', password: 'Wrong123!' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /v1/auth/login → 401 unknown user (unified surface with wrong password)', async () => {
    const server = await serverPromise;
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'ValidPass1!' },
    });
    expect(res.statusCode).toBe(401);
    // Same body shape as wrong-password — no user-enumeration signal on the wire.
    expect((res.json() as { code: string }).code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /v1/auth/refresh → 200 rotates cookies', async () => {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'rf@example.com', password: 'ValidPass1!' },
    });
    const cookies = Object.fromEntries(reg.cookies.map((c) => [c.name, c.value]));
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { fu_refresh: cookies.fu_refresh ?? '' },
    });
    expect(res.statusCode).toBe(200);
    const newCookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
    expect(newCookies.fu_session).not.toBe(cookies.fu_session);
    expect(newCookies.fu_refresh).not.toBe(cookies.fu_refresh);
  });

  it('POST /v1/auth/refresh → 401 clears cookies on reuse', async () => {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'ru@example.com', password: 'ValidPass1!' },
    });
    const c = Object.fromEntries(reg.cookies.map((x) => [x.name, x.value]));

    // First refresh succeeds.
    await server.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { fu_refresh: c.fu_refresh ?? '' },
    });
    // Replay of original refresh cookie → reuse detected.
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { fu_refresh: c.fu_refresh ?? '' },
    });
    expect(res.statusCode).toBe(401);
    // Cookies cleared on the response.
    const clearedNames = res.cookies.map((x) => x.name).sort();
    expect(clearedNames).toEqual(['fu_refresh', 'fu_session']);
  });

  it('POST /v1/auth/logout → 204 clears cookies and revokes session', async () => {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'lg@example.com', password: 'ValidPass1!' },
    });
    const c = Object.fromEntries(reg.cookies.map((x) => [x.name, x.value]));
    const res = await server.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: { fu_session: c.fu_session ?? '' },
    });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.map((x) => x.name).sort();
    expect(cleared).toEqual(['fu_refresh', 'fu_session']);
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] auth-routes.test.ts: skipping — PG unreachable.');
}
