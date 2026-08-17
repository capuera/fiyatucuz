import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

const TABLES = [
  'users',
  'credentials',
  'oauth_identities',
  'sessions',
  'refresh_tokens',
  'tenants',
  'tenant_users',
] as const;

async function grantExists(
  handle: DbHandle,
  role: string,
  table: string,
  priv: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER',
): Promise<boolean> {
  const rows = await handle.db.execute(sql`
    select has_table_privilege(${role}, ${'public.' + table}, ${priv}) as g
  `);
  return (rows as Array<{ g: boolean }>)[0]?.g ?? false;
}

describe.skipIf(!reachable)('grants — fiyatucuz_app has CRUD on identity + tenant tables', () => {
  let handle: DbHandle;
  beforeAll(() => {
    handle = makeTestDbHandle();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('has SELECT/INSERT/UPDATE/DELETE on every table', async () => {
    for (const t of TABLES) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
        expect(await grantExists(handle, 'fiyatucuz_app', t, p), `${t}.${p}`).toBe(true);
      }
    }
  });

  it('does NOT have TRUNCATE/REFERENCES/TRIGGER', async () => {
    for (const t of TABLES) {
      for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER'] as const) {
        expect(await grantExists(handle, 'fiyatucuz_app', t, p), `${t}.${p}`).toBe(false);
      }
    }
  });
});

describe.skipIf(!reachable)('grants — fiyatucuz_reporting is SELECT-only', () => {
  let handle: DbHandle;
  beforeAll(() => {
    handle = makeTestDbHandle();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('has SELECT on every table', async () => {
    for (const t of TABLES) {
      expect(await grantExists(handle, 'fiyatucuz_reporting', t, 'SELECT'), `${t}.SELECT`).toBe(
        true,
      );
    }
  });

  it('does NOT have INSERT/UPDATE/DELETE on any table', async () => {
    for (const t of TABLES) {
      for (const p of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        expect(
          await grantExists(handle, 'fiyatucuz_reporting', t, p),
          `${t}.${p}`,
        ).toBe(false);
      }
    }
  });

  it('BYPASSRLS is preserved (cross-tenant read works)', async () => {
    // Seed two tenants + members.
    const tA = randomUUID();
    const tB = randomUUID();
    const uA = randomUUID();
    const uB = randomUUID();
    await handle.sql`truncate table tenant_users, tenants, users cascade`;
    await handle.sql`
      insert into tenants (id, name, slug) values
        (${tA}, 'A', ${'gr-a-' + tA.slice(0, 8)}),
        (${tB}, 'B', ${'gr-b-' + tB.slice(0, 8)})
    `;
    await handle.sql`
      insert into users (id, email, email_normalized) values
        (${uA}, 'ga@example.com', 'ga@example.com'),
        (${uB}, 'gb@example.com', 'gb@example.com')
    `;
    await handle.sql`
      insert into tenant_users (id, tenant_id, user_id, role) values
        (${randomUUID()}, ${tA}, ${uA}, 'OWNER'),
        (${randomUUID()}, ${tB}, ${uB}, 'OWNER')
    `;

    // Switch to reporting role and read WITHOUT setting app.tenant_id.
    const rows = await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_reporting`));
      return tx.execute(sql`select tenant_id from tenant_users`);
    });
    const tenants = (rows as Array<{ tenant_id: string }>).map((r) => r.tenant_id).sort();
    expect(tenants).toContain(tA);
    expect(tenants).toContain(tB);

    await handle.sql`truncate table tenant_users, tenants, users cascade`;
  });

  it('reporting cannot INSERT even under SET LOCAL ROLE', async () => {
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE fiyatucuz_reporting`));
        await tx.execute(
          sql`insert into users (id, email, email_normalized) values (${randomUUID()}, 'x@example.com', 'x@example.com')`,
        );
      }),
    ).rejects.toThrow(/permission denied|insufficient privilege/i);
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/db] grants.test.ts: skipping integration tests — PG unreachable.');
}
