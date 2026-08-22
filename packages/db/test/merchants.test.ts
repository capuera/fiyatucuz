import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function ensureTenant(handle: DbHandle, slugPrefix: string): Promise<string> {
  const id = randomUUID();
  await handle.sql`
    insert into tenants (id, name, slug) values (${id}, 'test', ${slugPrefix + '-' + id.slice(0, 8)})
  `;
  return id;
}

async function ensureMerchant(
  handle: DbHandle,
  tenantId: string,
  slugPrefix: string,
): Promise<string> {
  const id = randomUUID();
  await handle.sql`
    insert into merchants (id, tenant_id, name, slug)
      values (${id}, ${tenantId}, 'test-merchant', ${slugPrefix + '-' + id.slice(0, 8)})
  `;
  return id;
}

async function cleanup(handle: DbHandle): Promise<void> {
  await handle.sql`truncate table merchant_sites, merchants, tenants cascade`;
}

// ===========================================================================
// Schema shape
// ===========================================================================

describe.skipIf(!reachable)('merchants: schema shape (0004)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = makeTestDbHandle();
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  it('creates merchants + merchant_sites tables', async () => {
    const rows = await handle.db.execute(sql`
      select tablename from pg_tables
      where schemaname = 'public' and tablename in ('merchants', 'merchant_sites')
      order by tablename
    `);
    expect((rows as Array<{ tablename: string }>).map((r) => r.tablename)).toEqual([
      'merchant_sites',
      'merchants',
    ]);
  });

  it('merchants has UNIQUE(tenant_id, slug) and UNIQUE(id, tenant_id) constraints', async () => {
    const rows = await handle.db.execute(sql`
      select conname from pg_constraint
      where conrelid = 'public.merchants'::regclass
        and contype = 'u'
      order by conname
    `);
    const names = (rows as Array<{ conname: string }>).map((r) => r.conname);
    expect(names).toContain('merchants_tenant_slug_unique');
    expect(names).toContain('merchants_id_tenant_unique');
  });

  it('merchant_sites has UNIQUE(tenant_id, normalized_domain) constraint', async () => {
    const rows = await handle.db.execute(sql`
      select conname from pg_constraint
      where conrelid = 'public.merchant_sites'::regclass
        and contype = 'u'
        and conname = 'merchant_sites_tenant_domain_unique'
    `);
    expect((rows as Array<unknown>).length).toBe(1);
  });

  it('merchant_sites has composite FK (merchant_id, tenant_id) → merchants (id, tenant_id)', async () => {
    const rows = await handle.db.execute(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'public.merchant_sites'::regclass
        and contype = 'f'
        and conname = 'merchant_sites_merchant_tenant_fk'
    `);
    const row = (rows as Array<{ def: string }>)[0];
    expect(row).toBeDefined();
    // Composite FK definition contains both columns referencing merchants(id, tenant_id).
    expect(row?.def).toMatch(/\bmerchant_id\b/);
    expect(row?.def).toMatch(/\btenant_id\b/);
    expect(row?.def).toMatch(/REFERENCES merchants\(id, tenant_id\)/);
  });

  it('merchant_sites has partial unique index on normalized_domain WHERE VERIFIED', async () => {
    const rows = await handle.db.execute(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public'
        and indexname = 'merchant_sites_verified_domain_unique'
    `);
    const row = (rows as Array<{ indexdef: string }>)[0];
    expect(row).toBeDefined();
    expect(row?.indexdef).toMatch(/UNIQUE INDEX/i);
    expect(row?.indexdef).toMatch(/normalized_domain/);
    expect(row?.indexdef.toUpperCase()).toContain("VERIFICATION_STATUS = 'VERIFIED'");
  });

  it('both tables have set_updated_at BEFORE UPDATE triggers', async () => {
    const rows = await handle.db.execute(sql`
      select tgname, tgrelid::regclass::text as tbl
      from pg_trigger
      where tgname in ('merchants_set_updated_at', 'merchant_sites_set_updated_at')
        and not tgisinternal
      order by tgname
    `);
    const list = (rows as Array<{ tgname: string; tbl: string }>).map((r) => r.tgname);
    expect(list).toEqual(['merchant_sites_set_updated_at', 'merchants_set_updated_at']);
  });
});

