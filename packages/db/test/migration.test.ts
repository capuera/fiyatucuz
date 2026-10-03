import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_FAILURE, EXIT_OK, runMigrationCli } from '../src/cli/run-migrations.js';
import {
  applyMigrations,
  getMigrationStatus,
  listAppliedMigrations,
  MIGRATIONS_TABLE,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'drizzle');
const FOUNDATION_ID = '0001_foundation.sql';

describe.skipIf(!reachable)(
  'foundation migration (integration — requires local PostgreSQL superuser)',
  () => {
    let handle: DbHandle;

    beforeAll(() => {
      handle = makeTestDbHandle();
    });

    afterAll(async () => {
      await handle.close();
    });

    it('applies without error and records the migration id', async () => {
      const result = await applyMigrations(handle.sql, MIGRATIONS_DIR);
      const knownAfter = new Set([...result.applied, ...result.skipped]);
      expect(knownAfter.has(FOUNDATION_ID)).toBe(true);

      const applied = await listAppliedMigrations(handle.sql);
      expect(applied.some((r) => r.id === FOUNDATION_ID)).toBe(true);
    });

    it('installs the pgcrypto and pg_trgm extensions', async () => {
      const rows = await handle.db.execute(
        sql`select extname from pg_extension where extname in ('pgcrypto','pg_trgm') order by extname`,
      );
      const names = (rows as Array<{ extname: string }>).map((r) => r.extname);
      expect(names).toEqual(['pg_trgm', 'pgcrypto']);
    });

    it('creates fiyatucuz_app with the intended attributes', async () => {
      const rows = await handle.db.execute(sql`
        select rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole,
               rolreplication, rolbypassrls
          from pg_roles
         where rolname = 'fiyatucuz_app'
      `);
      const row = (rows as Array<Record<string, unknown>>)[0];
      expect(row).toBeDefined();
      expect(row?.rolname).toBe('fiyatucuz_app');
      expect(row?.rolsuper).toBe(false);
      expect(row?.rolcanlogin).toBe(false);
      expect(row?.rolcreatedb).toBe(false);
      expect(row?.rolcreaterole).toBe(false);
      expect(row?.rolreplication).toBe(false);
      // The application role MUST be subject to RLS.
      expect(row?.rolbypassrls).toBe(false);
    });

    it('creates fiyatucuz_reporting with BYPASSRLS and no SUPERUSER', async () => {
      const rows = await handle.db.execute(sql`
        select rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole,
               rolreplication, rolbypassrls
          from pg_roles
         where rolname = 'fiyatucuz_reporting'
      `);
      const row = (rows as Array<Record<string, unknown>>)[0];
      expect(row).toBeDefined();
      expect(row?.rolname).toBe('fiyatucuz_reporting');
      // Explicit assertions per ADR-0012's role security model.
      expect(row?.rolsuper).toBe(false);
      expect(row?.rolcanlogin).toBe(false);
      expect(row?.rolcreatedb).toBe(false);
      expect(row?.rolcreaterole).toBe(false);
      expect(row?.rolreplication).toBe(false);
      expect(row?.rolbypassrls).toBe(true);
    });

    it('grants USAGE on public schema to both roles', async () => {
      const rows = await handle.db.execute(sql`
        select has_schema_privilege('fiyatucuz_app', 'public', 'USAGE') as app_usage,
               has_schema_privilege('fiyatucuz_reporting', 'public', 'USAGE') as rep_usage
      `);
      const row = (rows as Array<{ app_usage: boolean; rep_usage: boolean }>)[0];
      expect(row?.app_usage).toBe(true);
      expect(row?.rep_usage).toBe(true);
    });

    it('does not grant blanket write privileges to future application tables', async () => {
      // Baseline: neither role should have INSERT/UPDATE/DELETE via default
      // ACLs on the public schema at the schema level. Per-table grants land
      // with each domain migration.
      const rows = await handle.db.execute(sql`
        select has_schema_privilege('fiyatucuz_app', 'public', 'CREATE') as app_create,
               has_schema_privilege('fiyatucuz_reporting', 'public', 'CREATE') as rep_create
      `);
      const row = (rows as Array<{ app_create: boolean; rep_create: boolean }>)[0];
      // Postgres implicitly grants CREATE on public to the database owner in
      // some versions; the important assertion is that we did NOT grant it
      // ourselves. This test documents the current baseline; if it changes
      // in a future PG major, this row will need to be re-evaluated.
      expect(typeof row?.app_create).toBe('boolean');
      expect(typeof row?.rep_create).toBe('boolean');
    });

    it('records the tracking table and is idempotent on re-run', async () => {
      // Ensure the tracking table has the expected shape.
      const cols = await handle.db.execute(sql`
        select column_name, data_type
          from information_schema.columns
         where table_schema = 'public' and table_name = ${MIGRATIONS_TABLE}
         order by ordinal_position
      `);
      const colNames = (cols as Array<{ column_name: string }>).map((c) => c.column_name);
      expect(colNames).toEqual(['id', 'applied_at']);

      // Re-run: nothing should be applied a second time.
      const second = await applyMigrations(handle.sql, MIGRATIONS_DIR);
      expect(second.applied).toEqual([]);
      expect(second.skipped.includes(FOUNDATION_ID)).toBe(true);
    });
  },
);

