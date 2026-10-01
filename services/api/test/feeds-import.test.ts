import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withTenantTransaction } from '@fiyatucuz/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadApiEnv } from '../src/config/env.js';
import { InProcessJobQueue } from '../src/lib/jobs/InProcessJobQueue.js';
import { createLogger } from '../src/lib/logger.js';
import {
  createFeedService,
  feedImportsRepository,
  feedsRepository,
  loadFeedEnv,
  LocalFilesystemFeedArchive,
  type FeedFormat,
  type FeedImportRow,
  type FeedItemMappingInput,
  type FeedService,
} from '../src/modules/feeds/index.js';
import { createMerchantService } from '../src/modules/merchants/index.js';
import { offersRepository, type MerchantOfferRow } from '../src/modules/offers/index.js';

import { isPostgresReachable, makeTestDbHandle, truncateAllBusinessTables } from './helpers.js';

const reachable = await isPostgresReachable();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SITE_DOMAIN = 'shop.example.com';

const MAPPING: FeedItemMappingInput = {
  itemElement: 'urun',
  fields: {
    externalId: 'kod',
    title: 'ad',
    price: 'fiyat',
    url: 'link',
    sku: 'sku',
    gtin: 'barkod',
    image: 'resim',
  },
  defaultCurrency: 'TRY',
  decimalSeparator: ',',
};

