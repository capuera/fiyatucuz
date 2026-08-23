import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function ensureTenant(handle: DbHandle, prefix: string): Promise<string> {
  const id = randomUUID();
  await handle.sql`
    insert into tenants (id, name, slug) values (${id}, 'test', ${prefix + '-' + id.slice(0, 8)})
  `;
  return id;
}

async function ensureMerchant(
  handle: DbHandle,
  tenantId: string,
  prefix: string,
): Promise<string> {
  const id = randomUUID();
  await handle.sql`
    insert into merchants (id, tenant_id, name, slug)
      values (${id}, ${tenantId}, 'm', ${prefix + '-' + id.slice(0, 8)})
  `;
  return id;
}

async function ensureSite(
  handle: DbHandle,
  tenantId: string,
  merchantId: string,
  domain: string,
): Promise<string> {
  const id = randomUUID();
  await handle.sql`
    insert into merchant_sites (id, tenant_id, merchant_id, name, domain, normalized_domain)
      values (${id}, ${tenantId}, ${merchantId}, 's', ${domain}, ${domain})
  `;
  return id;
}

async function cleanup(handle: DbHandle): Promise<void> {
  await handle.sql`truncate table feed_fetches, feeds, merchant_sites, merchants, tenants cascade`;
}

// ===========================================================================
// Schema shape
// ===========================================================================

