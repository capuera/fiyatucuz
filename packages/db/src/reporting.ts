import { sql } from 'drizzle-orm';

import { createDbHandle, type Db, type DbHandle } from './client.js';
import { loadDbEnv, type DbEnv } from './env.js';
import type { Tx } from './transaction.js';

/**
 * Load the reporting database environment.
 *
 * REPORTING_DATABASE_URL is a **separate** environment variable from
 * DATABASE_URL — the reporting role has the BYPASSRLS attribute and must
 * never accidentally be handed the application credentials. If
 * REPORTING_DATABASE_URL is not set, this function throws a clear error.
 * There is no silent fallback to DATABASE_URL.
 *
 * All pool-tuning variables (POOL_MAX, timeouts, prepared statements, SSL)
 * are shared with the application DbEnv so operational knobs behave the same
 * for both handles.
 */
export function loadReportingDbEnv(
  source: Record<string, string | undefined> = process.env,
): DbEnv {
  const url = source.REPORTING_DATABASE_URL;
  if (!url) {
    throw new Error(
      'REPORTING_DATABASE_URL is required. Do not reuse DATABASE_URL — the reporting role has BYPASSRLS.',
    );
  }
  // Reuse the primary DbEnvSchema by substituting the URL. This keeps a single
  // source of truth for pool tuning while routing the reporting connection to
  // its own credentials.
  return loadDbEnv({ ...source, DATABASE_URL: url });
}

/**
 * Build a reporting DbHandle from a validated DbEnv. Semantics identical to
 * {@link createDbHandle}; the distinct helper name makes call sites
 * grep-visible so a reviewer can quickly tell which code paths speak to the
 * reporting role.
 */
export function createReportingHandle(env: DbEnv): DbHandle {
  return createDbHandle(env);
}

/**
 * Run `fn` inside a **read-only** transaction on the reporting handle.
 *
 * - `SET TRANSACTION READ ONLY` — belt-and-suspenders: even if a stray GRANT
 *   ever accidentally handed the reporting role write privileges, this
 *   transaction cannot execute INSERT/UPDATE/DELETE/DDL against user tables.
 *   Scope is the current transaction only (PostgreSQL semantic), so this is
 *   safe under pgBouncer transaction pooling.
 * - `SET LOCAL statement_timeout` — bounds runaway reporting queries. Default
 *   30s; callers can override via `opts.statementTimeoutMs`.
 *
 * Not tenant-scoped: reporting queries are cross-tenant by definition and the
 * BYPASSRLS attribute on the reporting role removes the need for a
 * `app.tenant_id` GUC.
 */
export interface ReportingTransactionOptions {
  readonly statementTimeoutMs?: number;
}

export async function withReportingTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  opts: ReportingTransactionOptions = {},
): Promise<T> {
  const timeoutMs = opts.statementTimeoutMs ?? 30_000;
  return db.transaction(async (tx) => {
    // These two statements MUST be the first commands in the transaction.
    // SET TRANSACTION only affects the current transaction and must precede
    // any command that touches user data.
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql.raw(`set local statement_timeout = ${timeoutMs}`));
    return fn(tx);
  });
}