// ===========================================================================
// RLS + FORCE + policies
// ===========================================================================

describe.skipIf(!reachable)('merchants: RLS + FORCE + policies', () => {
  let handle: DbHandle;
  beforeAll(() => {
    handle = makeTestDbHandle();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('merchants has RLS enabled + forced', async () => {
    const rows = await handle.db.execute(sql`
      select relrowsecurity, relforcerowsecurity from pg_class where relname='merchants'
    `);
    const r = (rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>)[0];
    expect(r?.relrowsecurity).toBe(true);
    expect(r?.relforcerowsecurity).toBe(true);
  });

  it('merchant_sites has RLS enabled + forced', async () => {
    const rows = await handle.db.execute(sql`
      select relrowsecurity, relforcerowsecurity from pg_class where relname='merchant_sites'
    `);
    const r = (rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>)[0];
    expect(r?.relrowsecurity).toBe(true);
    expect(r?.relforcerowsecurity).toBe(true);
  });

  it('both policies use app.tenant_id and include WITH CHECK', async () => {
    const rows = await handle.db.execute(sql`
      select polname,
             pg_get_expr(polqual, polrelid)     as using_clause,
             pg_get_expr(polwithcheck, polrelid) as with_check
      from pg_policy
      where polrelid in ('public.merchants'::regclass, 'public.merchant_sites'::regclass)
        and polname in ('merchants_tenant_isolation', 'merchant_sites_tenant_isolation')
      order by polname
    `);
    const list = rows as Array<{ using_clause: string; with_check: string | null }>;
    expect(list.length).toBe(2);
    for (const p of list) {
      expect(p.using_clause).toMatch(/current_setting\('app.tenant_id'/);
      expect(p.with_check).toMatch(/current_setting\('app.tenant_id'/);
    }
  });
});

// ===========================================================================
// Grants
// ===========================================================================

describe.skipIf(!reachable)('merchants: grants', () => {
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

  it('fiyatucuz_app has CRUD on merchants + merchant_sites', async () => {
    for (const t of ['merchants', 'merchant_sites']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await priv('fiyatucuz_app', t, p), `${t}.${p}`).toBe(true);
      }
    }
  });

  it('fiyatucuz_app does NOT have TRUNCATE / REFERENCES / TRIGGER on these tables', async () => {
    for (const t of ['merchants', 'merchant_sites']) {
      for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect(await priv('fiyatucuz_app', t, p), `${t}.${p}`).toBe(false);
      }
    }
  });

  it('fiyatucuz_reporting has SELECT and only SELECT on both tables', async () => {
    for (const t of ['merchants', 'merchant_sites']) {
      expect(await priv('fiyatucuz_reporting', t, 'SELECT'), `${t}.SELECT`).toBe(true);
      for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(await priv('fiyatucuz_reporting', t, p), `${t}.${p}`).toBe(false);
      }
    }
  });
});

// ===========================================================================
// Composite FK + partial unique behavior
// ===========================================================================

describe.skipIf(!reachable)('merchants: composite FK ownership consistency', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = makeTestDbHandle();
    await cleanup(handle);
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  it('inserting a site with tenant_id ≠ merchant.tenant_id is rejected by the composite FK', async () => {
    const tenantA = await ensureTenant(handle, 'ta');
    const tenantB = await ensureTenant(handle, 'tb');
    const merchantA = await ensureMerchant(handle, tenantA, 'ma');

    await expect(
      handle.sql`
        insert into merchant_sites (id, tenant_id, merchant_id, name, domain, normalized_domain)
          values (${randomUUID()}, ${tenantB}, ${merchantA}, 'x', 'x.example.com', 'x.example.com')
      `,
    ).rejects.toThrow(/merchant_sites_merchant_tenant_fk|foreign key/i);
  });
});

