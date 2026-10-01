import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, type DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

// ---------------------------------------------------------------------------
// Fixture: tenant → merchant → site → feed → fetch → import, inserted as the
// (superuser) test role. RLS assertions switch to fiyatucuz_app explicitly.
// ---------------------------------------------------------------------------

interface Chain {
  tenantId: string;
  merchantId: string;
  siteId: string;
  feedId: string;
  fetchId: string;
  importId: string;
}

async function seedChain(handle: DbHandle, label: string): Promise<Chain> {
  const tenantId = randomUUID();
  const merchantId = randomUUID();
  const siteId = randomUUID();
  const feedId = randomUUID();
  const fetchId = randomUUID();
  const importId = randomUUID();
  const s = handle.sql;
  await s`insert into tenants (id, name, slug) values (${tenantId}, 't', ${'ot-' + label + '-' + tenantId.slice(0, 8)})`;
  await s`insert into merchants (id, tenant_id, name, slug) values (${merchantId}, ${tenantId}, 'm', ${'om-' + merchantId.slice(0, 8)})`;
  await s`
    insert into merchant_sites (id, tenant_id, merchant_id, name, domain, normalized_domain)
    values (${siteId}, ${tenantId}, ${merchantId}, 's', ${label + '.example.com'}, ${label + '.example.com'})
  `;
  await s`
    insert into feeds (id, tenant_id, merchant_site_id, name, url, format)
    values (${feedId}, ${tenantId}, ${siteId}, 'f', 'https://x.example.com/f.xml', 'CUSTOM_XML')
  `;
  await s`insert into feed_fetches (id, tenant_id, feed_id, status) values (${fetchId}, ${tenantId}, ${feedId}, 'SUCCESS')`;
  await s`insert into feed_imports (id, tenant_id, feed_id, fetch_id) values (${importId}, ${tenantId}, ${feedId}, ${fetchId})`;
  return { tenantId, merchantId, siteId, feedId, fetchId, importId };
}

const HASH = 'a'.repeat(64);

function offerInsert(c: Chain, externalId: string, over: Record<string, unknown> = {}) {
  const row = {
    id: randomUUID(),
    tenant_id: c.tenantId,
    merchant_site_id: c.siteId,
    feed_id: c.feedId,
    external_id: externalId,
    title: 'Ürün',
    product_url: 'https://shop.example.com/p',
    currency: 'TRY',
    price_minor: '129990',
    content_hash: HASH,
    last_seen_import_id: c.importId,
    last_seen_claim_token: randomUUID(),
    ...over,
  };
  return row;
}

async function insertOffer(handle: DbHandle, row: Record<string, unknown>): Promise<void> {
  await handle.sql`insert into merchant_offers ${handle.sql(row)}`;
}

async function cleanup(handle: DbHandle): Promise<void> {
  await handle.sql`
    truncate table merchant_offers, feed_imports, feed_fetches, feeds, merchant_sites, merchants, tenants cascade
  `;
}

// ===========================================================================

