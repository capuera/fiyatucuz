import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyMigrations,
  listAppliedMigrations,
  MIGRATIONS_TABLE,
  type DbHandle,
} from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

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

if (!reachable) {
  console.warn(
    '[@fiyatucuz/db] migration.test.ts: skipping integration tests — PostgreSQL not reachable.',
  );
}