interface ItemSpec {
  readonly kod?: string;
  readonly ad?: string;
  readonly fiyat?: string;
  readonly link?: string;
  readonly sku?: string;
  readonly barkod?: string;
  readonly resim?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function item(kod: string, over: Partial<ItemSpec> = {}): ItemSpec {
  return {
    kod,
    ad: `Ürün ${kod} — Çok Şık`,
    fiyat: '1.299,90',
    link: `https://${SITE_DOMAIN}/p/${kod}`,
    ...over,
  };
}

function doc(items: readonly ItemSpec[]): string {
  const body = items
    .map((i) => {
      const fields = Object.entries(i)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`)
        .join('');
      return `<urun>${fields}</urun>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urunler>\n${body}\n</urunler>\n`;
}

async function ensureTenant(dbHandle: ReturnType<typeof makeTestDbHandle>): Promise<string> {
  const id = randomUUID();
  await dbHandle.sql`
    insert into tenants (id, name, slug) values (${id}, 'test', ${'fimp-' + id.slice(0, 8)})
  `;
  return id;
}

// ---------------------------------------------------------------------------

describe.skipIf(!reachable)('feeds import: normalized merchant offers (integration)', () => {
  const dbHandle = makeTestDbHandle();
  const apiEnv = loadApiEnv({ NODE_ENV: 'test', LOG_LEVEL: 'error', API_HOST: '127.0.0.1' });
  const logger = createLogger(apiEnv);
  const feedEnv = loadFeedEnv({
    FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: 'true',
    FEED_FETCH_TIMEOUT_MS: '5000',
    // Small batches so multi-batch paths (cross-batch duplicates) run.
    FEED_IMPORT_BATCH_SIZE: '2',
    FEED_IMPORT_LEASE_MS: '2000',
  });
  const jobs = new InProcessJobQueue(logger);
  const merchants = createMerchantService({
    db: dbHandle.db,
    hmacSecret: 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx',
  });
  let archiveRoot!: string;
  let archive!: LocalFilesystemFeedArchive;
  let svc!: FeedService;

  interface FeedCtx {
    readonly tenantId: string;
    readonly merchantId: string;
    readonly siteId: string;
    readonly feedId: string;
  }

  async function seedFeed(opts: {
    tenantId?: string;
    merchantId?: string;
    siteId?: string;
    format?: FeedFormat;
    url?: string;
    domain?: string;
  } = {}): Promise<FeedCtx> {
    const tenantId = opts.tenantId ?? (await ensureTenant(dbHandle));
    let merchantId = opts.merchantId;
    let siteId = opts.siteId;
    if (!merchantId) {
      const m = await merchants.createMerchant(tenantId, { name: 'M', slug: 'm-' + randomUUID().slice(0, 8) });
      merchantId = m.id;
    }
    if (!siteId) {
      const s = await merchants.createMerchantSite(tenantId, merchantId, {
        name: 'S',
        domain: opts.domain ?? SITE_DOMAIN,
      });
      siteId = s.id;
    }
    const feed = await svc.createFeed(tenantId, merchantId, siteId, {
      name: 'F',
      url: opts.url ?? 'http://127.0.0.1:9/feed.xml',
      format: opts.format ?? 'CUSTOM_XML',
      itemMapping: MAPPING,
    } as Parameters<FeedService['createFeed']>[3]);
    return { tenantId, merchantId, siteId, feedId: feed.id };
  }

  /** Archive `xml` as a SUCCESS fetch of the feed and queue its import. */
  async function queueImport(ctx: FeedCtx, xml: string): Promise<{ fetchId: string; importId: string }> {
    const fetchId = randomUUID();
    const bytes = new TextEncoder().encode(xml);
    const writer = await archive.openWriter({
      tenantId: ctx.tenantId,
      feedId: ctx.feedId,
      fetchId,
      format: 'CUSTOM_XML',
    });
    await writer.write(bytes);
    const ref = await writer.finalize();
    const importId = await withTenantTransaction(dbHandle.db, ctx.tenantId, async (tx) => {
      await feedsRepository.insertFetch(tx, {
        id: fetchId,
        tenantId: ctx.tenantId,
        feedId: ctx.feedId,
        status: 'SUCCESS',
        httpStatus: 200,
        byteCount: bytes.length,
        contentType: 'application/xml; charset=utf-8',
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        rawArchiveRef: ref,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
      const row = await feedImportsRepository.insertImportIfAbsent(tx, {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        feedId: ctx.feedId,
        fetchId,
      });
      return row!.id;
    });
    return { fetchId, importId };
  }

  async function runImport(ctx: FeedCtx, xml: string): Promise<FeedImportRow> {
    const { importId } = await queueImport(ctx, xml);
    return svc.performImport(ctx.tenantId, importId);
  }

  async function offers(ctx: FeedCtx): Promise<readonly MerchantOfferRow[]> {
    return withTenantTransaction(dbHandle.db, ctx.tenantId, (tx) =>
      offersRepository.listOffersForFeed(tx, ctx.tenantId, ctx.feedId),
    );
  }

  const byId = (rows: readonly MerchantOfferRow[]) => new Map(rows.map((r) => [r.externalId, r]));

  beforeAll(async () => {
    archiveRoot = await mkdtemp(join(tmpdir(), 'fiyatucuz-fa-import-'));
    archive = new LocalFilesystemFeedArchive(archiveRoot);
    svc = createFeedService({ db: dbHandle.db, env: feedEnv, merchants, jobs, archive, logger });
    svc.registerJobHandlers(jobs);
    await truncateAllBusinessTables(dbHandle.sql);
  });
  afterEach(async () => {
    await jobs.awaitIdle();
    await truncateAllBusinessTables(dbHandle.sql);
  });
  afterAll(async () => {
    await jobs.awaitIdle();
    await dbHandle.close();
    await fs.rm(archiveRoot, { recursive: true, force: true });
  });

  // -- happy path -------------------------------------------------------------

  it('valid XML → SUCCESS; Turkish text and bigint minor-unit price persisted', async () => {
    const ctx = await seedFeed();
    const row = await runImport(ctx, doc([item('A'), item('B', { fiyat: '49,90' })]));
    expect(row).toMatchObject({ status: 'SUCCESS', itemsSeen: 2, itemsCreated: 2, itemsRejected: 0 });
    const got = byId(await offers(ctx));
    expect(got.get('A')).toMatchObject({
      title: 'Ürün A — Çok Şık',
      priceMinor: 129990n,
      currency: 'TRY',
      productUrl: `https://${SITE_DOMAIN}/p/A`,
      status: 'ACTIVE',
      lastSeenImportId: row.id,
    });
    expect(typeof got.get('B')!.priceMinor).toBe('bigint');
    expect(got.get('B')!.priceMinor).toBe(4990n);
  });

  it('idempotent: re-importing the same content creates no duplicates and no content change', async () => {
    const ctx = await seedFeed();
    const xml = doc([item('A'), item('B'), item('C')]);
    await runImport(ctx, xml);
    const before = byId(await offers(ctx));
    const second = await runImport(ctx, xml);
    expect(second).toMatchObject({ status: 'SUCCESS', itemsCreated: 0, itemsUpdated: 0, itemsUnchanged: 3 });
    const after = byId(await offers(ctx));
    expect(after.size).toBe(3);
    for (const [id, b] of before) {
      const a = after.get(id)!;
      expect(a.id).toBe(b.id);
      expect(a.contentHash).toBe(b.contentHash);
      expect(a.contentChangedAt.getTime()).toBe(b.contentChangedAt.getTime());
      expect(a.lastSeenImportId).toBe(second.id);
    }
  });

  it('update existing offer: price change updates in place (same row id)', async () => {
    const ctx = await seedFeed();
    await runImport(ctx, doc([item('A')]));
    const [before] = await offers(ctx);
    const row = await runImport(ctx, doc([item('A', { fiyat: '999,00' })]));
    expect(row).toMatchObject({ status: 'SUCCESS', itemsUpdated: 1, itemsCreated: 0 });
    const [after] = await offers(ctx);
    expect(after!.id).toBe(before!.id);
    expect(after!.priceMinor).toBe(99900n);
    expect(after!.contentHash).not.toBe(before!.contentHash);
    expect(after!.contentChangedAt.getTime()).toBeGreaterThanOrEqual(before!.contentChangedAt.getTime());
  });

  // -- deactivation policy (ADR-0018 §Deactivation) ----------------------------

  it('SUCCESS import: previously seen offer missing → INACTIVE (and reactivates when seen again)', async () => {
    const ctx = await seedFeed();
    await runImport(ctx, doc([item('A'), item('B')]));
    const second = await runImport(ctx, doc([item('A')]));
    expect(second).toMatchObject({ status: 'SUCCESS', itemsDeactivated: 1 });
    expect(byId(await offers(ctx)).get('B')!.status).toBe('INACTIVE');

    await runImport(ctx, doc([item('A'), item('B')]));
    expect(byId(await offers(ctx)).get('B')!.status).toBe('ACTIVE');
  });

  it('PARTIAL import: previously seen offer missing → remains ACTIVE', async () => {
    const ctx = await seedFeed();
    await runImport(ctx, doc([item('A'), item('B')]));
    const second = await runImport(ctx, doc([item('A'), item('C', { fiyat: 'bedava' })]));
    expect(second).toMatchObject({ status: 'PARTIAL', itemsRejected: 1, itemsDeactivated: 0 });
    const got = byId(await offers(ctx));
    expect(got.get('B')!.status).toBe('ACTIVE');
    expect(got.has('C')).toBe(false);
  });

  it('FAILED import (malformed XML): previously seen offer missing → remains ACTIVE', async () => {
    const ctx = await seedFeed();
    await runImport(ctx, doc([item('A'), item('B')]));
    const broken = doc([item('A')]).replace('</urunler>', '<urun><kod>X</kod>');
    const second = await runImport(ctx, broken);
    expect(second).toMatchObject({ status: 'FAILED', errorCode: 'XML_MALFORMED', itemsDeactivated: 0 });
    expect(byId(await offers(ctx)).get('B')!.status).toBe('ACTIVE');
  });

  it('archive integrity mismatch → FAILED, nothing written, nothing deactivated', async () => {
    const ctx = await seedFeed();
    await runImport(ctx, doc([item('A'), item('B')]));
    const before = byId(await offers(ctx));

    const { fetchId, importId } = await queueImport(ctx, doc([item('A', { fiyat: '1,00' })]));
    const path = join(archiveRoot, 'tenant', ctx.tenantId, 'feed', ctx.feedId, 'fetch', fetchId, 'raw.xml');
    await fs.writeFile(path, doc([item('A', { fiyat: '2,00' }), item('Z')]));

    const row = await svc.performImport(ctx.tenantId, importId);
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'ARCHIVE_INTEGRITY_MISMATCH', itemsDeactivated: 0 });
    const after = byId(await offers(ctx));
    expect(after.size).toBe(2);
    expect(after.get('A')!.priceMinor).toBe(before.get('A')!.priceMinor);
    expect(after.get('B')!.status).toBe('ACTIVE');
  });

  it('zero valid items → FAILED NO_VALID_ITEMS (never mass-deactivates)', async () => {
    const ctx = await seedFeed();
    await runImport(ctx, doc([item('A')]));
    const row = await runImport(ctx, doc([item('B', { link: 'https://evil.example.org/x' })]));
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'NO_VALID_ITEMS', itemsDeactivated: 0 });
    expect(byId(await offers(ctx)).get('A')!.status).toBe('ACTIVE');
  });

  // -- identity -------------------------------------------------------------------

  it('external_id missing → item rejected; no fallback to SKU', async () => {
    const ctx = await seedFeed();
    const { kod: _kod, ...noIdentity } = item('IGNORED', { sku: 'SKU-9' });
    const row = await runImport(ctx, doc([item('A'), noIdentity]));
    expect(row).toMatchObject({ status: 'PARTIAL', itemsRejected: 1 });
    expect((row.errorSamples as Array<{ code: string }>).map((s) => s.code)).toContain('EXTERNAL_ID_MISSING');
    const got = byId(await offers(ctx));
    expect([...got.keys()]).toEqual(['A']);
    expect(got.has('SKU-9')).toBe(false);
  });

  it('duplicate external_id (across batches) → first occurrence wins, PARTIAL', async () => {
    const ctx = await seedFeed();
    // Batch size 2: A,B flush → A' lands in the next batch.
    const row = await runImport(ctx, doc([item('A'), item('B'), item('A', { fiyat: '1,00' }), item('A', { fiyat: '2,00' })]));
    expect(row).toMatchObject({ status: 'PARTIAL', itemsCreated: 2, itemsRejected: 2 });
    expect((row.errorSamples as Array<{ code: string }>).filter((s) => s.code === 'DUPLICATE_EXTERNAL_ID')).toHaveLength(2);
    const got = byId(await offers(ctx));
    expect(got.size).toBe(2);
    expect(got.get('A')!.priceMinor).toBe(129990n);
  });

  it('same GTIN on multiple offers is allowed (GTIN is not identity)', async () => {
    const ctx = await seedFeed();
    const row = await runImport(ctx, doc([item('A', { barkod: '4006381333931' }), item('B', { barkod: '4006381333931' })]));
    expect(row.status).toBe('SUCCESS');
    const got = await offers(ctx);
    expect(got.map((o) => o.gtin)).toEqual(['04006381333931', '04006381333931']);
  });

  it('same SKU / external id in two feeds (and two merchants) does not collide', async () => {
    const f1 = await seedFeed();
    const f2 = await seedFeed({ tenantId: f1.tenantId, merchantId: f1.merchantId, siteId: f1.siteId });
    // Different merchant + site in the same tenant: domains are unique per
    // tenant, so the second site needs its own domain (and product URLs on it).
    const otherDomain = 'second-shop.example.com';
    const f3 = await seedFeed({ tenantId: f1.tenantId, domain: otherDomain });
    for (const f of [f1, f2]) {
      expect((await runImport(f, doc([item('X', { sku: 'SAME-SKU' })]))).status).toBe('SUCCESS');
    }
    const f3Item = item('X', { sku: 'SAME-SKU', link: `https://${otherDomain}/p/X` });
    expect((await runImport(f3, doc([f3Item]))).status).toBe('SUCCESS');
    const all = [...(await offers(f1)), ...(await offers(f2)), ...(await offers(f3))];
    expect(all).toHaveLength(3);
    expect(new Set(all.map((o) => o.id)).size).toBe(3);
    expect(new Set(all.map((o) => o.feedId)).size).toBe(3);
    expect(all.every((o) => o.sku === 'SAME-SKU' && o.externalId === 'X')).toBe(true);
  });

  // -- URL policies ---------------------------------------------------------------

  it('product URL on a foreign domain → rejected; image on an external CDN → stored', async () => {
    const ctx = await seedFeed();
    const row = await runImport(
      ctx,
      doc([
        item('A', { resim: 'https://cdn.imagehost.net/a.jpg' }),
        item('B', { link: 'https://other-shop.com/p/B' }),
      ]),
    );
    expect(row).toMatchObject({ status: 'PARTIAL', itemsRejected: 1 });
    expect((row.errorSamples as Array<{ code: string }>).map((s) => s.code)).toContain('URL_DOMAIN_MISMATCH');
    const got = byId(await offers(ctx));
    expect(got.get('A')!.imageUrl).toBe('https://cdn.imagehost.net/a.jpg');
    expect(got.has('B')).toBe(false);
  });

  // -- import state / concurrency -------------------------------------------------

  it('a fetch can be imported at most once (UNIQUE fetch_id)', async () => {
    const ctx = await seedFeed();
    const { fetchId } = await queueImport(ctx, doc([item('A')]));
    const again = await withTenantTransaction(dbHandle.db, ctx.tenantId, (tx) =>
      feedImportsRepository.insertImportIfAbsent(tx, {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        feedId: ctx.feedId,
        fetchId,
      }),
    );
    expect(again).toBeNull();
  });

  it('concurrent import attempts on the same import do not duplicate work or rows', async () => {
    const ctx = await seedFeed();
    const { importId } = await queueImport(ctx, doc([item('A'), item('B'), item('C')]));
    const [r1, r2, r3] = await Promise.all([
      svc.performImport(ctx.tenantId, importId),
      svc.performImport(ctx.tenantId, importId),
      svc.performImport(ctx.tenantId, importId),
    ]);
    for (const r of [r1, r2, r3]) {
      expect(r).toMatchObject({ id: importId, status: 'SUCCESS', itemsCreated: 3 });
    }
    expect(await offers(ctx)).toHaveLength(3);
    // Re-running a terminal import is a no-op.
    expect((await svc.performImport(ctx.tenantId, importId)).itemsCreated).toBe(3);
  });

  it('PROCESSING import with an expired lease is taken over (never stuck forever)', async () => {
    const ctx = await seedFeed();
    const { importId } = await queueImport(ctx, doc([item('A')]));
    await dbHandle.sql`
      update feed_imports
         set status = 'PROCESSING', claim_token = ${randomUUID()},
             lease_expires_at = now() - interval '1 minute', started_at = now()
       where id = ${importId}
    `;
    const row = await svc.performImport(ctx.tenantId, importId);
    expect(row.status).toBe('SUCCESS');
    expect(await offers(ctx)).toHaveLength(1);
  });

  // -- H1: a crashed import must not block the feed's later imports -------------

  async function markProcessing(importId: string, token: string, leaseExpired: boolean): Promise<void> {
    await dbHandle.sql`
      update feed_imports
         set status = 'PROCESSING', claim_token = ${token}, started_at = now(),
             lease_expires_at = now() + ${leaseExpired ? '-1 minute' : '1 hour'}::interval
       where id = ${importId}
    `;
  }

  async function importRow(ctx: FeedCtx, importId: string): Promise<FeedImportRow> {
    const row = await withTenantTransaction(dbHandle.db, ctx.tenantId, (tx) =>
      feedImportsRepository.findImportById(tx, ctx.tenantId, importId),
    );
    return row!;
  }

  it('H1-A: expired PROCESSING import A is closed LEASE_EXPIRED when import B of the same feed runs', async () => {
    const ctx = await seedFeed();
    const a = await queueImport(ctx, doc([item('A1')]));
    const b = await queueImport(ctx, doc([item('B1'), item('B2')]));
    await markProcessing(a.importId, randomUUID(), true);

    const rowB = await svc.performImport(ctx.tenantId, b.importId);
    expect(rowB).toMatchObject({ status: 'SUCCESS', itemsCreated: 2 });

    const rowA = await importRow(ctx, a.importId);
    expect(rowA).toMatchObject({ status: 'FAILED', errorCode: 'LEASE_EXPIRED', itemsDeactivated: 0, leaseExpiresAt: null });
    expect(rowA.finishedAt).toBeInstanceOf(Date);
  });

  it('H1-B: a LIVE lease is never touched and B never runs concurrently with it', async () => {
    const ctx = await seedFeed();
    const a = await queueImport(ctx, doc([item('A1')]));
    const b = await queueImport(ctx, doc([item('B1')]));
    const tokenA = randomUUID();
    await markProcessing(a.importId, tokenA, false);
    const before = await importRow(ctx, a.importId);

    // B waits for the feed (FEED_IMPORT_LEASE_MS = 2 s in this suite), then gives up.
    const rowB = await svc.performImport(ctx.tenantId, b.importId);
    expect(rowB.status).toBe('QUEUED');

    const after = await importRow(ctx, a.importId);
    expect(after).toMatchObject({ status: 'PROCESSING', claimToken: tokenA, errorCode: null });
    expect(after.leaseExpiresAt!.getTime()).toBe(before.leaseExpiresAt!.getTime());
    expect(await offers(ctx)).toHaveLength(0);
  });

  it('H1-C: the expired owner can neither heartbeat nor finalize, and cannot deactivate offers', async () => {
    const ctx = await seedFeed();
    await runImport(ctx, doc([item('KEEP'), item('OTHER')]));
    const a = await queueImport(ctx, doc([item('KEEP')]));
    const b = await queueImport(ctx, doc([item('KEEP'), item('OTHER')]));
    const staleToken = randomUUID();
    await markProcessing(a.importId, staleToken, true);
    expect((await svc.performImport(ctx.tenantId, b.importId)).status).toBe('SUCCESS');
    expect((await importRow(ctx, a.importId)).errorCode).toBe('LEASE_EXPIRED');

    const counters = {
      itemsSeen: 1,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 1,
      itemsRejected: 0,
      itemsWarned: 0,
    };
    const alive = await withTenantTransaction(dbHandle.db, ctx.tenantId, (tx) =>
      feedImportsRepository.heartbeatImport(tx, ctx.tenantId, a.importId, staleToken, new Date(Date.now() + 60_000), counters),
    );
    expect(alive).toBe(false);

    // The importer's SUCCESS finalize transaction: deactivate, then finalize
    // guarded by the claim token; a null finalize rolls the deactivation back.
    await expect(
      withTenantTransaction(dbHandle.db, ctx.tenantId, async (tx) => {
        await offersRepository.deactivateUnseenOffers(tx, ctx.tenantId, ctx.feedId, a.importId);
        const finalized = await feedImportsRepository.finalizeImport(tx, ctx.tenantId, a.importId, staleToken, {
          status: 'SUCCESS',
          finishedAt: new Date(),
          counters,
          itemsDeactivated: 1,
          errorCode: null,
          errorMessage: null,
          errorSamples: [],
        });
        if (!finalized) throw new Error('lease lost');
      }),
    ).rejects.toThrow('lease lost');

    expect((await importRow(ctx, a.importId))).toMatchObject({ status: 'FAILED', errorCode: 'LEASE_EXPIRED' });
    const got = byId(await offers(ctx));
    expect(got.get('OTHER')!.status).toBe('ACTIVE');
    expect(got.get('KEEP')!.status).toBe('ACTIVE');
  });

  it('H1-D: an expired import of ANOTHER feed is not touched', async () => {
    const f1 = await seedFeed();
    const f2 = await seedFeed({ tenantId: f1.tenantId, merchantId: f1.merchantId, siteId: f1.siteId });
    const stale = await queueImport(f2, doc([item('X')]));
    const token = randomUUID();
    await markProcessing(stale.importId, token, true);

    expect((await runImport(f1, doc([item('A')]))).status).toBe('SUCCESS');
    expect(await importRow(f2, stale.importId)).toMatchObject({ status: 'PROCESSING', claimToken: token, errorCode: null });
  });

  it('H1-E: two new imports racing to recover an expired import keep the invariants', async () => {
    const ctx = await seedFeed();
    const a = await queueImport(ctx, doc([item('A')]));
    const b = await queueImport(ctx, doc([item('B')]));
    const c = await queueImport(ctx, doc([item('C')]));
    await markProcessing(a.importId, randomUUID(), true);

    const [rowB, rowC] = await Promise.all([
      svc.performImport(ctx.tenantId, b.importId),
      svc.performImport(ctx.tenantId, c.importId),
    ]);

    expect(await importRow(ctx, a.importId)).toMatchObject({ status: 'FAILED', errorCode: 'LEASE_EXPIRED' });
    // The newest import always lands; the older one either ran first or was superseded.
    expect(rowC.status).toBe('SUCCESS');
    expect(['SUCCESS', 'FAILED']).toContain(rowB.status);
    if (rowB.status === 'FAILED') expect(rowB.errorCode).toBe('SUPERSEDED');
    const processing = await dbHandle.sql<Array<{ n: number }>>`
      select count(*)::int as n from feed_imports where feed_id = ${ctx.feedId} and status = 'PROCESSING'
    `;
    expect(processing[0]?.n).toBe(0);
    const got = byId(await offers(ctx));
    expect(got.get('C')!.status).toBe('ACTIVE');
    if (got.has('B')) expect(got.get('B')!.status).toBe('INACTIVE');
  });

  it('takeover after a crashed attempt wrote a batch → SUCCESS (rows not mistaken for duplicates)', async () => {
    const ctx = await seedFeed();
    await runImport(ctx, doc([item('A'), item('B'), item('OLD')]));
    const { importId } = await queueImport(ctx, doc([item('A'), item('B')]));
    const crashedToken = randomUUID();
    // Simulate the crashed attempt: it claimed the import and upserted A.
    await dbHandle.sql`
      update feed_imports
         set status = 'PROCESSING', claim_token = ${crashedToken},
             lease_expires_at = now() - interval '1 minute', started_at = now()
       where id = ${importId}
    `;
    await dbHandle.sql`
      update merchant_offers
         set last_seen_import_id = ${importId}, last_seen_claim_token = ${crashedToken}
       where feed_id = ${ctx.feedId} and external_id = 'A'
    `;
    const row = await svc.performImport(ctx.tenantId, importId);
    expect(row).toMatchObject({ status: 'SUCCESS', itemsRejected: 0, itemsDeactivated: 1 });
    const got = byId(await offers(ctx));
    expect(got.get('A')!.status).toBe('ACTIVE');
    expect(got.get('OLD')!.status).toBe('INACTIVE');
  });

  it('a worker that lost its claim cannot finalize', async () => {
    const ctx = await seedFeed();
    const { importId } = await queueImport(ctx, doc([item('A')]));
    const now = new Date();
    const claimed = await withTenantTransaction(dbHandle.db, ctx.tenantId, (tx) =>
      feedImportsRepository.claimImport(tx, ctx.tenantId, importId, {
        token: randomUUID(),
        now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      }),
    );
    expect(claimed?.status).toBe('PROCESSING');
    const stolen = await withTenantTransaction(dbHandle.db, ctx.tenantId, (tx) =>
      feedImportsRepository.finalizeImport(tx, ctx.tenantId, importId, randomUUID(), {
        status: 'SUCCESS',
        finishedAt: new Date(),
        counters: {
          itemsSeen: 0,
          itemsCreated: 0,
          itemsUpdated: 0,
          itemsUnchanged: 0,
          itemsRejected: 0,
          itemsWarned: 0,
        },
        itemsDeactivated: 0,
        errorCode: null,
        errorMessage: null,
        errorSamples: [],
      }),
    );
    expect(stolen).toBeNull();
  });

  it('an older import is SUPERSEDED once a newer import of the feed has run', async () => {
    const ctx = await seedFeed();
    const older = await queueImport(ctx, doc([item('OLD')]));
    const newer = await queueImport(ctx, doc([item('NEW')]));
    expect((await svc.performImport(ctx.tenantId, newer.importId)).status).toBe('SUCCESS');
    const stale = await svc.performImport(ctx.tenantId, older.importId);
    expect(stale).toMatchObject({ status: 'FAILED', errorCode: 'SUPERSEDED' });
    expect([...byId(await offers(ctx)).keys()]).toEqual(['NEW']);
  });

  it('CUSTOM_XML without a mapping → FAILED MAPPING_REQUIRED', async () => {
    const ctx = await seedFeed();
    await dbHandle.sql`update feeds set item_mapping = null where id = ${ctx.feedId}`;
    const row = await runImport(ctx, doc([item('A')]));
    expect(row).toMatchObject({ status: 'FAILED', errorCode: 'MAPPING_REQUIRED' });
  });

  // -- tenant isolation (application layer; RLS is covered in packages/db) --------

  it('wrong tenant cannot read offers or imports of another tenant', async () => {
    const a = await seedFeed();
    const b = await seedFeed();
    const row = await runImport(a, doc([item('A')]));
    const leaked = await withTenantTransaction(dbHandle.db, b.tenantId, (tx) =>
      offersRepository.listOffersForFeed(tx, b.tenantId, a.feedId),
    );
    expect(leaked).toEqual([]);
    await expect(svc.getImport(b.tenantId, a.merchantId, a.siteId, a.feedId, row.id)).rejects.toThrow();
    await expect(svc.performImport(b.tenantId, row.id)).rejects.toThrow(/not found/);
  });

  // -- end-to-end: fetch job → import job ------------------------------------------

  it('a SUCCESS fetch queues exactly one feed.import that produces offers', async () => {
    let server: Server | null = null;
    try {
      server = createServer((_req, res) => {
        res.setHeader('content-type', 'application/xml; charset=utf-8');
        res.end(doc([item('E1'), item('E2')]));
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const ctx = await seedFeed({ url: `http://127.0.0.1:${port}/feed.xml` });

      await svc.enqueueFetch(ctx.tenantId, ctx.merchantId, ctx.siteId, ctx.feedId);
      await jobs.awaitIdle();

      const imports = await svc.listImports(ctx.tenantId, ctx.merchantId, ctx.siteId, ctx.feedId);
      expect(imports).toHaveLength(1);
      expect(imports[0]).toMatchObject({ status: 'SUCCESS', itemsCreated: 2 });
      expect([...byId(await offers(ctx)).keys()].sort()).toEqual(['E1', 'E2']);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] feeds-import.test.ts: skipping — test database not configured/reachable.');
}
