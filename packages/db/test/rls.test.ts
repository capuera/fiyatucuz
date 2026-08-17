import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

/**
 * These tests connect as the migrating superuser (`fiyatucuz` in dev) and
 * use SET LOCAL ROLE to *switch effective identity* to `fiyatucuz_app`
 * inside a transaction, so the queries are actually subject to RLS. That is
 * the standard PG test pattern for RLS behavior and mirrors what the
 * production app path looks like.
 */

async function seedFixtureData(handle: DbHandle): Promise<{
  tenantA: string;
  tenantB: string;
  userAlpha: string;
  userBeta: string;
  membershipA: string;
  membershipB: string;
}> {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userAlpha = randomUUID();
  const userBeta = randomUUID();
  const membershipA = randomUUID();
  const membershipB = randomUUID();

  // Bypass RLS via superuser to seed cross-tenant fixture data.
  await handle.sql`
    insert into tenants (id, name, slug) values
      (${tenantA}, 'Tenant A', ${'rls-a-' + tenantA.slice(0, 8)}),
      (${tenantB}, 'Tenant B', ${'rls-b-' + tenantB.slice(0, 8)})
  `;
  await handle.sql`
    insert into users (id, email, email_normalized) values
      (${userAlpha}, 'alpha@example.com', 'alpha@example.com'),
      (${userBeta},  'beta@example.com',  'beta@example.com')
  `;
  await handle.sql`
    insert into tenant_users (id, tenant_id, user_id, role) values
      (${membershipA}, ${tenantA}, ${userAlpha}, 'OWNER'),
      (${membershipB}, ${tenantB}, ${userBeta},  'OWNER')
  `;
  return { tenantA, tenantB, userAlpha, userBeta, membershipA, membershipB };
}

async function cleanupFixtureData(handle: DbHandle): Promise<void> {
  await handle.sql`truncate table tenant_users, tenants, users cascade`;
}

describe.skipIf(!reachable)('RLS — tenant_users tenant isolation', () => {
  let handle: DbHandle;
  let fixture: Awaited<ReturnType<typeof seedFixtureData>>;

  beforeAll(async () => {
    handle = makeTestDbHandle();
    await cleanupFixtureData(handle);
    fixture = await seedFixtureData(handle);
  });

  afterAll(async () => {
    await cleanupFixtureData(handle);
    await handle.close();
  });

  it('RLS is enabled and forced on tenant_users', async () => {
    const rows = await handle.db.execute(sql`
      select relrowsecurity, relforcerowsecurity
        from pg_class
       where relname = 'tenant_users'
    `);
    const r = (rows as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>)[0];
    expect(r?.relrowsecurity).toBe(true);
    expect(r?.relforcerowsecurity).toBe(true);
  });

  it('the tenant_users_isolation policy is defined for fiyatucuz_app', async () => {
    const rows = await handle.db.execute(sql`
      select polname, polroles::regrole[] as roles
        from pg_policy
       where polrelid = 'public.tenant_users'::regclass
         and polname  = 'tenant_users_isolation'
    `);
    expect((rows as Array<unknown>).length).toBe(1);
    const roleArray = ((rows as Array<{ roles: string[] }>)[0]?.roles ?? []).map(String);
    expect(roleArray.some((r) => r.includes('fiyatucuz_app'))).toBe(true);
  });

  it('missing tenant context FAILS CLOSED (raises inside the app role)', async () => {
    // Fresh connection could not have set app.tenant_id; SET LOCAL ROLE
    // fiyatucuz_app switches to a role that RLS applies to; select on
    // tenant_users then evaluates current_setting('app.tenant_id')::uuid
    // which raises "unrecognized configuration parameter" (never set) or
    // "invalid input syntax for type uuid" (empty after LOCAL revert).
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        return tx.execute(sql`select * from tenant_users`);
      }),
    ).rejects.toThrow();
  });

  it('tenant A context sees only tenant A rows', async () => {
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
      await tx.execute(sql`select set_config('app.tenant_id', ${fixture.tenantA}, true)`);
      return tx.execute(sql`select tenant_id from tenant_users`);
    });
    const list = (rows as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
    expect(list).toEqual([fixture.tenantA]);
  });

  it('tenant B context sees only tenant B rows', async () => {
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
      await tx.execute(sql`select set_config('app.tenant_id', ${fixture.tenantB}, true)`);
      return tx.execute(sql`select tenant_id from tenant_users`);
    });
    const list = (rows as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
    expect(list).toEqual([fixture.tenantB]);
  });

  it('tenant A context cannot UPDATE tenant B rows', async () => {
    // Under RLS with FOR ALL, UPDATE with a WHERE that matches only
    // invisible rows returns 0 rows updated — silent no-op, not an error.
    const affected = await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
      await tx.execute(sql`select set_config('app.tenant_id', ${fixture.tenantA}, true)`);
      const result = await tx.execute(
        sql`update tenant_users set status = 'SUSPENDED' where id = ${fixture.membershipB}`,
      );
      // postgres-js execute returns an array-like result with `count`.
      return (result as unknown as { count: number }).count ?? 0;
    });
    expect(affected).toBe(0);

    // Confirm via a superuser query that tenant B row is still ACTIVE.
    const check = await handle.sql`
      select status from tenant_users where id = ${fixture.membershipB}
    `;
    expect((check[0] as { status: string } | undefined)?.status).toBe('ACTIVE');
  });

  it('tenant A context cannot DELETE tenant B rows', async () => {
    const affected = await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
      await tx.execute(sql`select set_config('app.tenant_id', ${fixture.tenantA}, true)`);
      const result = await tx.execute(
        sql`delete from tenant_users where id = ${fixture.membershipB}`,
      );
      return (result as unknown as { count: number }).count ?? 0;
    });
    expect(affected).toBe(0);

    const check = await handle.sql`
      select 1 as ok from tenant_users where id = ${fixture.membershipB}
    `;
    expect(check.length).toBe(1);
  });

  it('tenant A context CAN update its own rows', async () => {
    const affected = await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
      await tx.execute(sql`select set_config('app.tenant_id', ${fixture.tenantA}, true)`);
      const result = await tx.execute(
        sql`update tenant_users set status = 'SUSPENDED' where id = ${fixture.membershipA}`,
      );
      return (result as unknown as { count: number }).count ?? 0;
    });
    expect(affected).toBe(1);

    // Reset for downstream tests.
    await handle.sql`
      update tenant_users set status = 'ACTIVE' where id = ${fixture.membershipA}
    `;
  });

  it('INSERT with the wrong tenant_id fails via WITH CHECK', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_app`));
        await tx.execute(sql`select set_config('app.tenant_id', ${fixture.tenantA}, true)`);
        await tx.execute(
          sql`insert into tenant_users (id, tenant_id, user_id, role) values
              (${randomUUID()}, ${fixture.tenantB}, ${fixture.userBeta}, 'MEMBER')`,
        );
      }),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/db] rls.test.ts: skipping integration tests — PG unreachable.');
}
