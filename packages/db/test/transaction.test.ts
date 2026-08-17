import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { transaction, type DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('transaction (integration — requires local PostgreSQL)', () => {
  let handle: DbHandle;
  const TEMP_TABLE = 'fiyatucuz_tx_probe';

  beforeAll(async () => {
    handle = makeTestDbHandle();
    // A dedicated probe table lets us verify commit-vs-rollback without touching
    // any domain tables (there are none yet). Isolated to this test file.
    await handle.db.execute(sql.raw(`drop table if exists ${TEMP_TABLE}`));
    await handle.db.execute(
      sql.raw(`create table ${TEMP_TABLE} (id integer primary key, note text not null)`),
    );
  });

  afterAll(async () => {
    try {
      await handle.db.execute(sql.raw(`drop table if exists ${TEMP_TABLE}`));
    } finally {
      await handle.close();
    }
  });

  it('commits when the callback resolves', async () => {
    await transaction(handle.db, async (tx) => {
      await tx.execute(sql.raw(`insert into ${TEMP_TABLE} (id, note) values (1, 'committed')`));
    });

    const rows = await handle.db.execute(
      sql.raw(`select note from ${TEMP_TABLE} where id = 1`),
    );
    const first = rows[0] as { note: string } | undefined;
    expect(first?.note).toBe('committed');
  });

  it('rolls back when the callback throws', async () => {
    class Boom extends Error {}
    await expect(
      transaction(handle.db, async (tx) => {
        await tx.execute(sql.raw(`insert into ${TEMP_TABLE} (id, note) values (2, 'rolled-back')`));
        throw new Boom('deliberate');
      }),
    ).rejects.toBeInstanceOf(Boom);

    const rows = await handle.db.execute(
      sql.raw(`select count(*)::int as c from ${TEMP_TABLE} where id = 2`),
    );
    const first = rows[0] as { c: number } | undefined;
    expect(first?.c).toBe(0);
  });
});

if (!reachable) {
  console.warn(
    '[@fiyatucuz/db] transaction.test.ts: skipping integration tests — PostgreSQL not reachable.',
  );
}
