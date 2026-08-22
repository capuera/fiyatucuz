import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { loadAuthEnv, TENANT_HEADER } from '../src/modules/auth/index.js';
import { addMember, createTenant } from '../src/modules/tenants/index.js';
import { buildServer } from '../src/server.js';

import {
  isPostgresReachable,
  makeTestDbHandle,
  truncateAllBusinessTables,
} from './helpers.js';

const reachable = await isPostgresReachable();

// Every route requires request.user AND request.tenantId. This suite covers
// unauth (401), auth-but-no-tenant (403), invalid tenant membership (also 403),
// happy path (2xx), malformed UUID (400), invalid domain (400), and the
// verification token flow.

describe.skipIf(!reachable)('merchants: HTTP routes (integration via server.inject)', () => {
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
    await truncateAllBusinessTables(dbHandle.sql);
    await serverPromise;
  });
  afterEach(async () => {
    await truncateAllBusinessTables(dbHandle.sql);
  });
  afterAll(async () => {
    const server = await serverPromise;
    await server.close();
    await dbHandle.close();
  });

  // -----------------------------------------------------------------------
  // Small helpers to register + login a user and bind a tenant
  // -----------------------------------------------------------------------

  interface Authed {
    readonly userId: string;
    readonly tenantId: string;
    readonly sessionCookie: string;
  }

  async function registerAndBindTenant(emailPrefix: string): Promise<Authed> {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${emailPrefix}-${randomUUID().slice(0, 8)}@example.com`, password: 'TestPass1!' },
    });
    expect(reg.statusCode).toBe(201);
    const userId = (reg.json() as { user: { id: string } }).user.id;
    const cookies = Object.fromEntries(reg.cookies.map((c) => [c.name, c.value]));

    const tenant = await createTenant(dbHandle.db, {
      name: 'Tenant',
      slug: 'route-tenant-' + randomUUID().slice(0, 6),
    });
    await addMember(dbHandle.db, tenant.id, { userId, role: 'OWNER' });

    return { userId, tenantId: tenant.id, sessionCookie: cookies.fu_session ?? '' };
  }

  // -- Auth guards ---------------------------------------------------------

  it('GET /v1/merchants without a session → 401', async () => {
    const server = await serverPromise;
    const res = await server.inject({ method: 'GET', url: '/v1/merchants' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('GET /v1/merchants with a session but WITHOUT X-Tenant-Id → 403', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('no-tenant');
    const res = await server.inject({
      method: 'GET',
      url: '/v1/merchants',
      cookies: { fu_session: authed.sessionCookie },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('TENANT_CONTEXT_REQUIRED');
  });

  it('GET /v1/merchants with X-Tenant-Id for a tenant the user is NOT a member of → 403', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('foreign');
    const foreign = await createTenant(dbHandle.db, { name: 'F', slug: 'foreign-tenant-x' });
    const res = await server.inject({
      method: 'GET',
      url: '/v1/merchants',
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: foreign.id },
    });
    // Middleware leaves request.tenantId null when user has no membership;
    // the route then 403s on TENANT_CONTEXT_REQUIRED.
    expect(res.statusCode).toBe(403);
  });

  // -- Happy path ---------------------------------------------------------

  it('full merchant lifecycle (create → list → get → patch)', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('happy');

    const create = await server.inject({
      method: 'POST',
      url: '/v1/merchants',
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'Happy Corp', slug: 'happy-corp' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { id: string; tenantId: string; slug: string };
    expect(created.tenantId).toBe(authed.tenantId);
    expect(created.slug).toBe('happy-corp');

    const list = await server.inject({
      method: 'GET',
      url: '/v1/merchants',
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toEqual([created.id]);

    const get = await server.inject({
      method: 'GET',
      url: `/v1/merchants/${created.id}`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    expect(get.statusCode).toBe(200);

    const patch = await server.inject({
      method: 'PATCH',
      url: `/v1/merchants/${created.id}`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { status: 'SUSPENDED' },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { status: string }).status).toBe('SUSPENDED');
  });

  it('malformed :merchantId → 400 INVALID_INPUT', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('badid');
    const res = await server.inject({
      method: 'GET',
      url: '/v1/merchants/not-a-uuid',
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('POST site with invalid domain → 400 INVALID_DOMAIN', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('baddomain');
    const create = await server.inject({
      method: 'POST',
      url: '/v1/merchants',
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'M', slug: 'baddomain-m' },
    });
    const mId = (create.json() as { id: string }).id;
    const res = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${mId}/sites`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'Bad', domain: 'not a domain' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('INVALID_DOMAIN');
  });

  it('tenant A cannot GET a merchant owned by tenant B (returns 404, not silent empty)', async () => {
    const server = await serverPromise;
    const alice = await registerAndBindTenant('alice');
    const bob = await registerAndBindTenant('bob');

    const create = await server.inject({
      method: 'POST',
      url: '/v1/merchants',
      cookies: { fu_session: bob.sessionCookie },
      headers: { [TENANT_HEADER]: bob.tenantId },
      payload: { name: 'Bobs', slug: 'bobs-only' },
    });
    const bobsMerchantId = (create.json() as { id: string }).id;

    const res = await server.inject({
      method: 'GET',
      url: `/v1/merchants/${bobsMerchantId}`,
      cookies: { fu_session: alice.sessionCookie },
      headers: { [TENANT_HEADER]: alice.tenantId },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('MERCHANT_NOT_FOUND');
  });

  it('POST verification challenge returns raw token exactly once; site responses never re-expose token or hash', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('challenge');

    const cm = await server.inject({
      method: 'POST',
      url: '/v1/merchants',
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'M', slug: 'chal-m' },
    });
    const mId = (cm.json() as { id: string }).id;

    const cs = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${mId}/sites`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'S', domain: 'challenge-http.example' },
    });
    const site = cs.json() as { id: string; verificationTokenHash?: string };
    expect(cs.statusCode).toBe(201);
    // The site envelope must NEVER include the verification_token_hash.
    expect(site.verificationTokenHash).toBeUndefined();

    const ch = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${mId}/sites/${site.id}/verification`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { method: 'DNS_TXT' },
    });
    expect(ch.statusCode).toBe(201);
    const body = ch.json() as {
      site: { id: string; verificationTokenHash?: string; verificationStatus: string };
      challenge: { method: string; token: string; instructions: Record<string, unknown> };
    };
    // Raw token IS present at challenge creation.
    expect(body.challenge.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // But NEVER the stored hash.
    expect(body.site.verificationTokenHash).toBeUndefined();
    expect(body.site.verificationStatus).toBe('PENDING');
    expect(body.challenge.instructions.recordName).toContain('challenge-http.example');

    // A follow-up GET on the site returns everything EXCEPT the hash and
    // never re-exposes the raw token.
    const getSite = await server.inject({
      method: 'GET',
      url: `/v1/merchants/${mId}/sites/${site.id}`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    const gotSite = getSite.json() as Record<string, unknown>;
    expect('verificationTokenHash' in gotSite).toBe(false);
    // Absolutely no field equals the raw token.
    for (const value of Object.values(gotSite)) {
      expect(String(value)).not.toBe(body.challenge.token);
    }
  });

  it('POST create site under a merchant owned by another tenant → 404 (not silent success)', async () => {
    const server = await serverPromise;
    const alice = await registerAndBindTenant('alicex');
    const bob = await registerAndBindTenant('bobx');

    const cb = await server.inject({
      method: 'POST',
      url: '/v1/merchants',
      cookies: { fu_session: bob.sessionCookie },
      headers: { [TENANT_HEADER]: bob.tenantId },
      // Slug min length is 3 in the schema.
      payload: { name: 'B', slug: 'bxx' },
    });
    expect(cb.statusCode).toBe(201);
    const bobsMerchantId = (cb.json() as { id: string }).id;

    const res = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${bobsMerchantId}/sites`,
      cookies: { fu_session: alice.sessionCookie },
      headers: { [TENANT_HEADER]: alice.tenantId },
      payload: { name: 'A', domain: 'alice-should-not.example' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { code: string }).code).toBe('MERCHANT_NOT_FOUND');
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] merchants-routes.test.ts: skipping — PG unreachable.');
}