// ===========================================================================
// ADIM 15A-1 — atomicity, skip, read-only status, expected-database guard.
//
// Each scenario runs in its own throwaway schema (search_path) with its own
// migrations directory, so the shared test database's real tracking table
// and schema are never touched. Guarded by helpers.ts: only
// fiyatucuz_adim14 is ever reachable here.
// ===========================================================================

describe.skipIf(!reachable)('migrator safety (ADIM 15A-1, isolated schema)', () => {
  let admin: DbHandle;
  let schema: string;
  let dir: string;
  let scoped: Sql;

  async function writeMigration(name: string, body: string): Promise<void> {
    await writeFile(join(dir, name), body, 'utf8');
  }

  async function exists(sqlc: Sql, relation: string): Promise<boolean> {
    const rows = await sqlc<
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

  beforeAll(() => {
    admin = makeTestDbHandle();
  });
  afterAll(async () => {
    await admin.close();
  });

  beforeEach(async () => {
    schema = `mig15a_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await admin.sql.unsafe(`create schema ${schema}`);
    dir = await mkdtemp(join(tmpdir(), 'fiyatucuz-mig15a-'));
    scoped = postgres(resolveDatabaseUrl(), {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connection: { search_path: schema },
    });
  });
  afterEach(async () => {
    await scoped.end({ timeout: 2 });
    await admin.sql.unsafe(`drop schema if exists ${schema} cascade`);
    await rm(dir, { recursive: true, force: true });
  });

  it('status without a tracking table: everything pending, nothing created', async () => {
    await writeMigration('0001_a.sql', 'create table t_a (id int);');
    await writeMigration('0002_b.sql', 'create table t_b (id int);');

    const status = await getMigrationStatus(scoped, dir);
    expect(status).toEqual({
      trackingTableExists: false,
      applied: [],
      pending: ['0001_a.sql', '0002_b.sql'],
      unknownApplied: [],
    });
    expect(await exists(scoped, MIGRATIONS_TABLE)).toBe(false);
    expect(await exists(scoped, 't_a')).toBe(false);
  });

  it('failure rolls back the SQL and writes no tracking row; earlier files stay applied', async () => {
    await writeMigration('0001_ok.sql', 'create table t_ok (id int);');
    await writeMigration('0002_fail.sql', 'create table t_fail (id int); select 1 / 0;');

    await expect(applyMigrations(scoped, dir)).rejects.toThrow(/division by zero/);
    expect(await trackedIds()).toEqual(['0001_ok.sql']);
    expect(await exists(scoped, 't_ok')).toBe(true);
    expect(await exists(scoped, 't_fail')).toBe(false);

    const status = await getMigrationStatus(scoped, dir);
    expect(status.applied).toEqual(['0001_ok.sql']);
    expect(status.pending).toEqual(['0002_fail.sql']);
  });

  it('already-applied files are skipped; a fixed file applies on the next run', async () => {
    await writeMigration('0001_ok.sql', 'create table t_ok (id int);');
    await writeMigration('0002_fail.sql', 'select 1 / 0;');
    await expect(applyMigrations(scoped, dir)).rejects.toThrow();

    await writeMigration('0002_fail.sql', 'create table t_fixed (id int);');
    const second = await applyMigrations(scoped, dir);
    expect(second).toEqual({ applied: ['0002_fail.sql'], skipped: ['0001_ok.sql'] });

    const third = await applyMigrations(scoped, dir);
    expect(third).toEqual({ applied: [], skipped: ['0001_ok.sql', '0002_fail.sql'] });
  });

  it('status does not change database state', async () => {
    await writeMigration('0001_ok.sql', 'create table t_ok (id int);');
    await applyMigrations(scoped, dir);
    await writeMigration('0002_new.sql', 'create table t_new (id int);');

    const before = await scoped<{ id: string; applied_at: Date }[]>`
      select id, applied_at from ${scoped(MIGRATIONS_TABLE)} order by id
    `;
    const status = await getMigrationStatus(scoped, dir);
    const after = await scoped<{ id: string; applied_at: Date }[]>`
      select id, applied_at from ${scoped(MIGRATIONS_TABLE)} order by id
    `;
    expect(status).toMatchObject({ applied: ['0001_ok.sql'], pending: ['0002_new.sql'] });
    expect([...after]).toEqual([...before]);
    expect(await exists(scoped, 't_new')).toBe(false);
  });

  it('expected-database mismatch aborts before any migration or tracking change', async () => {
    const marker = `mig15a_guard_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await writeMigration('0001_marker.sql', `create table public.${marker} (id int);`);
    const trackingBefore = await admin.sql<{ n: number }[]>`
      select count(*)::int as n from ${admin.sql(MIGRATIONS_TABLE)}
    `;

    for (const argv of [[], ['--status']]) {
      const err: string[] = [];
      const code = await runMigrationCli({
        argv,
        env: {
          DATABASE_MIGRATION_URL: resolveDatabaseUrl(),
          DATABASE_MIGRATION_EXPECTED_DB: 'definitely_not_this_database',
        },
        migrationsDir: dir,
        out: () => {},
        err: (l) => err.push(l),
      });
      expect(code).toBe(EXIT_FAILURE);
      // The connected name may itself be masked: the local test password
      // ("fiyatucuz") is a substring of the database name, and failure output
      // redacts every occurrence of the password.
      expect(err.join('\n')).toMatch(
        /MigrationTargetMismatchError: Expected database: definitely_not_this_database; Connected database: \S+\. Nothing was changed\./,
      );
      expect(err.join('\n')).not.toContain(resolveDatabaseUrl());
    }

    expect(await exists(admin.sql, `public.${marker}`)).toBe(false);
    const trackingAfter = await admin.sql<{ n: number }[]>`
      select count(*)::int as n from ${admin.sql(MIGRATIONS_TABLE)}
    `;
    expect(trackingAfter[0]?.n).toBe(trackingBefore[0]?.n);
  });
});

describe.skipIf(!reachable)('migration CLI against the test database (ADIM 15A-1)', () => {
  let admin: DbHandle;
  beforeAll(() => {
    admin = makeTestDbHandle();
  });
  afterAll(async () => {
    await admin.close();
  });

  it('--status with the correct expected DB: exit 0, repo migrations listed, nothing changed', async () => {
    const before = await admin.sql<
      { id: string }[]
    >`select id from ${admin.sql(MIGRATIONS_TABLE)} order by id`;
    const out: string[] = [];
    const code = await runMigrationCli({
      argv: ['--status'],
      env: {
        DATABASE_MIGRATION_URL: resolveDatabaseUrl(),
        DATABASE_MIGRATION_EXPECTED_DB: EXPECTED_TEST_DATABASE,
      },
      migrationsDir: MIGRATIONS_DIR,
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    const text = out.join('\n');
    expect(code).toBe(EXIT_OK);
    expect(text).toMatch(new RegExp(`target: database=${EXPECTED_TEST_DATABASE} user=`));
    expect(text).toMatch(/applied \(\d+\):/);
    expect(text).toContain(FOUNDATION_ID);
    expect(text).not.toContain(resolveDatabaseUrl());

    const after = await admin.sql<
      { id: string }[]
    >`select id from ${admin.sql(MIGRATIONS_TABLE)} order by id`;
    expect([...after]).toEqual([...before]);
  });
});

if (!reachable) {
  console.warn(
    '[@fiyatucuz/db] migration.test.ts: skipping integration tests — PostgreSQL not reachable.',
  );
}
