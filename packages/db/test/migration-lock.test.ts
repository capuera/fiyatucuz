import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_FAILURE, EXIT_OK, runMigrationCli } from '../src/cli/run-migrations.js';
import {
  applyMigrations,
  getMigrationStatus,
  holdsMigrationLock,
  MIGRATION_LOCK_NAMESPACE,
  MIGRATION_LOCK_RESOURCE,
  MigrationLockLostError,
  MigrationLockUnavailableError,
  MIGRATIONS_TABLE,
  releaseMigrationLock,
  tryAcquireMigrationLock,
  type DbHandle,
  type Sql,
} from '../src/index.js';

import {
  EXPECTED_TEST_DATABASE,
  isPostgresReachable,
  makeTestDbHandle,
  resolveDatabaseUrl,
} from './helpers.js';

const reachable = await isPostgresReachable();
const REPO_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

// ===========================================================================
// Unit — lock key
// ===========================================================================

describe('migration lock key', () => {
  it('is the fixed two-int4 key: namespace "FYAU", resource 1', () => {
    expect(MIGRATION_LOCK_NAMESPACE).toBe(Buffer.from('FYAU', 'ascii').readUInt32BE(0));
    expect(MIGRATION_LOCK_NAMESPACE).toBeLessThanOrEqual(0x7fffffff); // fits a positive int4
    expect(MIGRATION_LOCK_RESOURCE).toBe(1);
  });

  it('errors carry no connection details', () => {
    expect(new MigrationLockUnavailableError().message).toMatch(
      /^another migration process is already running/,
    );
    expect(new MigrationLockLostError().message).not.toMatch(/postgres:\/\//);
  });
});

// ===========================================================================
// Integration — real advisory locks on the guarded test database. Apply runs
// use a throwaway schema (search_path) + temp migrations dir, so the shared
// tracking table is never touched. "Runner A" is an explicit lock holder on
// its own connection: synchronization is by lock ownership, not by timing.
// ===========================================================================

describe.skipIf(!reachable)('migration advisory lock (ADIM 15A-2)', () => {
  let admin: DbHandle;
  let schema: string;
  let dir: string;
  let scoped: Sql;
  let holderClient: ReturnType<typeof postgres> | null;

  const connect = (searchPath?: string) =>
    postgres(resolveDatabaseUrl(), {
      max: 1,
      prepare: false,
      onnotice: () => {},
      ...(searchPath ? { connection: { search_path: searchPath } } : {}),
    });

  /** Runner A: hold the migration lock on a dedicated session. */
  async function holdLock(): Promise<{ pid: number; release: () => Promise<void> }> {
    holderClient = connect();
    const conn = await holderClient.reserve();
    expect(await tryAcquireMigrationLock(conn)).toBe(true);
    const [row] = await conn<{ pid: number }[]>`select pg_backend_pid() as pid`;
    return {
      pid: row!.pid,
      release: async () => {
        await releaseMigrationLock(conn);
        conn.release();
      },
    };
  }

  /** Backends currently holding the migration lock in this database. */
  async function lockHolderPids(): Promise<number[]> {
    const rows = await admin.sql<{ pid: number }[]>`
      select pid from pg_locks
       where locktype = 'advisory'
         and database = (select oid from pg_database where datname = current_database())
         and classid = ${MIGRATION_LOCK_NAMESPACE}::int4::oid
         and objid = ${MIGRATION_LOCK_RESOURCE}::int4::oid
         and objsubid = 2 and granted
    `;
    return rows.map((r) => r.pid);
  }

  async function exists(relation: string): Promise<boolean> {
    const rows = await scoped<
      { present: boolean }[]
    >`select to_regclass(${relation}::text) is not null as present`;
    return rows[0]?.present ?? false;
  }

  async function trackedIds(): Promise<string[]> {
    const rows = await scoped<
      { id: string }[]
    >`select id from ${scoped(MIGRATIONS_TABLE)} order by id`;
    return rows.map((r) => r.id);
  }

  const writeMigration = (name: string, body: string) => writeFile(join(dir, name), body, 'utf8');

  beforeAll(() => {
    admin = makeTestDbHandle();
  });
  afterAll(async () => {
    await admin.close();
  });

  beforeEach(async () => {
    holderClient = null;
    schema = `mig15a2_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await admin.sql.unsafe(`create schema ${schema}`);
    dir = await mkdtemp(join(tmpdir(), 'fiyatucuz-mig15a2-'));
    scoped = connect(schema);
  });
  afterEach(async () => {
    // Ending the holder session releases any lock it still holds.
    if (holderClient) await holderClient.end({ timeout: 2 });
    await scoped.end({ timeout: 2 });
    await admin.sql.unsafe(`drop schema if exists ${schema} cascade`);
    await rm(dir, { recursive: true, force: true });
    expect(await lockHolderPids()).toEqual([]);
  });

  it('runner B fails fast while runner A holds the lock, and writes nothing', async () => {
    await writeMigration('0001_a.sql', 'create table t_a (id int);');
    const a = await holdLock();

    const started = Date.now();
    await expect(applyMigrations(scoped, dir)).rejects.toBeInstanceOf(
      MigrationLockUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(2000); // no waiting on the lock

    expect(await exists(MIGRATIONS_TABLE)).toBe(false); // tracking table not even created
    expect(await exists('t_a')).toBe(false);
    expect(await lockHolderPids()).toEqual([a.pid]); // A still owns it

    // A releases → the next runner applies normally and releases in turn.
    await a.release();
    expect(await applyMigrations(scoped, dir)).toEqual({ applied: ['0001_a.sql'], skipped: [] });
    expect(await lockHolderPids()).toEqual([]);
  });

  it('successful apply releases the lock', async () => {
    await writeMigration('0001_a.sql', 'create table t_a (id int);');
    await applyMigrations(scoped, dir);
    expect(await lockHolderPids()).toEqual([]);
    const a = await holdLock(); // acquirable again
    await a.release();
  });

  it('failed migration: rollback, no tracking row, lock released', async () => {
    await writeMigration('0001_ok.sql', 'create table t_ok (id int);');
    await writeMigration('0002_fail.sql', 'create table t_fail (id int); select 1 / 0;');

    await expect(applyMigrations(scoped, dir)).rejects.toThrow(/division by zero/);
    expect(await trackedIds()).toEqual(['0001_ok.sql']);
    expect(await exists('t_ok')).toBe(true);
    expect(await exists('t_fail')).toBe(false);
    expect(await lockHolderPids()).toEqual([]);
  });

  it('unexpected exception (missing migrations dir) still releases the lock', async () => {
    await expect(applyMigrations(scoped, join(dir, 'does-not-exist'))).rejects.toThrow(/ENOENT/);
    expect(await lockHolderPids()).toEqual([]);
  });

  it('a lock lost mid-run is detected before the next file is applied', async () => {
    // 0001 drops the lock from inside the session (simulates a recycled
    // connection); the ownership check must stop 0002.
    await writeMigration(
      '0001_drop_lock.sql',
      `select pg_advisory_unlock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_RESOURCE});`,
    );
    await writeMigration('0002_after.sql', 'create table t_after (id int);');

    await expect(applyMigrations(scoped, dir)).rejects.toBeInstanceOf(MigrationLockLostError);
    expect(await trackedIds()).toEqual(['0001_drop_lock.sql']);
    expect(await exists('t_after')).toBe(false);
  });

  it('closing the holder session releases the lock (PostgreSQL session semantics)', async () => {
    await holdLock();
    expect(await lockHolderPids()).toHaveLength(1);
    await holderClient!.end({ timeout: 2 });
    holderClient = null;
    expect(await lockHolderPids()).toEqual([]);

    await writeMigration('0001_a.sql', 'create table t_a (id int);');
    expect((await applyMigrations(scoped, dir)).applied).toEqual(['0001_a.sql']);
  });

  it('racing runners never double-apply (losers fail with the lock error)', async () => {
    await writeMigration('0001_a.sql', 'create table t_a (id int);');
    await writeMigration('0002_b.sql', 'create table t_b (id int);');
    const others = [connect(schema), connect(schema)];
    try {
      const results = await Promise.allSettled([
        applyMigrations(scoped, dir),
        ...others.map((c) => applyMigrations(c, dir)),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const f of failed) expect(f.reason).toBeInstanceOf(MigrationLockUnavailableError);
      const appliedTotal = ok.flatMap(
        (r) => (r as PromiseFulfilledResult<{ applied: string[] }>).value.applied,
      );
      expect(appliedTotal.sort()).toEqual(['0001_a.sql', '0002_b.sql']); // each file exactly once
      expect(await trackedIds()).toEqual(['0001_a.sql', '0002_b.sql']);
    } finally {
      await Promise.all(others.map((c) => c.end({ timeout: 2 })));
    }
    expect(await lockHolderPids()).toEqual([]);
  });

  it('--status takes no lock and works while another runner holds it', async () => {
    await writeMigration('0001_a.sql', 'create table t_a (id int);');
    const a = await holdLock();

    const status = await getMigrationStatus(scoped, dir);
    expect(status.pending).toEqual(['0001_a.sql']);

    const out: string[] = [];
    const code = await runMigrationCli({
      argv: ['--status'],
      env: {
        DATABASE_MIGRATION_URL: resolveDatabaseUrl(),
        DATABASE_MIGRATION_EXPECTED_DB: EXPECTED_TEST_DATABASE,
      },
      migrationsDir: REPO_MIGRATIONS_DIR,
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    expect(code).toBe(EXIT_OK);
    expect(await lockHolderPids()).toEqual([a.pid]); // still only A
    await a.release();
  });

  it('expected-DB mismatch is reported before the lock is consulted', async () => {
    const a = await holdLock(); // if the lock came first, the error would be the lock error
    const err: string[] = [];
    const code = await runMigrationCli({
      argv: [],
      env: {
        DATABASE_MIGRATION_URL: resolveDatabaseUrl(),
        DATABASE_MIGRATION_EXPECTED_DB: 'definitely_not_this_database',
      },
      migrationsDir: dir,
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toMatch(/MigrationTargetMismatchError/);
    expect(err.join('\n')).not.toMatch(/MigrationLockUnavailableError/);
    await a.release();
  });

  it('CLI apply while locked: exit 1, clear message, no secret, tracking unchanged', async () => {
    const before = await admin.sql<
      { n: number }[]
    >`select count(*)::int as n from ${admin.sql(MIGRATIONS_TABLE)}`;
    const a = await holdLock();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMigrationCli({
      argv: [],
      env: {
        DATABASE_MIGRATION_URL: resolveDatabaseUrl(),
        DATABASE_MIGRATION_EXPECTED_DB: EXPECTED_TEST_DATABASE,
      },
      migrationsDir: REPO_MIGRATIONS_DIR,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toMatch(
      /MigrationLockUnavailableError: another migration process is already running/,
    );
    expect(`${out.join('\n')}${err.join('\n')}`).not.toContain(resolveDatabaseUrl());
    const after = await admin.sql<
      { n: number }[]
    >`select count(*)::int as n from ${admin.sql(MIGRATIONS_TABLE)}`;
    expect(after[0]?.n).toBe(before[0]?.n);
    await a.release();
  });

  it('holdsMigrationLock reflects this session only', async () => {
    const a = await holdLock();
    const other = await scoped.reserve();
    try {
      expect(await holdsMigrationLock(other)).toBe(false);
    } finally {
      other.release();
    }
    await a.release();
  });
});

if (!reachable) {
  console.warn(
    '[@fiyatucuz/db] migration-lock.test.ts: skipping integration tests — test database not configured/reachable.',
  );
}
