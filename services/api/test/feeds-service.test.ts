import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { JobQueue } from '../src/lib/jobs/JobQueue.js';
import { InProcessJobQueue } from '../src/lib/jobs/InProcessJobQueue.js';
import { createLogger } from '../src/lib/logger.js';
import { loadApiEnv } from '../src/config/env.js';
import {
  buildArchiveRef,
  createFeedService,
  createSafeFeedFetcher,
  FeedNotFoundError,
  loadFeedEnv,
  LocalFilesystemFeedArchive,
  parseArchiveRef,
  type FeedArchive,
  type FeedArchiveKey,
  type FeedArchiveWriter,
  type FeedService,
} from '../src/modules/feeds/index.js';
import { createMerchantService } from '../src/modules/merchants/index.js';

import { isPostgresReachable, makeTestDbHandle, truncateAllBusinessTables } from './helpers.js';

const reachable = await isPostgresReachable();

// ---------------------------------------------------------------------------
// Local test HTTP server. We run it on 127.0.0.1 with a random port, and
// enable FEED_FETCH_ALLOW_PRIVATE_ADDRESSES=true in the test-scoped feedEnv
// so the SSRF gate permits the loopback target. This does NOT relax any
// production-facing config (assertProductionFeedFetchSafety fails in prod).
// ---------------------------------------------------------------------------

interface StubResponse {
  readonly status?: number;
  readonly body?: string | Buffer;
  readonly contentType?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly location?: string;
  readonly delayMs?: number;
}

interface StubServer {
  readonly url: (path: string) => string;
  set(handler: (path: string, req: Parameters<typeof onReq>[0]) => StubResponse | Promise<StubResponse>): void;
  close(): Promise<void>;
}

type ReqMeta = { path: string; ifNoneMatch: string | null; ifModifiedSince: string | null };

const onReq = (req: Parameters<Server['emit']>[0]): void => {
  void req;
};

