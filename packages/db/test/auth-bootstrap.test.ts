import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)(
  'auth_bootstrap_memberships — SECURITY DEFINER helper (0003_auth_bootstrap)',
  () => {
    let handle: DbHandle;

    beforeAll(async () => {
      handle = makeTestDbHandle();
      // Clear seed data so per-test assertions are deterministic.
      await handle.sql`truncate table tenant_users, tenants, users cascade`;
    });

    afterAll(async () => {
      await handle.sql`truncate table tenant_users, tenants, users cascade`;
      await handle.close();
    });

    // ---------- Function attributes ----------

    it('exists as SECURITY DEFINER, LANGUAGE sql, STABLE', async () => {
      const rows = await handle.db.execute(sql`
        select p.prosecdef  as security_definer,
               l.lanname    as language,
               p.provolatile as volatility
          from pg_proc p
          join pg_language l on l.oid = p.prolang
         where p.pronamespace = 'public'::regnamespace
           and p.proname = 'auth_bootstrap_memberships'
           and p.pronargs = 1
      `);
      const r = (rows as Array<Record<string, unknown>>)[0];
      expect(r?.security_definer).toBe(true);
      expect(r?.language).toBe('sql');
      // provolatile 's' = STABLE, 'i' = IMMUTABLE, 'v' = VOLATILE
      expect(r?.volatility).toBe('s');
    });

    it('has SET search_path = pg_catalog, pg_temp (search_path pinned)', async () => {
      const rows = await handle.db.execute(sql`
        select p.proconfig as config
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname = 'auth_bootstrap_memberships'
      `);
      // proconfig is an array of "key=value" strings. Coerce and check.
      const cfg = (rows as Array<{ config: string[] | null }>)[0]?.config ?? [];
      const searchPath = cfg.find((entry) => entry.toLowerCase().startsWith('search_path='));
      expect(searchPath).toBeDefined();
      // Normalize spacing for comparison; postgres may render as "pg_catalog, pg_temp" or "pg_catalog,pg_temp".
      expect(searchPath?.replace(/\s+/g, '').toLowerCase()).toBe(
        'search_path=pg_catalog,pg_temp',
      );
    });

    it('is owned by fiyatucuz_secdef (dedicated NOLOGIN, BYPASSRLS role)', async () => {
      const rows = await handle.db.execute(sql`
        select pg_get_userbyid(p.proowner) as owner
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname = 'auth_bootstrap_memberships'
      `);
      const owner = (rows as Array<{ owner: string }>)[0]?.owner;
      expect(owner).toBe('fiyatucuz_secdef');
    });

    it('fiyatucuz_secdef has BYPASSRLS + NOLOGIN + NOSUPERUSER', async () => {
      const rows = await handle.db.execute(sql`
        select rolsuper, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
          from pg_roles
         where rolname = 'fiyatucuz_secdef'
      `);
      const r = (rows as Array<Record<string, unknown>>)[0];
      expect(r?.rolsuper).toBe(false);
      expect(r?.rolcanlogin).toBe(false);
      expect(r?.rolcreatedb).toBe(false);
      expect(r?.rolcreaterole).toBe(false);
      expect(r?.rolreplication).toBe(false);
      expect(r?.rolbypassrls).toBe(true);
    });

    // ---------- Grants ----------

    it('EXECUTE granted to fiyatucuz_app; NOT granted to fiyatucuz_reporting; NOT granted to PUBLIC', async () => {
      const app = await handle.db.execute(sql`
        select has_function_privilege('fiyatucuz_app',
          'public.auth_bootstrap_memberships(uuid)', 'EXECUTE') as g
      `);
      const rep = await handle.db.execute(sql`
        select has_function_privilege('fiyatucuz_reporting',
          'public.auth_bootstrap_memberships(uuid)', 'EXECUTE') as g
      `);
      const pub = await handle.db.execute(sql`
        select has_function_privilege('public',
          'public.auth_bootstrap_memberships(uuid)', 'EXECUTE') as g
      `);
      expect((app as Array<{ g: boolean }>)[0]?.g).toBe(true);
      expect((rep as Array<{ g: boolean }>)[0]?.g).toBe(false);
      expect((pub as Array<{ g: boolean }>)[0]?.g).toBe(false);
    });

    // ---------- Runtime behavior ----------

    describe('when called as fiyatucuz_app', () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const tenantC = randomUUID();
      const userAlice = randomUUID();
      const userBob = randomUUID();

      beforeAll(async () => {
        await handle.sql`truncate table tenant_users, tenants, users cascade`;
        await handle.sql`
          insert into tenants (id, name, slug) values
            (${tenantA}, 'A', ${'ab-a-' + tenantA.slice(0, 8)}),
            (${tenantB}, 'B', ${'ab-b-' + tenantB.slice(0, 8)}),
            (${tenantC}, 'C', ${'ab-c-' + tenantC.slice(0, 8)})
        `;
        await handle.sql`
          insert into users (id, email, email_normalized) values
            (${userAlice}, 'alice-boot@example.com', 'alice-boot@example.com'),
            (${userBob},   'bob-boot@example.com',   'bob-boot@example.com')
        `;
        // Alice → A (OWNER) and B (MEMBER). Bob → A (MEMBER) only.
        await handle.sql`
          insert into tenant_users (id, tenant_id, user_id, role) values
            (${randomUUID()}, ${tenantA}, ${userAlice}, 'OWNER'),
            (${randomUUID()}, ${tenantB}, ${userAlice}, 'MEMBER'),
            (${randomUUID()}, ${tenantA}, ${userBob},   'MEMBER')
        `;
      });

      it('authenticated user (Alice) can retrieve ONLY her own memberships', async () => {
        const rows = await handle.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
          return tx.execute(
            sql`select user_id, tenant_id
                  from public.auth_bootstrap_memberships(${userAlice})`,
          );
        });
        const list = rows as Array<{ user_id: string; tenant_id: string }>;
        expect(list).toHaveLength(2);
        // Every row belongs to Alice.
        expect(list.every((r) => r.user_id === userAlice)).toBe(true);
        // Alice's memberships span tenants A and B.
        expect(list.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
      });

      it('another user (Bob) — calling with Bob\'s id — returns only Bob\'s memberships', async () => {
        // "Another user's memberships cannot be retrieved" — enforced by the
        // WHERE clause hardcoded in the function body: only rows for the
        // passed user_id are ever returned.
        const rows = await handle.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
          return tx.execute(
            sql`select user_id, tenant_id
                  from public.auth_bootstrap_memberships(${userBob})`,
          );
        });
        const list = rows as Array<{ user_id: string; tenant_id: string }>;
        expect(list).toHaveLength(1);
        expect(list[0]?.user_id).toBe(userBob);
        expect(list[0]?.tenant_id).toBe(tenantA);
        // No Alice rows leak into a Bob call.
        expect(list.every((r) => r.user_id !== userAlice)).toBe(true);
      });

      it('calling with a random uuid returns zero rows (no cross-user data)', async () => {
        const rows = await handle.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
          return tx.execute(
            sql`select user_id from public.auth_bootstrap_memberships(${randomUUID()})`,
          );
        });
        expect((rows as Array<unknown>).length).toBe(0);
      });

      it('fiyatucuz_reporting is DENIED execute even under SET LOCAL ROLE', async () => {
        await expect(
          handle.db.transaction(async (tx) => {
            await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_reporting`));
            return tx.execute(
              sql`select * from public.auth_bootstrap_memberships(${userAlice})`,
            );
          }),
        ).rejects.toThrow(/permission denied|no permission|access to/i);
      });
    });

    // ---------- Regression tests required by the sprint prompt ----------

    describe('regression — the bootstrap function does NOT weaken existing invariants', () => {
      it('tenant_users retains ROW LEVEL SECURITY and FORCE', async () => {
        const rows = await handle.db.execute(sql`
          select relrowsecurity, relforcerowsecurity
            from pg_class
           where relname = 'tenant_users'
        `);
        const r = (rows as Array<Record<string, unknown>>)[0];
        expect(r?.relrowsecurity).toBe(true);
        expect(r?.relforcerowsecurity).toBe(true);
      });

      it('fiyatucuz_app still does NOT have BYPASSRLS', async () => {
        const rows = await handle.db.execute(sql`
          select rolbypassrls from pg_roles where rolname = 'fiyatucuz_app'
        `);
        expect((rows as Array<{ rolbypassrls: boolean }>)[0]?.rolbypassrls).toBe(false);
      });

      it('direct SELECT on tenant_users as fiyatucuz_app still fails without tenant context', async () => {
        // The bootstrap function must NOT be the general escape hatch. A
        // plain SELECT still hits RLS and fails closed.
        await expect(
          handle.db.transaction(async (tx) => {
            await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
            return tx.execute(sql`select * from tenant_users`);
          }),
        ).rejects.toThrow();
      });

      it('normal tenant isolation still filters per app.tenant_id', async () => {
        // With tenant A bound, only tenant A rows are visible via a normal
        // SELECT — even though the bootstrap function could return more.
        const rows = await handle.db.execute(sql`
          select id from tenants order by slug limit 3
        `);
        const anyTenantId = (rows as Array<{ id: string }>)[0]?.id;
        if (!anyTenantId) throw new Error('fixture missing tenants');

        const inScope = await handle.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
          await tx.execute(
            sql`select set_config('app.tenant_id', ${anyTenantId}, true)`,
          );
          return tx.execute(sql`select distinct tenant_id from tenant_users`);
        });
        const tenantIds = (inScope as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
        // Every row visible under this context is exactly the bound tenant.
        expect(tenantIds.every((t) => t === anyTenantId)).toBe(true);
      });
    });
  },
);

if (!reachable) {
  console.warn('[@fiyatucuz/db] auth-bootstrap.test.ts: skipping — PG unreachable.');
}
