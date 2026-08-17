import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TENANT_GUC,
  TenantContextError,
  withTenantTransaction,
  type DbHandle,
} from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

describe('withTenantTransaction — input validation (unit)', () => {
  it('rejects a non-string tenantId', async () => {
    const fakeDb = {} as never;
    await expect(
      // @ts-expect-error deliberate wrong type at runtime
      withTenantTransaction(fakeDb, 42, async () => 'noop'),
    ).rejects.toBeInstanceOf(TenantContextError);
  });

  it('rejects an empty tenantId', async () => {
    const fakeDb = {} as never;
    await expect(withTenantTransaction(fakeDb, '', async () => 'noop')).rejects.toBeInstanceOf(
      TenantContextError,
    );
  });

  it('rejects a tenantId with forbidden characters', async () => {
    const fakeDb = {} as never;
    await expect(
      withTenantTransaction(fakeDb, "abc'); drop table users;--", async () => 'noop'),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe.skipIf(!reachable)('withTenantTransaction (integration — requires local PostgreSQL)', () => {
  let handle: DbHandle;
  const TENANT_A = '01j0000000000000000000000a';
  const TENANT_B = '01j0000000000000000000000b';

  beforeAll(() => {
    handle = makeTestDbHandle();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('binds app.tenant_id inside the transaction and reverts after commit', async () => {
    const bound = await withTenantTransaction(handle.db, TENANT_A, async (tx) => {
      const rows = await tx.execute(
        sql`select current_setting(${TENANT_GUC}, true) as v`,
      );
      return (rows[0] as { v: string | null } | undefined)?.v ?? null;
    });
    expect(bound).toBe(TENANT_A);

    // After commit, in a fresh top-level query, the GUC must NOT be set — i.e.
    // it was truly transaction-scoped (LOCAL), not session-scoped.
    const after = await handle.db.execute(sql`select current_setting(${TENANT_GUC}, true) as v`);
    const value = (after[0] as { v: string | null } | undefined)?.v;
    // Postgres returns '' (empty string) when a `missing_ok` current_setting has no value.
    expect(value === '' || value === null).toBe(true);
  });

  it('reverts app.tenant_id after rollback as well', async () => {
    class Boom extends Error {}
    await expect(
      withTenantTransaction(handle.db, TENANT_B, async (tx) => {
        const rows = await tx.execute(sql`select current_setting(${TENANT_GUC}, true) as v`);
        expect((rows[0] as { v: string } | undefined)?.v).toBe(TENANT_B);
        throw new Boom('deliberate');
      }),
    ).rejects.toBeInstanceOf(Boom);

    const after = await handle.db.execute(sql`select current_setting(${TENANT_GUC}, true) as v`);
    const value = (after[0] as { v: string | null } | undefined)?.v;
    expect(value === '' || value === null).toBe(true);
  });

  it('runs each callback in its own transaction (no leakage between calls)', async () => {
    const first = await withTenantTransaction(handle.db, TENANT_A, async (tx) => {
      const rows = await tx.execute(sql`select current_setting(${TENANT_GUC}, true) as v`);
      return (rows[0] as { v: string } | undefined)?.v;
    });
    const second = await withTenantTransaction(handle.db, TENANT_B, async (tx) => {
      const rows = await tx.execute(sql`select current_setting(${TENANT_GUC}, true) as v`);
      return (rows[0] as { v: string } | undefined)?.v;
    });
    expect(first).toBe(TENANT_A);
    expect(second).toBe(TENANT_B);
  });
});

if (!reachable) {
  console.warn(
    '[@fiyatucuz/db] tenant.test.ts: skipping integration tests — PostgreSQL not reachable.',
  );
}