describe.skipIf(!reachable)('feeds: schema shape (0005)', () => {
  let handle: DbHandle;
  beforeAll(() => {
    handle = makeTestDbHandle();
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  it('creates feeds + feed_fetches tables', async () => {
    const rows = await handle.db.execute(sql`
      select tablename from pg_tables
      where schemaname = 'public' and tablename in ('feeds', 'feed_fetches')
      order by tablename
    `);
    expect((rows as Array<{ tablename: string }>).map((r) => r.tablename)).toEqual([
      'feed_fetches',
      'feeds',
    ]);
  });

  it('creates 3 new enums', async () => {
    const rows = await handle.db.execute(sql`
      select typname from pg_type
      where typname in ('feed_format', 'feed_status', 'feed_fetch_status')
      order by typname
    `);
    expect((rows as Array<{ typname: string }>).map((r) => r.typname)).toEqual([
      'feed_fetch_status',
      'feed_format',
      'feed_status',
    ]);
  });

  it('feeds has composite FK (merchant_site_id, tenant_id) → merchant_sites (id, tenant_id)', async () => {
    const rows = await handle.db.execute(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'public.feeds'::regclass and conname = 'feeds_site_tenant_fk'
    `);
    const def = (rows as Array<{ def: string }>)[0]?.def;
    expect(def).toBeDefined();
    expect(def).toMatch(/merchant_site_id/);
    expect(def).toMatch(/tenant_id/);
    expect(def).toMatch(/REFERENCES merchant_sites\(id, tenant_id\)/);
  });

  it('feed_fetches has composite FK (feed_id, tenant_id) → feeds (id, tenant_id)', async () => {
    const rows = await handle.db.execute(sql`
      select pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'public.feed_fetches'::regclass and conname = 'feed_fetches_feed_tenant_fk'
    `);
    const def = (rows as Array<{ def: string }>)[0]?.def;
    expect(def).toBeDefined();
    expect(def).toMatch(/feed_id/);
    expect(def).toMatch(/tenant_id/);
    expect(def).toMatch(/REFERENCES feeds\(id, tenant_id\)/);
  });

  it('feeds has UNIQUE(id, tenant_id) to enable the fetch-side composite FK', async () => {
    const rows = await handle.db.execute(sql`
      select conname from pg_constraint
      where conrelid = 'public.feeds'::regclass and contype = 'u'
    `);
    const names = (rows as Array<{ conname: string }>).map((r) => r.conname);
    expect(names).toContain('feeds_id_tenant_unique');
  });

  it('has all expected indexes', async () => {
    const rows = await handle.db.execute(sql`
      select indexname from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'feeds_tenant_id_idx',
          'feeds_merchant_site_id_idx',
          'feeds_status_next_fetch_at_idx',
          'feed_fetches_tenant_id_idx',
          'feed_fetches_feed_started_at_idx',
          'feed_fetches_status_idx'
        )
      order by indexname
    `);
    const names = (rows as Array<{ indexname: string }>).map((r) => r.indexname);
    expect(names.length).toBe(6);
  });

  it('feeds has set_updated_at trigger; feed_fetches does NOT (append-only lifecycle)', async () => {
    const rows = await handle.db.execute(sql`
      select tgname, tgrelid::regclass::text as tbl from pg_trigger
      where tgname in ('feeds_set_updated_at', 'feed_fetches_set_updated_at')
        and not tgisinternal
    `);
    const list = (rows as Array<{ tgname: string; tbl: string }>).map((r) => r.tgname);
    expect(list).toContain('feeds_set_updated_at');
    expect(list).not.toContain('feed_fetches_set_updated_at');
  });
});

// ===========================================================================
// RLS + FORCE + policies
// ===========================================================================

describe.skipIf(!reachable)('feeds: RLS enabled + forced + policies', () => {
  let handle: DbHandle;
  beforeAll(() => {
    handle = makeTestDbHandle();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('feeds RLS enabled + forced', async () => {
    const rows = await handle.db.execute(sql`
      select relrowsecurity, relforcerowsecurity from pg_class where relname='feeds'
    `);
    const r = (rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>)[0];
    expect(r?.relrowsecurity).toBe(true);
    expect(r?.relforcerowsecurity).toBe(true);
  });

  it('feed_fetches RLS enabled + forced', async () => {
    const rows = await handle.db.execute(sql`
      select relrowsecurity, relforcerowsecurity from pg_class where relname='feed_fetches'
    `);
    const r = (rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>)[0];
    expect(r?.relrowsecurity).toBe(true);
    expect(r?.relforcerowsecurity).toBe(true);
  });

  it('both policies use app.tenant_id and include WITH CHECK', async () => {
    const rows = await handle.db.execute(sql`
      select polname,
             pg_get_expr(polqual, polrelid) as using_clause,
             pg_get_expr(polwithcheck, polrelid) as with_check
      from pg_policy
      where polrelid in ('public.feeds'::regclass, 'public.feed_fetches'::regclass)
        and polname in ('feeds_tenant_isolation', 'feed_fetches_tenant_isolation')
    `);
    const list = rows as Array<{ using_clause: string; with_check: string | null }>;
    expect(list.length).toBe(2);
    for (const p of list) {
      expect(p.using_clause).toMatch(/current_setting\('app.tenant_id'/);
      expect(p.with_check).toMatch(/current_setting\('app.tenant_id'/);
    }
  });

  it('SELECT on feeds as fiyatucuz_app without app.tenant_id raises (fail-closed)', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        return tx.execute(sql`select * from feeds`);
      }),
    ).rejects.toThrow();
  });

  it('SELECT on feed_fetches as fiyatucuz_app without app.tenant_id raises (fail-closed)', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        return tx.execute(sql`select * from feed_fetches`);
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// Grants
// ===========================================================================

describe.skipIf(!reachable)('feeds: grants', () => {
  let handle: DbHandle;
  beforeAll(() => {
    handle = makeTestDbHandle();
  });
  afterAll(async () => {
    await handle.close();
  });

  async function priv(role: string, table: string, p: string): Promise<boolean> {
    const rows = await handle.db.execute(
      sql`select has_table_privilege(${role}, ${'public.' + table}, ${p}) as g`,
    );
    return (rows as Array<{ g: boolean }>)[0]?.g ?? false;
  }

  it('fiyatucuz_app has CRUD on both tables', async () => {
    for (const t of ['feeds', 'feed_fetches']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await priv('fiyatucuz_app', t, p), `${t}.${p}`).toBe(true);
      }
    }
  });

  it('fiyatucuz_app does NOT have TRUNCATE / REFERENCES / TRIGGER', async () => {
    for (const t of ['feeds', 'feed_fetches']) {
      for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect(await priv('fiyatucuz_app', t, p), `${t}.${p}`).toBe(false);
      }
    }
  });

  it('fiyatucuz_reporting has SELECT-only on both tables', async () => {
    for (const t of ['feeds', 'feed_fetches']) {
      expect(await priv('fiyatucuz_reporting', t, 'SELECT')).toBe(true);
      for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(await priv('fiyatucuz_reporting', t, p), `${t}.${p}`).toBe(false);
      }
    }
  });
});

// ===========================================================================
// Composite tenant-consistency FKs
// ===========================================================================

describe.skipIf(!reachable)('feeds: composite tenant-consistency FKs', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = makeTestDbHandle();
    await cleanup(handle);
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  it('inserting a feed with tenant_id ≠ merchant_site.tenant_id is rejected', async () => {
    const tA = await ensureTenant(handle, 'ta');
    const tB = await ensureTenant(handle, 'tb');
    const mA = await ensureMerchant(handle, tA, 'ma');
    const siteA = await ensureSite(handle, tA, mA, 'a.example');

    await expect(
      handle.sql`
        insert into feeds (id, tenant_id, merchant_site_id, name, url, format)
          values (${randomUUID()}, ${tB}, ${siteA}, 'x', 'https://example.com/feed.xml', 'CUSTOM_XML')
      `,
    ).rejects.toThrow(/feeds_site_tenant_fk|foreign key/i);
  });

  it('inserting a feed_fetch with tenant_id ≠ feed.tenant_id is rejected', async () => {
    const tA = await ensureTenant(handle, 'ff-a');
    const tB = await ensureTenant(handle, 'ff-b');
    const mA = await ensureMerchant(handle, tA, 'ffm');
    const siteA = await ensureSite(handle, tA, mA, 'ff.example');
    const feedA = randomUUID();
    await handle.sql`
      insert into feeds (id, tenant_id, merchant_site_id, name, url, format)
        values (${feedA}, ${tA}, ${siteA}, 'x', 'https://ff.example/feed.xml', 'CUSTOM_XML')
    `;
    await expect(
      handle.sql`
        insert into feed_fetches (id, tenant_id, feed_id) values (${randomUUID()}, ${tB}, ${feedA})
      `,
    ).rejects.toThrow(/feed_fetches_feed_tenant_fk|foreign key/i);
  });
});

// ===========================================================================
// Cross-tenant read (RLS actually filters when acting as fiyatucuz_app)
// ===========================================================================

describe.skipIf(!reachable)('feeds: cross-tenant reads blocked by RLS', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = makeTestDbHandle();
    await cleanup(handle);
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  it('tenant A cannot see tenant B\'s feeds/fetches', async () => {
    const tA = await ensureTenant(handle, 'read-a');
    const tB = await ensureTenant(handle, 'read-b');
    const mA = await ensureMerchant(handle, tA, 'rma');
    const mB = await ensureMerchant(handle, tB, 'rmb');
    const sA = await ensureSite(handle, tA, mA, 'read-a.example');
    const sB = await ensureSite(handle, tB, mB, 'read-b.example');
    const feedA = randomUUID();
    const feedB = randomUUID();
    await handle.sql`
      insert into feeds (id, tenant_id, merchant_site_id, name, url, format) values
        (${feedA}, ${tA}, ${sA}, 'A', 'https://read-a.example/feed', 'CUSTOM_XML'),
        (${feedB}, ${tB}, ${sB}, 'B', 'https://read-b.example/feed', 'CUSTOM_XML')
    `;
    await handle.sql`
      insert into feed_fetches (id, tenant_id, feed_id, status) values
        (${randomUUID()}, ${tA}, ${feedA}, 'QUEUED'),
        (${randomUUID()}, ${tB}, ${feedB}, 'QUEUED')
    `;

    const seen = await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
      await tx.execute(sql`select set_config('app.tenant_id', ${tA}, true)`);
      const feedRows = await tx.execute(sql`select id from feeds`);
      const fetchRows = await tx.execute(sql`select id from feed_fetches`);
      return {
        feeds: (feedRows as Array<{ id: string }>).map((r) => r.id),
        fetches: (fetchRows as Array<{ id: string }>).map((r) => r.id),
      };
    });
    expect(seen.feeds).toEqual([feedA]);
    expect(seen.fetches.length).toBe(1);
  });

  it('INSERT with wrong tenant_id blocked by RLS WITH CHECK', async () => {
    const tA = await ensureTenant(handle, 'wc-a');
    const tB = await ensureTenant(handle, 'wc-b');
    const mA = await ensureMerchant(handle, tA, 'wcm');
    const sA = await ensureSite(handle, tA, mA, 'wc.example');
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        await tx.execute(sql`select set_config('app.tenant_id', ${tA}, true)`);
        // Tenant context is A; try to insert a feed for B.
        await tx.execute(
          sql`insert into feeds (id, tenant_id, merchant_site_id, name, url, format)
              values (${randomUUID()}, ${tB}, ${sA}, 'x', 'https://wc.example/feed', 'CUSTOM_XML')`,
        );
      }),
    ).rejects.toThrow(/row-level security|policy|foreign key/i);
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/db] feeds.test.ts: skipping — PG unreachable.');
}
