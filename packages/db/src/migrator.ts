import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Sql } from './client.js';

/**
 * The tracking table that records which foundation/domain migrations have
 * been applied. Deliberately not managed by drizzle-kit's own journal because
 * FiyatUcuz migrations are hand-written (extensions, roles, RLS, partitioned
 * tables) rather than diff-generated.
 *
 * Prefixed with an underscore + project namespace so it can never collide
 * with a domain table name.
 */
export const MIGRATIONS_TABLE = '_fiyatucuz_migrations';

export interface AppliedMigration {
  readonly id: string;
  readonly applied_at: Date;
}

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Create the migrations tracking table if it does not exist. Idempotent.
 */
export async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * List the IDs of every migration recorded as applied, in application order.
 */
export async function listAppliedMigrations(sql: Sql): Promise<AppliedMigration[]> {
  await ensureMigrationsTable(sql);
  const rows = await sql<AppliedMigration[]>`
    select id, applied_at from ${sql(MIGRATIONS_TABLE)} order by id
  `;
  return rows.map((r) => ({ id: r.id, applied_at: r.applied_at }));
}

/**
 * Apply every `*.sql` file in `dir` that has not yet been recorded in the
 * tracking table. Files are applied in ascending filename order — pick names
 * like `0001_foundation.sql`, `0002_identity.sql`, etc.
 *
 * Each migration runs in its own transaction so a mid-migration failure
 * rolls back cleanly. Do NOT add BEGIN / COMMIT to the migration file
 * itself — the migrator owns the transaction boundary.
 *
 * Migrations that must run outside a transaction (e.g. CREATE INDEX
 * CONCURRENTLY) are not supported by this runner in this form; they will get
 * a dedicated code path when the first such migration lands.
 */
export async function applyMigrations(sql: Sql, dir: string): Promise<MigrationRunResult> {
  await ensureMigrationsTable(sql);

  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  const rows = await sql<{ id: string }[]>`select id from ${sql(MIGRATIONS_TABLE)}`;
  const already = new Set(rows.map((r) => r.id));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (already.has(file)) {
      skipped.push(file);
      continue;
    }
    const body = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into ${tx(MIGRATIONS_TABLE)} (id) values (${file})`;
    });
    applied.push(file);
  }

  return { applied, skipped };
}