describe.skipIf(!reachable)('offers: schema (0006)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = makeTestDbHandle();
    await applyMigrations(handle.sql, MIGRATIONS_DIR);
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  it('creates feed_imports + merchant_offers with RLS enabled AND forced', async () => {
    const rows = await handle.db.execute(sql`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('feed_imports', 'merchant_offers') order by relname
    `);
    expect(rows).toEqual([
      { relname: 'feed_imports', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'merchant_offers', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  it('tenant isolation policies target fiyatucuz_app with USING + WITH CHECK', async () => {
    const rows = (await handle.db.execute(sql`
      select tablename, roles::text as roles, qual, with_check from pg_policies
      where tablename in ('feed_imports', 'merchant_offers') order by tablename
    `)) as Array<{ tablename: string; roles: string; qual: string; with_check: string }>;
    expect(rows.map((r) => r.tablename)).toEqual(['feed_imports', 'merchant_offers']);
    for (const r of rows) {
      expect(r.roles).toContain('fiyatucuz_app');
      expect(r.qual).toMatch(/current_setting\('app\.tenant_id'/);
      expect(r.with_check).toMatch(/current_setting\('app\.tenant_id'/);
    }
  });

  it('identity is UNIQUE(feed_id, external_id); GTIN is indexed but not unique', async () => {
    const rows = (await handle.db.execute(sql`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.merchant_offers'::regclass and contype = 'u'
    `)) as Array<{ conname: string; def: string }>;
    expect(rows).toEqual([{ conname: 'merchant_offers_feed_external_unique', def: 'UNIQUE (feed_id, external_id)' }]);
  });

  it('price columns are bigint minor units + char(3) currency', async () => {
    const rows = (await handle.db.execute(sql`
      select column_name, data_type, character_maximum_length from information_schema.columns
      where table_name = 'merchant_offers' and column_name in ('price_minor', 'list_price_minor', 'currency')
      order by column_name
    `)) as Array<{ column_name: string; data_type: string }>;
    expect(rows.map((r) => [r.column_name, r.data_type])).toEqual([
      ['currency', 'character'],
      ['list_price_minor', 'bigint'],
      ['price_minor', 'bigint'],
    ]);
  });

  it('grants: app CRUD (no TRUNCATE), reporting SELECT only', async () => {
    const priv = async (role: string, table: string, p: string) =>
      ((await handle.db.execute(
        sql`select has_table_privilege(${role}, ${'public.' + table}, ${p}) as g`,
      )) as Array<{ g: boolean }>)[0]?.g;
    for (const t of ['feed_imports', 'merchant_offers']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(await priv('fiyatucuz_app', t, p)).toBe(true);
      expect(await priv('fiyatucuz_app', t, 'TRUNCATE')).toBe(false);
      expect(await priv('fiyatucuz_reporting', t, 'SELECT')).toBe(true);
      expect(await priv('fiyatucuz_reporting', t, 'INSERT')).toBe(false);
    }
  });
});

// ===========================================================================

describe.skipIf(!reachable)('offers: constraints + ownership FKs', () => {
  let handle: DbHandle;
  let a: Chain;
  let b: Chain;
  beforeAll(async () => {
    handle = makeTestDbHandle();
    await applyMigrations(handle.sql, MIGRATIONS_DIR);
  });
  beforeEach(async () => {
    await cleanup(handle);
    a = await seedChain(handle, 'a');
    b = await seedChain(handle, 'b');
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  it('duplicate (feed_id, external_id) is rejected', async () => {
    await insertOffer(handle, offerInsert(a, 'X'));
    await expect(insertOffer(handle, offerInsert(a, 'X'))).rejects.toThrow(/merchant_offers_feed_external_unique/);
  });

  it('same external_id / GTIN in different feeds is allowed', async () => {
    await insertOffer(handle, offerInsert(a, 'X', { gtin: '04006381333931' }));
    await insertOffer(handle, offerInsert(b, 'X', { gtin: '04006381333931' }));
    const rows = await handle.sql<Array<{ n: number }>>`select count(*)::int as n from merchant_offers`;
    expect(rows[0]?.n).toBe(2);
  });

  it('offer cannot point at a feed of another tenant (composite FK)', async () => {
    await expect(
      insertOffer(handle, offerInsert(a, 'X', { feed_id: b.feedId, last_seen_import_id: b.importId })),
    ).rejects.toThrow(/foreign key/);
  });

  it("offer's site must equal its feed's site", async () => {
    const otherSite = randomUUID();
    await handle.sql`
      insert into merchant_sites (id, tenant_id, merchant_id, name, domain, normalized_domain)
      values (${otherSite}, ${a.tenantId}, ${a.merchantId}, 's2', 'a2.example.com', 'a2.example.com')
    `;
    await expect(insertOffer(handle, offerInsert(a, 'X', { merchant_site_id: otherSite }))).rejects.toThrow(
      /merchant_offers_feed_site_tenant_fk/,
    );
  });

  it('feed_imports cannot reference a fetch of another feed', async () => {
    // Fresh fetch on a second feed of the SAME tenant, not yet used by any
    // import — so UNIQUE(fetch_id) cannot fire and only the ownership FK can.
    const otherFeed = randomUUID();
    const otherFetch = randomUUID();
    await handle.sql`
      insert into feeds (id, tenant_id, merchant_site_id, name, url, format)
      values (${otherFeed}, ${a.tenantId}, ${a.siteId}, 'f2', 'https://x.example.com/f2.xml', 'CUSTOM_XML')
    `;
    await handle.sql`insert into feed_fetches (id, tenant_id, feed_id, status) values (${otherFetch}, ${a.tenantId}, ${otherFeed}, 'SUCCESS')`;
    await expect(
      handle.sql`insert into feed_imports (id, tenant_id, feed_id, fetch_id) values (${randomUUID()}, ${a.tenantId}, ${a.feedId}, ${otherFetch})`,
    ).rejects.toThrow(/feed_imports_fetch_feed_tenant_fk/);
  });

  it('one import per fetch (UNIQUE fetch_id)', async () => {
    await expect(
      handle.sql`insert into feed_imports (id, tenant_id, feed_id, fetch_id) values (${randomUUID()}, ${a.tenantId}, ${a.feedId}, ${a.fetchId})`,
    ).rejects.toThrow(/feed_imports_fetch_unique/);
  });

  it('at most one PROCESSING import per feed', async () => {
    const fetch2 = randomUUID();
    const import2 = randomUUID();
    await handle.sql`insert into feed_fetches (id, tenant_id, feed_id, status) values (${fetch2}, ${a.tenantId}, ${a.feedId}, 'SUCCESS')`;
    await handle.sql`insert into feed_imports (id, tenant_id, feed_id, fetch_id) values (${import2}, ${a.tenantId}, ${a.feedId}, ${fetch2})`;
    const claim = (id: string) => handle.sql`
      update feed_imports set status = 'PROCESSING', claim_token = ${randomUUID()},
        lease_expires_at = now() + interval '1 minute' where id = ${id}
    `;
    await claim(a.importId);
    await expect(claim(import2)).rejects.toThrow(/feed_imports_one_processing_per_feed/);
  });

  it('PROCESSING requires an owner + lease; terminal requires finished_at', async () => {
    await expect(handle.sql`update feed_imports set status = 'PROCESSING' where id = ${a.importId}`).rejects.toThrow(
      /feed_imports_processing_owner_chk/,
    );
    await expect(handle.sql`update feed_imports set status = 'SUCCESS' where id = ${a.importId}`).rejects.toThrow(
      /feed_imports_terminal_finished_chk/,
    );
  });

  it.each([
    ['price_minor', '0', /merchant_offers_price_chk/],
    ['price_minor', '-1', /merchant_offers_price_chk/],
    ['currency', 'tl ', /merchant_offers_currency_chk/],
    ['gtin', '123', /merchant_offers_gtin_chk/],
    ['product_url', 'javascript:alert(1)', /merchant_offers_product_url_chk/],
    ['image_url', 'data:image/png;base64,AA', /merchant_offers_image_url_chk/],
    ['content_hash', 'not-a-hash', /merchant_offers_content_hash_chk/],
    ['vat_rate_bp', 10001, /merchant_offers_vat_rate_chk/],
    ['stock_quantity', -1, /merchant_offers_stock_chk/],
    ['title', 'x'.repeat(501), /merchant_offers_title_len_chk/],
  ])('CHECK backstop: %s = %j rejected', async (column, value, re) => {
    await expect(insertOffer(handle, offerInsert(a, 'X', { [column]: value }))).rejects.toThrow(re);
  });

  it('list price must exceed the current price', async () => {
    await expect(insertOffer(handle, offerInsert(a, 'X', { list_price_minor: '129990' }))).rejects.toThrow(
      /merchant_offers_list_price_chk/,
    );
  });

  it('item_mapping must be a bounded JSON object', async () => {
    await expect(handle.sql`update feeds set item_mapping = '[]'::jsonb where id = ${a.feedId}`).rejects.toThrow(
      /feeds_item_mapping_shape_chk/,
    );
  });
});

// ===========================================================================
// RLS — as fiyatucuz_app (the production identity)
// ===========================================================================

describe.skipIf(!reachable)('offers: RLS tenant isolation (fiyatucuz_app)', () => {
  let handle: DbHandle;
  let a: Chain;
  let b: Chain;
  beforeAll(async () => {
    handle = makeTestDbHandle();
    await applyMigrations(handle.sql, MIGRATIONS_DIR);
    await cleanup(handle);
    a = await seedChain(handle, 'ra');
    b = await seedChain(handle, 'rb');
    await insertOffer(handle, offerInsert(a, 'A-ONLY'));
    await insertOffer(handle, offerInsert(b, 'B-ONLY'));
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  async function asApp<T>(tenantId: string | null, fn: (tx: Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
    return handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw('SET LOCAL ROLE fiyatucuz_app'));
      if (tenantId) await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  }

  it('tenant B sees only its own offers and imports', async () => {
    const seen = await asApp(b.tenantId, async (tx) => ({
      offers: (await tx.execute(sql`select external_id from merchant_offers`)) as Array<{ external_id: string }>,
      imports: (await tx.execute(sql`select id from feed_imports`)) as Array<{ id: string }>,
    }));
    expect(seen.offers.map((r) => r.external_id)).toEqual(['B-ONLY']);
    expect(seen.imports.map((r) => r.id)).toEqual([b.importId]);
  });

  it("tenant B cannot update or delete tenant A's offers (0 rows affected)", async () => {
    const counts = await asApp(b.tenantId, async (tx) => {
      const u = (await tx.execute(
        sql`update merchant_offers set title = 'pwned' where tenant_id = ${a.tenantId} returning id`,
      )) as unknown[];
      const d = (await tx.execute(sql`delete from merchant_offers where tenant_id = ${a.tenantId} returning id`)) as unknown[];
      return { u: u.length, d: d.length };
    });
    expect(counts).toEqual({ u: 0, d: 0 });
    const rows = await handle.sql<Array<{ title: string }>>`select title from merchant_offers where external_id = 'A-ONLY'`;
    expect(rows[0]?.title).toBe('Ürün');
  });

  it("tenant B cannot insert an offer or import into tenant A (WITH CHECK)", async () => {
    await expect(
      asApp(b.tenantId, (tx) =>
        tx.execute(sql`
          insert into merchant_offers (id, tenant_id, merchant_site_id, feed_id, external_id, title,
            product_url, currency, price_minor, content_hash, last_seen_import_id, last_seen_claim_token)
          values (${randomUUID()}, ${a.tenantId}, ${a.siteId}, ${a.feedId}, 'EVIL', 't',
            'https://ra.example.com/p', 'TRY', 100, ${HASH}, ${a.importId}, ${randomUUID()})
        `),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asApp(b.tenantId, (tx) =>
        tx.execute(sql`
          update feed_imports set tenant_id = ${a.tenantId} where id = ${b.importId}
        `),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('without app.tenant_id the app role fails closed', async () => {
    await expect(asApp(null, (tx) => tx.execute(sql`select * from merchant_offers`))).rejects.toThrow();
    await expect(asApp(null, (tx) => tx.execute(sql`select * from feed_imports`))).rejects.toThrow();
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/db] offers.test.ts: skipping — test database not configured/reachable.');
}
