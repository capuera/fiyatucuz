import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '../src/config/env.js';
import type { InProcessJobQueue } from '../src/lib/jobs/InProcessJobQueue.js';
import { createLogger } from '../src/lib/logger.js';
import { loadAuthEnv, TENANT_HEADER } from '../src/modules/auth/index.js';
import { loadFeedEnv } from '../src/modules/feeds/index.js';
import { addMember, createTenant } from '../src/modules/tenants/index.js';
import { buildServer } from '../src/server.js';

import { isPostgresReachable, makeTestDbHandle, truncateAllBusinessTables } from './helpers.js';

const reachable = await isPostgresReachable();

// Local echo/success HTTP stub for the fetch route.
let stub: Server;
let stubUrl: string;

async function startStub(): Promise<void> {
  stub = createServer((_req, res) => {
    res.setHeader('content-type', 'application/xml');
    res.statusCode = 200;
    res.end('<rss><channel><title>ok</title></channel></rss>');
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = (stub.address() as AddressInfo).port;
  stubUrl = `http://127.0.0.1:${port}/feed.xml`;
}

async function stopStub(): Promise<void> {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
}

describe.skipIf(!reachable)('feeds: HTTP routes', () => {
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
  const feedEnv = loadFeedEnv({
    // Loopback allowed so the stub server is reachable.
    FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: 'true',
    FEED_FETCH_TIMEOUT_MS: '5000',
  });
  const logger = createLogger(env);
  const serverPromise = buildServer({ env, authEnv, feedEnv, logger, db: dbHandle.db });

  beforeAll(async () => {
    await truncateAllBusinessTables(dbHandle.sql);
    await startStub();
    await serverPromise;
  });
  afterEach(async () => {
    // Drain in-flight feed.fetch jobs before truncating so a setImmediate-
    // scheduled handler doesn't race the next test's row cleanup (ADIM 12.2
    // §Test isolation). Without this the handler runs against a truncated
    // DB and logs a spurious FEED_FETCH_NOT_FOUND that clutters test output.
    const server = await serverPromise;
    await (server.jobs as InProcessJobQueue).awaitIdle();
    await truncateAllBusinessTables(dbHandle.sql);
  });
  afterAll(async () => {
    const server = await serverPromise;
    await server.close();
    await stopStub();
    await dbHandle.close();
  });

  interface Authed {
    readonly userId: string;
    readonly tenantId: string;
    readonly sessionCookie: string;
  }

  async function registerAndBindTenant(prefix: string): Promise<Authed> {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `${prefix}-${randomUUID().slice(0, 8)}@example.com`,
        password: 'TestPass1!',
      },
    });
    expect(reg.statusCode).toBe(201);
    const userId = (reg.json() as { user: { id: string } }).user.id;
    const cookies = Object.fromEntries(reg.cookies.map((c) => [c.name, c.value]));
    const tenant = await createTenant(dbHandle.db, {
      name: 'T',
      slug: 'feed-tenant-' + randomUUID().slice(0, 6),
    });
    await addMember(dbHandle.db, tenant.id, { userId, role: 'OWNER' });
    return { userId, tenantId: tenant.id, sessionCookie: cookies.fu_session ?? '' };
  }

  async function createMerchantAndSite(
    authed: Authed,
    slugSuffix: string,
    domain: string,
  ): Promise<{ merchantId: string; siteId: string }> {
    const server = await serverPromise;
    const cm = await server.inject({
      method: 'POST',
      url: '/v1/merchants',
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'M', slug: `m-${slugSuffix}` },
    });
    expect(cm.statusCode).toBe(201);
    const merchantId = (cm.json() as { id: string }).id;
    const cs = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${merchantId}/sites`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'S', domain },
    });
    expect(cs.statusCode).toBe(201);
    const siteId = (cs.json() as { id: string }).id;
    return { merchantId, siteId };
  }

  // -- Auth guards --------------------------------------------------------

  it('GET feeds without a session → 401', async () => {
    const server = await serverPromise;
    const res = await server.inject({
      method: 'GET',
      url: `/v1/merchants/${randomUUID()}/sites/${randomUUID()}/feeds`,
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it('GET feeds without X-Tenant-Id → 403', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('no-tenant');
    const res = await server.inject({
      method: 'GET',
      url: `/v1/merchants/${randomUUID()}/sites/${randomUUID()}/feeds`,
      cookies: { fu_session: authed.sessionCookie },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('TENANT_CONTEXT_REQUIRED');
  });

  it('malformed :merchantId → 400 INVALID_INPUT', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('badid');
    const res = await server.inject({
      method: 'GET',
      url: `/v1/merchants/not-a-uuid/sites/${randomUUID()}/feeds`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    expect(res.statusCode).toBe(400);
  });

  // -- Happy path --------------------------------------------------------

  it('feed lifecycle: create → list → get → patch → fetch (202)', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('lifecycle');
    const { merchantId, siteId } = await createMerchantAndSite(
      authed,
      'lc',
      'lifecycle.example',
    );

    // Create feed.
    const create = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'Main', url: stubUrl, format: 'CUSTOM_XML' },
    });
    expect(create.statusCode).toBe(201);
    const feed = create.json() as { id: string; tenantId: string; url: string };
    expect(feed.tenantId).toBe(authed.tenantId);
    expect(feed.url).toBe(stubUrl);

    // List.
    const list = await server.inject({
      method: 'GET',
      url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([
      feed.id,
    ]);

    // Get.
    const get = await server.inject({
      method: 'GET',
      url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds/${feed.id}`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    expect(get.statusCode).toBe(200);

    // Patch.
    const patch = await server.inject({
      method: 'PATCH',
      url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds/${feed.id}`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'Renamed', status: 'PAUSED' },
    });
    expect(patch.statusCode).toBe(200);
    const patched = patch.json() as { name: string; status: string };
    expect(patched.name).toBe('Renamed');
    expect(patched.status).toBe('PAUSED');

    // Fetch → 202 + { fetchId, status: 'QUEUED' }.
    const fetchRes = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds/${feed.id}/fetch`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    expect(fetchRes.statusCode).toBe(202);
    const body = fetchRes.json() as { fetchId: string; status: string };
    expect(body.status).toBe('QUEUED');
    expect(body.fetchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('POST feed with invalid URL → 400 INVALID_FEED_URL', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('badurl');
    const { merchantId, siteId } = await createMerchantAndSite(
      authed,
      'br',
      'badurl.example',
    );
    const res = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'Bad', url: 'file:///etc/passwd', format: 'CUSTOM_XML' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('INVALID_FEED_URL');
  });

  it('cross-tenant feed access → 404 (never silent success, never leaks presence)', async () => {
    const server = await serverPromise;
    const alice = await registerAndBindTenant('a-cross');
    const bob = await registerAndBindTenant('b-cross');
    const bobs = await createMerchantAndSite(bob, 'bx', 'bob-cross.example');

    const create = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${bobs.merchantId}/sites/${bobs.siteId}/feeds`,
      cookies: { fu_session: bob.sessionCookie },
      headers: { [TENANT_HEADER]: bob.tenantId },
      payload: { name: 'B', url: stubUrl, format: 'CUSTOM_XML' },
    });
    expect(create.statusCode).toBe(201);
    const feedId = (create.json() as { id: string }).id;

    // Alice tries to see Bob's feed under Bob's merchant/site path.
    const res = await server.inject({
      method: 'GET',
      url: `/v1/merchants/${bobs.merchantId}/sites/${bobs.siteId}/feeds/${feedId}`,
      cookies: { fu_session: alice.sessionCookie },
      headers: { [TENANT_HEADER]: alice.tenantId },
    });
    // requireSite fails in Alice's tenant context — MerchantNotFoundError → 404.
    expect(res.statusCode).toBe(404);
  });

  it('POST fetch on non-existent feed → 404', async () => {
    const server = await serverPromise;
    const authed = await registerAndBindTenant('nofeed');
    const { merchantId, siteId } = await createMerchantAndSite(
      authed,
      'nf',
      'nf.example',
    );
    const res = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds/${randomUUID()}/fetch`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Feed-fetch rate limit (ADIM 12.1)
// ---------------------------------------------------------------------------

describe.skipIf(!reachable)('feeds: manual /fetch is rate-limited; GET endpoints are not', () => {
  const dbHandle = makeTestDbHandle();
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_FEED_FETCH_MAX: '2',
    RATE_LIMIT_FEED_FETCH_TIMEWINDOW: '1 minute',
  });
  const authEnv = loadAuthEnv({
    AUTH_TOKEN_HMAC_SECRET: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
    AUTH_COOKIE_SECURE: 'false',
  });
  const feedEnv = loadFeedEnv({
    FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: 'true',
    FEED_FETCH_TIMEOUT_MS: '5000',
  });
  const logger = createLogger(env);
  const serverPromise = buildServer({ env, authEnv, feedEnv, logger, db: dbHandle.db });

  beforeAll(async () => {
    await truncateAllBusinessTables(dbHandle.sql);
    await startStub();
    await serverPromise;
  });
  afterEach(async () => {
    // See earlier awaitIdle rationale — same guard applies to the rate-limit
    // block, whose tests fire many POST …/fetch calls.
    const server = await serverPromise;
    await (server.jobs as InProcessJobQueue).awaitIdle();
    await truncateAllBusinessTables(dbHandle.sql);
  });
  afterAll(async () => {
    const server = await serverPromise;
    await server.close();
    await stopStub();
    await dbHandle.close();
  });

  interface RlAuthed {
    readonly userId: string;
    readonly tenantId: string;
    readonly sessionCookie: string;
  }

  async function localAuthAndTenant(prefix: string): Promise<RlAuthed> {
    const server = await serverPromise;
    const reg = await server.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `${prefix}-${randomUUID().slice(0, 8)}@example.com`,
        password: 'TestPass1!',
      },
    });
    expect(reg.statusCode).toBe(201);
    const userId = (reg.json() as { user: { id: string } }).user.id;
    const cookies = Object.fromEntries(reg.cookies.map((c) => [c.name, c.value]));
    const tenant = await createTenant(dbHandle.db, {
      name: 'RL',
      slug: 'rl-tenant-' + randomUUID().slice(0, 6),
    });
    await addMember(dbHandle.db, tenant.id, { userId, role: 'OWNER' });
    return { userId, tenantId: tenant.id, sessionCookie: cookies.fu_session ?? '' };
  }

  async function localCreateMerchantSiteFeed(
    authed: RlAuthed,
    slugSuffix: string,
    domain: string,
  ): Promise<{ merchantId: string; siteId: string; feedId: string }> {
    const server = await serverPromise;
    const cm = await server.inject({
      method: 'POST',
      url: '/v1/merchants',
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'M', slug: `m-${slugSuffix}` },
    });
    expect(cm.statusCode).toBe(201);
    const merchantId = (cm.json() as { id: string }).id;
    const cs = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${merchantId}/sites`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'S', domain },
    });
    expect(cs.statusCode).toBe(201);
    const siteId = (cs.json() as { id: string }).id;
    const cf = await server.inject({
      method: 'POST',
      url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds`,
      cookies: { fu_session: authed.sessionCookie },
      headers: { [TENANT_HEADER]: authed.tenantId },
      payload: { name: 'F', url: stubUrl, format: 'CUSTOM_XML' },
    });
    expect(cf.statusCode).toBe(201);
    const feedId = (cf.json() as { id: string }).id;
    return { merchantId, siteId, feedId };
  }

  it('POST …/fetch: first N within budget → 202, next one → 429', async () => {
    const server = await serverPromise;
    const authed = await localAuthAndTenant('rl');
    const { merchantId, siteId, feedId } = await localCreateMerchantSiteFeed(
      authed,
      'rl',
      'rl.example',
    );
    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await server.inject({
        method: 'POST',
        url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds/${feedId}/fetch`,
        cookies: { fu_session: authed.sessionCookie },
        headers: { [TENANT_HEADER]: authed.tenantId },
      });
      results.push(res.statusCode);
    }
    // Budget was 2 → first two 202, remaining are 429.
    expect(results.slice(0, 2).every((s) => s === 202)).toBe(true);
    expect(results.slice(2).every((s) => s === 429)).toBe(true);
  });

  it('GET …/feeds and GET …/fetches are NOT rate-limited by the fetch budget', async () => {
    const server = await serverPromise;
    const authed = await localAuthAndTenant('rl-get');
    const { merchantId, siteId, feedId } = await localCreateMerchantSiteFeed(
      authed,
      'rlg',
      'rlg.example',
    );
    for (let i = 0; i < 10; i++) {
      const listFeeds = await server.inject({
        method: 'GET',
        url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds`,
        cookies: { fu_session: authed.sessionCookie },
        headers: { [TENANT_HEADER]: authed.tenantId },
      });
      expect(listFeeds.statusCode).toBe(200);

      const listFetches = await server.inject({
        method: 'GET',
        url: `/v1/merchants/${merchantId}/sites/${siteId}/feeds/${feedId}/fetches`,
        cookies: { fu_session: authed.sessionCookie },
        headers: { [TENANT_HEADER]: authed.tenantId },
      });
      expect(listFetches.statusCode).toBe(200);
    }
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] feeds-routes.test.ts: skipping — PG unreachable.');
}
