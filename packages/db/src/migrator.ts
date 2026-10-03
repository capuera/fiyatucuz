import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Sql } from './client.js';
import {
  holdsMigrationLock,
  MigrationLockLostError,
  MigrationLockUnavailableError,
  releaseMigrationLock,
  tryAcquireMigrationLock,
} from './migration-lock.js';

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
 * rolls back cleanly. The whole run holds the migration advisory lock
 * (ADR-0019): a concurrent runner fails fast with
 * MigrationLockUnavailableError and applies nothing. Do NOT add BEGIN /
 * COMMIT to the migration file itself — the migrator owns the transaction
 * boundary.
 *
 * Migrations that must run outside a transaction (e.g. CREATE INDEX
 * CONCURRENTLY) are not supported by this runner in this form; they will get
 * a dedicated code path when the first such migration lands.
 */
export async function applyMigrations(sql: Sql, dir: string): Promise<MigrationRunResult> {
  // Everything runs on ONE reserved connection: the migration advisory lock
  // is session-scoped, so lock ownership and every migration statement must
  // share a backend (a pooled `sql` may route queries to different sessions,
  // or recycle the connection). See migration-lock.ts / ADR-0019.
  const conn = await sql.reserve();
  try {
    if (!(await tryAcquireMigrationLock(conn))) {
      throw new MigrationLockUnavailableError();
    }
    try {
      return await applyMigrationsLocked(conn, dir);
    } finally {
      // Explicit release; if the session is already gone PostgreSQL has
      // released it. Never mask the original migration error.
      await releaseMigrationLock(conn).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

async function applyMigrationsLocked(conn: Sql, dir: string): Promise<MigrationRunResult> {
  await ensureMigrationsTable(conn);

  const files = await listMigrationFiles(dir);

  const rows = await conn<{ id: string }[]>`select id from ${conn(MIGRATIONS_TABLE)}`;
  const already = new Set(rows.map((r) => r.id));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (already.has(file)) {
      skipped.push(file);
      continue;
    }
    const body = await readFile(join(dir, file), 'utf8');
    // One transaction per file: migration SQL + tracking INSERT commit or
    // roll back together. Explicit BEGIN/COMMIT because a reserved
    // connection has no `.begin()` at runtime in postgres.js 3.4 (its types
    // claim otherwise); postgres.js permits BEGIN on reserved connections.
    await conn`begin`;
    try {
      // Same session as the lock holder? A recycled connection would have
      // silently lost the lock — refuse to continue in that case.
      if (!(await holdsMigrationLock(conn))) throw new MigrationLockLostError();
      await conn.unsafe(body);
      await conn`insert into ${conn(MIGRATIONS_TABLE)} (id) values (${file})`;
      await conn`commit`;
    } catch (err) {
      await conn`rollback`.catch(() => {});
      throw err;
    }
    applied.push(file);
  }

  return { applied, skipped };
}

/** Migration file IDs in `dir`, in application (lexicographic) order. */
export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

export interface MigrationStatus {
  /** False when the tracking table does not exist yet (fresh database). */
  readonly trackingTableExists: boolean;
  /** Files already recorded as applied, in file order. */
  readonly applied: readonly string[];
  /** Files not yet recorded, in the order they would be applied. */
  readonly pending: readonly string[];
  /** Recorded IDs with no matching file in `dir` (e.g. an older checkout). */
  readonly unknownApplied: readonly string[];
}

/**
 * Read-only migration status (ADIM 15A-1). Runs inside a READ ONLY
 * transaction, never calls {@link ensureMigrationsTable}, and resolves the
 * tracking table the same way the migrator does (unqualified name via the
 * session search_path) using `to_regclass`, which does not create anything.
 * A missing tracking table reports every file as pending.
 */
export async function getMigrationStatus(sql: Sql, dir: string): Promise<MigrationStatus> {
  const files = await listMigrationFiles(dir);
  const recorded = await sql.begin('read only', async (tx) => {
    const exists = await tx<{ present: boolean }[]>`
      select to_regclass(${MIGRATIONS_TABLE}::text) is not null as present
    `;
    if (!exists[0]?.present) return null;
    const rows = await tx<{ id: string }[]>`select id from ${tx(MIGRATIONS_TABLE)} order by id`;
    return rows.map((r) => r.id);
  });

  if (recorded === null) {
    return { trackingTableExists: false, applied: [], pending: files, unknownApplied: [] };
  }
  const recordedSet = new Set(recorded);
  const fileSet = new Set(files);
  return {
    trackingTableExists: true,
    applied: files.filter((f) => recordedSet.has(f)),
    pending: files.filter((f) => !recordedSet.has(f)),
    unknownApplied: recorded.filter((id) => !fileSet.has(id)),
  };
}

export interface MigrationTarget {
  readonly database: string;
  readonly user: string;
  readonly serverVersion: string;
}

/** Identity of the connected database (no credentials involved). */
export async function readMigrationTarget(sql: Sql): Promise<MigrationTarget> {
  const rows = await sql<{ database: string; user: string; server_version: string }[]>`
    select current_database() as database,
           current_user as user,
           current_setting('server_version') as server_version
  `;
  const row = rows[0];
  if (!row) throw new Error('could not read current_database()');
  return { database: row.database, user: row.user, serverVersion: row.server_version };
}

export class MigrationTargetMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly connected: string,
  ) {
    super(`Expected database: ${expected}; Connected database: ${connected}. Nothing was changed.`);
    this.name = 'MigrationTargetMismatchError';
  }
}

/** Exact (case-sensitive) match, as PostgreSQL reports the name. */
export function assertExpectedDatabase(target: MigrationTarget, expected: string): void {
  if (target.database !== expected) {
    throw new MigrationTargetMismatchError(expected, target.database);
  }
}