describe.skipIf(!reachable)('merchants: partial unique VERIFIED index', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = makeTestDbHandle();
    await cleanup(handle);
  });
  afterAll(async () => {
    await cleanup(handle);
    await handle.close();
  });

  it('multiple UNVERIFIED rows across tenants can share the same normalized_domain', async () => {
    const tA = await ensureTenant(handle, 'pua');
    const tB = await ensureTenant(handle, 'pub');
    const mA = await ensureMerchant(handle, tA, 'pma');
    const mB = await ensureMerchant(handle, tB, 'pmb');
    const domain = 'shared-unverified.example';
    await handle.sql`
      insert into merchant_sites (id, tenant_id, merchant_id, name, domain, normalized_domain)
        values (${randomUUID()}, ${tA}, ${mA}, 'A', ${domain}, ${domain})
    `;
    await handle.sql`
      insert into merchant_sites (id, tenant_id, merchant_id, name, domain, normalized_domain)
        values (${randomUUID()}, ${tB}, ${mB}, 'B', ${domain}, ${domain})
    `;
    // No error → confirms UNVERIFIED duplicates are permitted cross-tenant.
    const rows = await handle.sql`
      select count(*)::int as c from merchant_sites where normalized_domain = ${domain}
    `;
    expect((rows[0] as { c: number }).c).toBe(2);
  });

  it('promoting a second tenant\'s row to VERIFIED for the same domain is rejected by the partial unique index', async () => {
    const tA = await ensureTenant(handle, 'pva');
    const tB = await ensureTenant(handle, 'pvb');
    const mA = await ensureMerchant(handle, tA, 'pma');
    const mB = await ensureMerchant(handle, tB, 'pmb');
    const domain = 'contested.example';
    const idA = randomUUID();
    const idB = randomUUID();
    await handle.sql`
      insert into merchant_sites (id, tenant_id, merchant_id, name, domain, normalized_domain)
        values (${idA}, ${tA}, ${mA}, 'A', ${domain}, ${domain})
    `;
    await handle.sql`
      insert into merchant_sites (id, tenant_id, merchant_id, name, domain, normalized_domain)
        values (${idB}, ${tB}, ${mB}, 'B', ${domain}, ${domain})
    `;
    // First tenant wins.
    await handle.sql`
      update merchant_sites set verification_status = 'VERIFIED', verified_at = now() where id = ${idA}
    `;
    // Second tenant's promotion is rejected by the partial unique index.
    await expect(
      handle.sql`
        update merchant_sites set verification_status = 'VERIFIED', verified_at = now() where id = ${idB}
      `,
    ).rejects.toThrow(/merchant_sites_verified_domain_unique|unique/i);
  });
});

// ===========================================================================
// RLS enforcement under fiyatucuz_app (missing tenant context fails closed)
// ===========================================================================

describe.skipIf(!reachable)('merchants: RLS fail-closed on missing app.tenant_id', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = makeTestDbHandle();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('SELECT on merchants as fiyatucuz_app without app.tenant_id raises', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        return tx.execute(sql`select * from merchants`);
      }),
    ).rejects.toThrow();
  });

  it('SELECT on merchant_sites as fiyatucuz_app without app.tenant_id raises', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        return tx.execute(sql`select * from merchant_sites`);
      }),
    ).rejects.toThrow();
  });

  it('INSERT with wrong tenant_id is blocked by RLS WITH CHECK on merchants', async () => {
    // Seed two tenants so the WITH CHECK has a real cross-tenant target.
    const tA = await ensureTenant(handle, 'wcA');
    const tB = await ensureTenant(handle, 'wcB');
    void tA; // tA is bound in app.tenant_id below; we try to insert a merchant for tB
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        await tx.execute(sql`select set_config('app.tenant_id', ${tA}, true)`);
        await tx.execute(
          sql`insert into merchants (id, tenant_id, name, slug)
              values (${randomUUID()}, ${tB}, 'x', 'wrongtenant-slug')`,
        );
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/db] merchants.test.ts: skipping — PG unreachable.');
}
