import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  loadReportingDbEnv,
  withReportingTransaction,
  type DbHandle,
} from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

describe('loadReportingDbEnv (unit)', () => {
  it('rejects a missing REPORTING_DATABASE_URL — no silent fallback', () => {
    expect(() => loadReportingDbEnv({})).toThrow(/REPORTING_DATABASE_URL/);
  });

  it('rejects a missing REPORTING_DATABASE_URL even if DATABASE_URL is present', () => {
    // Silent reuse would hand reporting the app credentials — the exact
    // failure mode the design forbids.
    expect(() =>
      loadReportingDbEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' }),
    ).toThrow(/REPORTING_DATABASE_URL/);
  });

  it('parses a valid REPORTING_DATABASE_URL and inherits pool defaults', () => {
    const env = loadReportingDbEnv({
      REPORTING_DATABASE_URL: 'postgres://reporting:x@localhost:5432/db',
    });
    expect(env.DATABASE_URL).toBe('postgres://reporting:x@localhost:5432/db');
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.DATABASE_PREPARED_STATEMENTS).toBe(false);
  });
});

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)(
  'withReportingTransaction (integration — requires local PostgreSQL)',
  () => {
    let handle: DbHandle;
    const TX_PROBE_TABLE = 'fiyatucuz_reporting_probe';

    beforeAll(async () => {
      handle = makeTestDbHandle();
      // Probe table used only to verify read-only enforcement. Owned by the
      // connecting user (fiyatucuz superuser in dev), not the reporting role.
      await handle.db.execute(sql.raw(`drop table if exists ${TX_PROBE_TABLE}`));
      await handle.db.execute(
        sql.raw(`create table ${TX_PROBE_TABLE} (id integer primary key)`),
      );
    });

    afterAll(async () => {
      try {
        await handle.db.execute(sql.raw(`drop table if exists ${TX_PROBE_TABLE}`));
      } finally {
        await handle.close();
      }
    });

    it('sets transaction_read_only = on inside the callback', async () => {
      const value = await withReportingTransaction(handle.db, async (tx) => {
        const rows = await tx.execute(sql`select current_setting('transaction_read_only') as v`);
        return (rows as Array<{ v: string }>)[0]?.v;
      });
      expect(value).toBe('on');
    });

    it('applies the requested statement_timeout for the transaction', async () => {
      const value = await withReportingTransaction(
        handle.db,
        async (tx) => {
          const rows = await tx.execute(sql`select current_setting('statement_timeout') as v`);
          return (rows as Array<{ v: string }>)[0]?.v;
        },
        { statementTimeoutMs: 5000 },
      );
      // Postgres reports statement_timeout with unit; 5000ms → '5s'.
      expect(value).toBe('5s');
    });

    it('rejects writes against user tables while the tx is read-only', async () => {
      await expect(
        withReportingTransaction(handle.db, async (tx) => {
          await tx.execute(sql.raw(`insert into ${TX_PROBE_TABLE} (id) values (999)`));
        }),
      ).rejects.toThrow(/read-only|read only/i);
    });
  },
);

describe('createReportingHandle exists as an exported factory (unit)', () => {
  it('is a function', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.createReportingHandle).toBe('function');
  });
});

if (!reachable) {
  console.warn(
    '[@fiyatucuz/db] reporting.test.ts: skipping integration tests — PostgreSQL not reachable.',
  );
}
