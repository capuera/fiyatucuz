import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { loadAuthEnv, TENANT_HEADER } from '../src/modules/auth/index.js';
import { buildServer } from '../src/server.js';
import { addMember, createTenant } from '../src/modules/tenants/index.js';

import { isPostgresReachable, makeTestDbHandle, truncateIdentityAndTenants } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('auth — middleware populates request.user + request.tenantId', () => {
  const dbHandle = makeTestDbHandle();
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
  });
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
    const server = await serverPromise;
    // Test-only route that echoes request.user + request.tenantId — proves
    // the middleware populated them.
    server.get('/__whoami', async (request, reply) => {
      return reply.send({
        userId: request.user?.id ?? null,
        userEmail: request.user?.email ?? null,
        tenantId: request.tenantId ?? null,
      });
    });
  });

  afterEach(async () => {
    await truncateIdentityAndTenants(dbHandle.sql);
  });

  afterAll(async () => {
    const server = await serverPromise;
    await server.close();
    await dbHandle.close();
  });

  it('no session cookie → request.user is null (middleware never rejects)', async () => {
    const server = await serverPromise;
    const res = await server.inject({ method: 'GET', url: '/__whoami' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: null, userEmail: null, tenantId: null });
  });

  it('valid session cookie → request.user populated', async () => {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'mid1@example.com', password: 'ValidPass1!' },
    });
    const c = Object.fromEntries(reg.cookies.map((x) => [x.name, x.value]));

    const res = await server.inject({
      method: 'GET',
      url: '/__whoami',
      cookies: { fu_session: c.fu_session ?? '' },
    });
    const body = res.json() as { userId: string | null; userEmail: string | null };
    expect(body.userEmail).toBe('mid1@example.com');
    expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('valid session + X-Tenant-Id → request.tenantId populated iff user is a member', async () => {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'mid2@example.com', password: 'ValidPass1!' },
    });
    const cookies = Object.fromEntries(reg.cookies.map((x) => [x.name, x.value]));
    const userId = (reg.json() as { user: { id: string } }).user.id;

    const tenant = await createTenant(dbHandle.db, { name: 'MidT', slug: 'mid-tenant' });
    await addMember(dbHandle.db, tenant.id, { userId, role: 'OWNER' });

    const res = await server.inject({
      method: 'GET',
      url: '/__whoami',
      cookies: { fu_session: cookies.fu_session ?? '' },
      headers: { [TENANT_HEADER]: tenant.id },
    });
    const body = res.json() as { userId: string | null; tenantId: string | null };
    expect(body.userId).toBe(userId);
    expect(body.tenantId).toBe(tenant.id);
  });

  it('valid session + X-Tenant-Id for a tenant the user is NOT a member of → tenantId stays null', async () => {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'mid3@example.com', password: 'ValidPass1!' },
    });
    const cookies = Object.fromEntries(reg.cookies.map((x) => [x.name, x.value]));
    // A tenant this user is not a member of.
    const foreign = await createTenant(dbHandle.db, { name: 'Foreign', slug: 'foreign-tenant' });

    const res = await server.inject({
      method: 'GET',
      url: '/__whoami',
      cookies: { fu_session: cookies.fu_session ?? '' },
      headers: { [TENANT_HEADER]: foreign.id },
    });
    const body = res.json() as { userId: string | null; tenantId: string | null };
    expect(body.userId).not.toBeNull();
    expect(body.tenantId).toBeNull();
  });

  it('revoked session → request.user is null (middleware refuses the cookie)', async () => {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'mid4@example.com', password: 'ValidPass1!' },
    });
    const cookies = Object.fromEntries(reg.cookies.map((x) => [x.name, x.value]));

    await dbHandle.sql`update sessions set revoked_at = now()`;

    const res = await server.inject({
      method: 'GET',
      url: '/__whoami',
      cookies: { fu_session: cookies.fu_session ?? '' },
    });
    const body = res.json() as { userId: string | null };
    expect(body.userId).toBeNull();
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] auth-middleware.test.ts: skipping — PG unreachable.');
}