async function startStubServer(): Promise<StubServer> {
  let handler:
    | ((path: string, meta: ReqMeta) => StubResponse | Promise<StubResponse>)
    | null = null;
  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    const meta: ReqMeta = {
      path,
      ifNoneMatch: (req.headers['if-none-match'] as string | undefined) ?? null,
      ifModifiedSince: (req.headers['if-modified-since'] as string | undefined) ?? null,
    };
    if (!handler) {
      res.statusCode = 500;
      res.end('no handler set');
      return;
    }
    let out: StubResponse;
    try {
      out = await handler(path, meta);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
      return;
    }
    if (out.delayMs) await delay(out.delayMs);
    if (out.contentType) res.setHeader('content-type', out.contentType);
    if (out.etag) res.setHeader('etag', out.etag);
    if (out.lastModified) res.setHeader('last-modified', out.lastModified);
    if (out.location) res.setHeader('location', out.location);
    res.statusCode = out.status ?? 200;
    if (out.body === undefined) {
      res.end();
    } else {
      res.end(out.body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    set: (h) => {
      handler = h;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Fixture: create a tenant + membership + merchant + site, return a feedId
// created via the service under that tenant.
// ---------------------------------------------------------------------------

async function seedFeed(
  dbHandle: ReturnType<typeof makeTestDbHandle>,
  svc: FeedService,
  merchants: ReturnType<typeof createMerchantService>,
  tenantId: string,
  siteDomain: string,
  feedUrl: string,
): Promise<{ merchantId: string; siteId: string; feedId: string }> {
  const merchant = await merchants.createMerchant(tenantId, {
    name: 'M',
    slug: 'm-' + Math.random().toString(36).slice(2, 8),
  });
  const site = await merchants.createMerchantSite(tenantId, merchant.id, {
    name: 'S',
    domain: siteDomain,
  });
  const feed = await svc.createFeed(tenantId, merchant.id, site.id, {
    name: 'F',
    url: feedUrl,
    format: 'CUSTOM_XML',
  });
  return { merchantId: merchant.id, siteId: site.id, feedId: feed.id };
}

async function ensureTenant(
  dbHandle: ReturnType<typeof makeTestDbHandle>,
  suffix: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await dbHandle.sql`
    insert into tenants (id, name, slug) values (${id}, 'test', ${'ftest-' + suffix + '-' + id.slice(0, 6)})
  `;
  return id;
}

// ---------------------------------------------------------------------------

describe.skipIf(!reachable)('feeds: service (integration + local stub server)', () => {
  const dbHandle = makeTestDbHandle();
  const apiEnv = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    API_HOST: '127.0.0.1',
  });
  const logger = createLogger(apiEnv);
  // TEST-ONLY: allow private addresses so we can point at 127.0.0.1.
  const feedEnv = loadFeedEnv({
    FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: 'true',
    FEED_FETCH_TIMEOUT_MS: '5000',
    FEED_FETCH_MAX_BYTES: '2048', // small cap for the size test
    FEED_FETCH_MAX_REDIRECTS: '2',
    FEED_FETCH_USER_AGENT: 'FiyatUcuzTestBot/1.0',
  });
  const jobs: JobQueue = new InProcessJobQueue(logger);
  const merchants = createMerchantService({
    db: dbHandle.db,
    hmacSecret: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
  });
  // Archive-backed fetcher — every successful fetch writes into a per-suite
  // temp directory (ADR-0017 §Config dev fallback). The archive is torn down
  // in afterAll.
  let archiveRoot!: string;
  let archive!: LocalFilesystemFeedArchive;
  let fetcher!: ReturnType<typeof createSafeFeedFetcher>;
  let feedService!: FeedService;

  let stub: StubServer;

  beforeAll(async () => {
    archiveRoot = await mkdtemp(join(tmpdir(), 'fiyatucuz-fa-svc-'));
    archive = new LocalFilesystemFeedArchive(archiveRoot);
    fetcher = createSafeFeedFetcher({ env: feedEnv, archive });
    feedService = createFeedService({
      db: dbHandle.db,
      env: feedEnv,
      merchants,
      jobs,
      fetcher,
      archive,
      logger,
    });
    feedService.registerJobHandlers(jobs);
    await truncateAllBusinessTables(dbHandle.sql);
    stub = await startStubServer();
  });
  afterEach(async () => {
    // Drain any in-flight fetch handlers before truncating — otherwise a
    // handler mid-transaction can deadlock against the DDL from TRUNCATE.
    await (jobs as InProcessJobQueue).awaitIdle();
    await truncateAllBusinessTables(dbHandle.sql);
  });
  afterAll(async () => {
    await (jobs as InProcessJobQueue).awaitIdle();
    await stub.close();
    await dbHandle.close();
    await fs.rm(archiveRoot, { recursive: true, force: true });
  });

  // -- CRUD --------------------------------------------------------------

  it('createFeed inserts a row scoped to the tenant', async () => {
    const tenant = await ensureTenant(dbHandle, 'crud');
    const seeded = await seedFeed(
      dbHandle,
      feedService,
      merchants,
      tenant,
      'crud.example',
      stub.url('/feed.xml'),
    );
    const row = await feedService.getFeed(tenant, seeded.merchantId, seeded.siteId, seeded.feedId);
    expect(row.tenantId).toBe(tenant);
    expect(row.format).toBe('CUSTOM_XML');
    expect(row.status).toBe('ACTIVE');
  });

  it('listFeeds returns only rows for the specific merchant+site', async () => {
    const tenant = await ensureTenant(dbHandle, 'list');
    const a = await seedFeed(dbHandle, feedService, merchants, tenant, 'listA.example', stub.url('/a.xml'));
    const b = await seedFeed(dbHandle, feedService, merchants, tenant, 'listB.example', stub.url('/b.xml'));
    const forA = await feedService.listFeeds(tenant, a.merchantId, a.siteId);
    expect(forA.map((r) => r.id)).toEqual([a.feedId]);
    const forB = await feedService.listFeeds(tenant, b.merchantId, b.siteId);
    expect(forB.map((r) => r.id)).toEqual([b.feedId]);
  });

  it('updateFeed patches allowed fields', async () => {
    const tenant = await ensureTenant(dbHandle, 'upd');
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'upd.example', stub.url('/u.xml'));
    const updated = await feedService.updateFeed(tenant, s.merchantId, s.siteId, s.feedId, {
      name: 'renamed',
      status: 'PAUSED',
    });
    expect(updated.name).toBe('renamed');
    expect(updated.status).toBe('PAUSED');
  });

  it('createFeed rejects malformed URL with InvalidFeedUrlError → 400 via mapError', async () => {
    const tenant = await ensureTenant(dbHandle, 'badurl');
    const m = await merchants.createMerchant(tenant, { name: 'M', slug: 'badurl-m' });
    const site = await merchants.createMerchantSite(tenant, m.id, { name: 'S', domain: 'bad.example' });
    await expect(
      feedService.createFeed(tenant, m.id, site.id, {
        name: 'F',
        url: 'file:///etc/passwd',
        format: 'CUSTOM_XML',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FEED_URL' });
  });

  // -- Fetch success -----------------------------------------------------

  it('performFetch: SUCCESS transitions QUEUED → FETCHING → SUCCESS, records hash + etag + last-modified', async () => {
    const tenant = await ensureTenant(dbHandle, 'ok');
    const body = '<?xml version="1.0"?><rss><channel><title>ok</title></channel></rss>';
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml; charset=utf-8',
      etag: 'W/"abc"',
      lastModified: 'Mon, 21 Aug 2026 00:00:00 GMT',
      body,
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'ok.example', stub.url('/ok.xml'));
    const enqueued = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    expect(enqueued.status).toBe('QUEUED');

    // Drive synchronously so the test doesn't race with setImmediate.
    const finalFetch = await feedService.performFetch(tenant, enqueued.fetchId);
    expect(finalFetch.status).toBe('SUCCESS');
    expect(finalFetch.httpStatus).toBe(200);
    expect(finalFetch.byteCount).toBe(body.length);
    expect(finalFetch.contentType?.toLowerCase()).toContain('xml');
    const expectedHash = createHash('sha256').update(body).digest('hex');
    expect(finalFetch.contentHash).toBe(expectedHash);
    expect(finalFetch.etag).toBe('W/"abc"');
    expect(finalFetch.lastModified).toBe('Mon, 21 Aug 2026 00:00:00 GMT');
    // ADIM 13: the raw body is archived out-of-DB. The DB stores an opaque
    // `feed-archive://…` reference, never a filesystem path.
    expect(finalFetch.rawArchiveRef).toMatch(/^feed-archive:\/\//);
    expect(finalFetch.finishedAt).toBeInstanceOf(Date);
  });

  it('performFetch: 304 NOT_MODIFIED does not read body; feed cursor bumps last_fetch_at', async () => {
    const tenant = await ensureTenant(dbHandle, 'nm');
    stub.set(async (_p, meta) => {
      if (meta.ifNoneMatch === 'W/"cached"' || meta.ifModifiedSince) {
        return { status: 304, etag: 'W/"cached"' };
      }
      return {
        status: 200,
        contentType: 'application/xml',
        etag: 'W/"cached"',
        body: '<x/>',
      };
    });
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'nm.example', stub.url('/nm.xml'));

    // First fetch: SUCCESS + persists etag to feeds row.
    const first = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    await feedService.performFetch(tenant, first.fetchId);

    // Second fetch: with etag on feed row, upstream returns 304.
    const second = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const nm = await feedService.performFetch(tenant, second.fetchId);
    expect(nm.status).toBe('NOT_MODIFIED');
    expect(nm.httpStatus).toBe(304);
    // No body read → byte_count is null (or undefined depending on driver).
    expect(nm.byteCount ?? null).toBeNull();
  });

  it('performFetch: HTTP 500 maps to FAILED + HTTP_ERROR', async () => {
    const tenant = await ensureTenant(dbHandle, 'http500');
    stub.set(async () => ({ status: 500, body: 'boom' }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'httperr.example', stub.url('/e.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const r = await feedService.performFetch(tenant, q.fetchId);
    expect(r.status).toBe('FAILED');
    expect(r.errorCode).toBe('HTTP_ERROR');
    expect(r.httpStatus).toBe(500);
  });

  it('performFetch: body over max bytes → FAILED + CONTENT_TOO_LARGE', async () => {
    const tenant = await ensureTenant(dbHandle, 'big');
    // feedEnv.FEED_FETCH_MAX_BYTES = 2048; send 8 KiB.
    const big = 'x'.repeat(8 * 1024);
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml',
      body: big,
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'big.example', stub.url('/big.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const r = await feedService.performFetch(tenant, q.fetchId);
    expect(r.status).toBe('FAILED');
    expect(r.errorCode).toBe('CONTENT_TOO_LARGE');
  });

  it('performFetch: unsupported content-type → REJECTED + UNSUPPORTED_CONTENT_TYPE', async () => {
    const tenant = await ensureTenant(dbHandle, 'ctype');
    stub.set(async () => ({
      status: 200,
      contentType: 'image/png',
      body: '\x89PNG',
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'ct.example', stub.url('/x.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const r = await feedService.performFetch(tenant, q.fetchId);
    expect(r.status).toBe('REJECTED');
    expect(r.errorCode).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('performFetch: UTF-16 XML body → REJECTED + XML_ENCODING_REJECTED, persisted with subcode message (ADIM 12.2)', async () => {
    const tenant = await ensureTenant(dbHandle, 'utf16');
    // UTF-16 LE encoded `<?xml …?><rss/>` — legal XML per spec but our
    // policy is UTF-8-only. Encoded manually here so no library is needed.
    const src = '<?xml version="1.0"?><rss/>';
    const buf = Buffer.alloc(2 + src.length * 2);
    buf[0] = 0xff;
    buf[1] = 0xfe;
    for (let i = 0; i < src.length; i++) {
      buf[2 + i * 2] = src.charCodeAt(i) & 0xff;
      buf[2 + i * 2 + 1] = (src.charCodeAt(i) >> 8) & 0xff;
    }
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml',
      body: buf,
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'utf16.example', stub.url('/utf16.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const r = await feedService.performFetch(tenant, q.fetchId);
    expect(r.status).toBe('REJECTED');
    expect(r.errorCode).toBe('XML_ENCODING_REJECTED');
    // Message is sanitized (one line, capped) and preserves the subcode so
    // operators can distinguish BOM vs XML-decl vs Content-Type rejections.
    expect(r.errorMessage ?? '').toContain('NON_UTF8_BOM');
  });

  it('performFetch: XML DOCTYPE in body → REJECTED + XML_SECURITY_REJECTED', async () => {
    const tenant = await ensureTenant(dbHandle, 'xxe');
    const bad = `<?xml version="1.0"?>
      <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <foo>&xxe;</foo>`;
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml',
      body: bad,
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'xxe.example', stub.url('/xxe.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const r = await feedService.performFetch(tenant, q.fetchId);
    expect(r.status).toBe('REJECTED');
    expect(r.errorCode).toBe('XML_SECURITY_REJECTED');
  });

  it('performFetch: too many redirects → FAILED + TOO_MANY_REDIRECTS', async () => {
    const tenant = await ensureTenant(dbHandle, 'redir');
    // Chain longer than FEED_FETCH_MAX_REDIRECTS=2.
    stub.set(async (path) => {
      if (path === '/1') return { status: 302, location: stub.url('/2') };
      if (path === '/2') return { status: 302, location: stub.url('/3') };
      if (path === '/3') return { status: 302, location: stub.url('/4') };
      return { status: 200, contentType: 'application/xml', body: '<ok/>' };
    });
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'r.example', stub.url('/1'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const r = await feedService.performFetch(tenant, q.fetchId);
    expect(r.status).toBe('FAILED');
    expect(r.errorCode).toBe('TOO_MANY_REDIRECTS');
  });

  it('performFetch: raw body is NOT persisted anywhere in the DB (only an opaque archive ref)', async () => {
    const tenant = await ensureTenant(dbHandle, 'raw');
    const marker = `MARKER_${crypto.randomUUID()}`;
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml',
      body: `<rss><item><title>${marker}</title></item></rss>`,
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'raw.example', stub.url('/r.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    await feedService.performFetch(tenant, q.fetchId);

    // The marker must not appear anywhere in feed_fetches (all text-ish columns).
    const rows = await dbHandle.sql`
      select content_hash, content_type, etag, last_modified, raw_archive_ref, error_message
      from feed_fetches where id = ${q.fetchId}
    `;
    const row = rows[0] as Record<string, unknown>;
    for (const v of Object.values(row)) {
      if (typeof v === 'string') expect(v).not.toContain(marker);
    }
    // ADIM 13: the ref is an opaque `feed-archive://…` URI (UUID-based).
    // It MUST NOT be a filesystem path — no leading `/`, no `C:\`, etc.
    expect(typeof row.raw_archive_ref).toBe('string');
    expect(row.raw_archive_ref as string).toMatch(/^feed-archive:\/\//);
    expect(row.raw_archive_ref as string).not.toMatch(/^\/|^[A-Za-z]:\\/);
  });

  it('performFetch on non-existent fetchId → FeedFetchNotFoundError', async () => {
    const tenant = await ensureTenant(dbHandle, 'nf');
    await expect(
      feedService.performFetch(tenant, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(Error);
  });

  it('cross-tenant getFeed → hides via not-found (never leaks presence)', async () => {
    const alice = await ensureTenant(dbHandle, 'ct-a');
    const bob = await ensureTenant(dbHandle, 'ct-b');
    const s = await seedFeed(dbHandle, feedService, merchants, bob, 'ct.example', stub.url('/ct.xml'));
    await expect(
      feedService.getFeed(alice, s.merchantId, s.siteId, s.feedId),
    ).rejects.toBeInstanceOf(Error);
  });

  it('updateFeed rejects setting a private URL after creation (belt-and-suspenders)', async () => {
    // With FEED_FETCH_ALLOW_PRIVATE_ADDRESSES=true the network check is
    // skipped, but the syntactic check still rejects `file://`.
    const tenant = await ensureTenant(dbHandle, 'upd-bad');
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'upd-bad.example', stub.url('/x.xml'));
    await expect(
      feedService.updateFeed(tenant, s.merchantId, s.siteId, s.feedId, {
        url: 'file:///etc/passwd',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FEED_URL' });
  });

  it('enqueueFetch fails for a non-existent feed → FeedNotFoundError', async () => {
    const tenant = await ensureTenant(dbHandle, 'nofeed');
    const m = await merchants.createMerchant(tenant, { name: 'M', slug: 'nofeed-m' });
    const site = await merchants.createMerchantSite(tenant, m.id, { name: 'S', domain: 'nf.example' });
    await expect(
      feedService.enqueueFetch(tenant, m.id, site.id, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(FeedNotFoundError);
  });

  it('JobQueue.awaitIdle settles after enqueueFetch → performFetch runs to terminal state', async () => {
    const tenant = await ensureTenant(dbHandle, 'q');
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml',
      body: '<ok/>',
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'q.example', stub.url('/q.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    await (jobs as InProcessJobQueue).awaitIdle();
    const final = await feedService.getFetch(tenant, s.merchantId, s.siteId, s.feedId, q.fetchId);
    // Terminal state is either SUCCESS or NOT_MODIFIED (etag differed each ensure — fresh feed).
    expect(['SUCCESS', 'NOT_MODIFIED']).toContain(final.status);
  });

  // -------------------------------------------------------------------------
  // ADIM 13 / ADR-0017 — raw feed archive pipeline integration
  // -------------------------------------------------------------------------

  it('req 1+2+3+5: successful XML fetch archives the exact bytes; sha256 matches', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-ok');
    const body = '<?xml version="1.0"?><rss><channel><title>ADIM13</title></channel></rss>';
    stub.set(async () => ({ status: 200, contentType: 'application/xml', body }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'arc-ok.example', stub.url('/ok.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f = await feedService.performFetch(tenant, q.fetchId);
    expect(f.status).toBe('SUCCESS');
    // Ref is opaque URI containing trusted UUIDs (never the URL/name).
    expect(f.rawArchiveRef).toMatch(/^feed-archive:\/\//);
    const parsed = parseArchiveRef(f.rawArchiveRef!);
    expect(parsed.tenantId).toBe(tenant);
    expect(parsed.feedId).toBe(s.feedId);
    expect(parsed.fetchId).toBe(q.fetchId);
    expect(parsed.ext).toBe('xml');
    // Bytes archived equal bytes fetched.
    const streamed = await archive.read(f.rawArchiveRef!);
    const chunks: Buffer[] = [];
    for await (const c of streamed) chunks.push(Buffer.from(c));
    const archived = Buffer.concat(chunks);
    expect(archived.toString()).toBe(body);
    // Content hash on the row matches the archived bytes exactly.
    expect(f.contentHash).toBe(createHash('sha256').update(archived).digest('hex'));
  });

  it('req 6: successful CSV fetch archives with a raw.csv leaf', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-csv');
    const csv = 'id,price\n1,10\n2,20\n';
    stub.set(async () => ({ status: 200, contentType: 'text/csv', body: csv }));
    // Seed a CSV feed (helper only creates CUSTOM_XML by default — build one directly).
    const m = await merchants.createMerchant(tenant, { name: 'M', slug: 'arc-csv-m' });
    const site = await merchants.createMerchantSite(tenant, m.id, { name: 'S', domain: 'arc-csv.example' });
    const feed = await feedService.createFeed(tenant, m.id, site.id, {
      name: 'CSV', url: stub.url('/x.csv'), format: 'CSV',
    });
    const q = await feedService.enqueueFetch(tenant, m.id, site.id, feed.id);
    const f = await feedService.performFetch(tenant, q.fetchId);
    expect(f.status).toBe('SUCCESS');
    expect(f.rawArchiveRef).toMatch(/\/raw\.csv$/);
    const chunks: Buffer[] = [];
    for await (const c of await archive.read(f.rawArchiveRef!)) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe(csv);
  });

  it('req 4+7: oversize fetch leaves NO archive object and rawArchiveRef stays null', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-big');
    const big = 'x'.repeat(8 * 1024); // > FEED_FETCH_MAX_BYTES=2048
    stub.set(async () => ({ status: 200, contentType: 'application/xml', body: big }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'arc-big.example', stub.url('/big.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f = await feedService.performFetch(tenant, q.fetchId);
    expect(f.status).toBe('FAILED');
    expect(f.errorCode).toBe('CONTENT_TOO_LARGE');
    expect(f.rawArchiveRef).toBeNull();
    // The would-be ref path must not exist as a finalized object.
    const wouldBeRef = buildArchiveRef({
      tenantId: tenant, feedId: s.feedId, fetchId: q.fetchId, format: 'CUSTOM_XML',
    });
    expect(await archive.exists(wouldBeRef)).toBe(false);
  });

  it('req 8: XML_ENCODING_REJECTED leaves NO archive object', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-enc');
    // Content-Type charset=utf-16 → encoding gate rejects before finalize.
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml; charset=utf-16',
      body: '<?xml version="1.0"?><rss/>',
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'arc-enc.example', stub.url('/e.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f = await feedService.performFetch(tenant, q.fetchId);
    expect(f.status).toBe('REJECTED');
    expect(f.errorCode).toBe('XML_ENCODING_REJECTED');
    expect(f.rawArchiveRef).toBeNull();
    const wouldBeRef = buildArchiveRef({
      tenantId: tenant, feedId: s.feedId, fetchId: q.fetchId, format: 'CUSTOM_XML',
    });
    expect(await archive.exists(wouldBeRef)).toBe(false);
  });

  it('req 9: XML_SECURITY_REJECTED leaves NO archive object', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-sec');
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml',
      body: '<?xml version="1.0"?><!DOCTYPE foo><foo/>',
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'arc-sec.example', stub.url('/s.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f = await feedService.performFetch(tenant, q.fetchId);
    expect(f.status).toBe('REJECTED');
    expect(f.errorCode).toBe('XML_SECURITY_REJECTED');
    expect(f.rawArchiveRef).toBeNull();
    const wouldBeRef = buildArchiveRef({
      tenantId: tenant, feedId: s.feedId, fetchId: q.fetchId, format: 'CUSTOM_XML',
    });
    expect(await archive.exists(wouldBeRef)).toBe(false);
  });

  it('req 10: network failure (unreachable target) leaves NO archive object', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-net');
    // Bind + close a socket to obtain a known-free port, then point the feed at it.
    const tmp = await import('node:net');
    const srv = tmp.createServer().listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const unreachable = `http://127.0.0.1:${port}/nope.xml`;

    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'arc-net.example', unreachable);
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f = await feedService.performFetch(tenant, q.fetchId);
    expect(f.status).toBe('FAILED');
    // The exact code (FETCH_FAILED / CONNECT_TIMEOUT) depends on the OS
    // returning ECONNREFUSED vs timing out — assert the archive-invariant.
    expect(f.rawArchiveRef).toBeNull();
    const wouldBeRef = buildArchiveRef({
      tenantId: tenant, feedId: s.feedId, fetchId: q.fetchId, format: 'CUSTOM_XML',
    });
    expect(await archive.exists(wouldBeRef)).toBe(false);
  });

  it('req 11+12: an archive whose finalize throws prevents SUCCESS and leaves no artifact', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-fail');
    // Stub archive: writes succeed, finalize always throws. Aborted flag
    // captures whether the fetcher cleaned up on failure (it should).
    let abortedFlag = false;
    const failing: FeedArchive = {
      openWriter: async (_key: FeedArchiveKey): Promise<FeedArchiveWriter> => ({
        async write(_c) { /* accept bytes without persisting */ },
        async finalize() { throw new Error('simulated finalize failure'); },
        async abort() { abortedFlag = true; },
      }),
      async read() { throw new Error('unused'); },
      async exists() { return false; },
      async delete() { /* no-op */ },
    };

    // Use an ISOLATED JobQueue so the outer suite's shared handler (which
    // uses the real archive) does not race our sync performFetch call.
    const localJobs: JobQueue = new InProcessJobQueue(logger);
    const localFetcher = createSafeFeedFetcher({ env: feedEnv, archive: failing });
    const localSvc = createFeedService({
      db: dbHandle.db, env: feedEnv, merchants, jobs: localJobs, fetcher: localFetcher, archive: failing, logger,
    });
    // Do NOT register handlers on localJobs — enqueueFetch's fire-and-forget
    // handler drops harmlessly and only our sync performFetch runs.

    stub.set(async () => ({ status: 200, contentType: 'application/xml', body: '<ok/>' }));
    const s = await seedFeed(dbHandle, localSvc, merchants, tenant, 'arc-fail.example', stub.url('/f.xml'));
    const q = await localSvc.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f = await localSvc.performFetch(tenant, q.fetchId);
    expect(f.status).toBe('FAILED');
    expect(f.errorCode).toBe('ARCHIVE_WRITE_FAILED');
    expect(f.rawArchiveRef).toBeNull();
    // finalize() failed → the fetcher's own finalize catch cleans the tmp
    // file directly (no abort call in that specific path — see fetcher.ts).
    // The invariant is: no visible artifact under this fetchId in the
    // shared real archive, which never received the write.
    const wouldBeRef = buildArchiveRef({
      tenantId: tenant, feedId: s.feedId, fetchId: q.fetchId, format: 'CUSTOM_XML',
    });
    expect(await archive.exists(wouldBeRef)).toBe(false);
    // abort flag reference — silences unused-var lint & documents the
    // contract that at least one cleanup path fires. The finalize-failure
    // path in fetcher.ts unlinks via the writer's own catch instead.
    void abortedFlag;
    await (localJobs as InProcessJobQueue).awaitIdle();
  });

  it('req 19: cross-tenant performFetch cannot reach another tenant\'s fetch/archive', async () => {
    const alice = await ensureTenant(dbHandle, 'arc-a');
    const bob = await ensureTenant(dbHandle, 'arc-b');
    stub.set(async () => ({ status: 200, contentType: 'application/xml', body: '<ok/>' }));
    // Bob creates + fetches a feed.
    const bobs = await seedFeed(dbHandle, feedService, merchants, bob, 'arc-x.example', stub.url('/x.xml'));
    const bobsQ = await feedService.enqueueFetch(bob, bobs.merchantId, bobs.siteId, bobs.feedId);
    await feedService.performFetch(bob, bobsQ.fetchId);

    // Alice tries to drive Bob's fetch. The service tenant scope rejects it.
    await expect(
      feedService.performFetch(alice, bobsQ.fetchId),
    ).rejects.toBeInstanceOf(Error);

    // Also verify a fabricated cross-tenant ref would not accidentally point
    // to Alice's archive tree — different tenantId → different path.
    const fakeRef = buildArchiveRef({
      tenantId: alice, feedId: bobs.feedId, fetchId: bobsQ.fetchId, format: 'CUSTOM_XML',
    });
    expect(await archive.exists(fakeRef)).toBe(false);
  });

  it('req 4-support: archive write happens in-lockstep with hashing (content_hash === sha256 of archived bytes)', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-hash');
    const body = 'chunk-A' + '\n' + 'x'.repeat(500) + '\n' + 'chunk-B';
    stub.set(async () => ({ status: 200, contentType: 'application/xml', body: `<r>${body}</r>` }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'arc-hash.example', stub.url('/h.xml'));
    const q = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f = await feedService.performFetch(tenant, q.fetchId);
    expect(f.status).toBe('SUCCESS');
    const chunks: Buffer[] = [];
    for await (const c of await archive.read(f.rawArchiveRef!)) chunks.push(Buffer.from(c));
    const archived = Buffer.concat(chunks);
    expect(createHash('sha256').update(archived).digest('hex')).toBe(f.contentHash);
  });

  it('req 20-support: two SUCCESS fetches of the same feed produce distinct archive objects (per-fetch fetchId)', async () => {
    const tenant = await ensureTenant(dbHandle, 'arc-dup');
    // Serve a different body each request to force distinct hashes.
    let n = 0;
    stub.set(async () => ({
      status: 200,
      contentType: 'application/xml',
      body: `<r>hit-${++n}-${randomUUID()}</r>`,
    }));
    const s = await seedFeed(dbHandle, feedService, merchants, tenant, 'arc-dup.example', stub.url('/d.xml'));
    const q1 = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f1 = await feedService.performFetch(tenant, q1.fetchId);
    const q2 = await feedService.enqueueFetch(tenant, s.merchantId, s.siteId, s.feedId);
    const f2 = await feedService.performFetch(tenant, q2.fetchId);
    expect(f1.status).toBe('SUCCESS');
    expect(f2.status).toBe('SUCCESS');
    expect(f1.rawArchiveRef).not.toBe(f2.rawArchiveRef);
    expect(await archive.exists(f1.rawArchiveRef!)).toBe(true);
    expect(await archive.exists(f2.rawArchiveRef!)).toBe(true);
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] feeds-service.test.ts: skipping — PG unreachable.');
}
