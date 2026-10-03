import type { Sql } from './client.js';

/**
 * Migration advisory lock (ADIM 15A-2, ADR-0019).
 *
 * Only one runner may apply migrations to a database at a time. We use a
 * PostgreSQL **session-level** advisory lock taken with the non-blocking
 * `pg_try_advisory_lock(int4, int4)` — a second runner fails fast instead
 * of queueing behind a deployment.
 *
 * Key: the two-int4 form, so no hashing and no JS bigint precision concern.
 *   classid = 0x46594155 — ASCII "FYAU", a fixed FiyatUcuz namespace
 *   objid   = 1          — resource "schema migrations"
 * Both are compile-time constants, hence stable across processes, hosts and
 * PostgreSQL versions (unlike `hashtext()`, which is not a stable API).
 * Advisory locks are scoped to the current database by PostgreSQL itself, so
 * runners against different databases never contend.
 *
 * Session semantics: the lock belongs to ONE backend connection. Callers
 * must acquire, verify and release it on a single reserved connection
 * (`sql.reserve()`) and run every migration statement on that same
 * connection — a pooled `sql` may route the next query to another session.
 * If the session ends (crash, network drop) PostgreSQL releases the lock.
 */

export const MIGRATION_LOCK_NAMESPACE = 0x46594155; // "FYAU"
export const MIGRATION_LOCK_RESOURCE = 1; // schema migrations

export class MigrationLockUnavailableError extends Error {
  constructor() {
    super(
      'another migration process is already running (migration lock is held); nothing was applied',
    );
    this.name = 'MigrationLockUnavailableError';
  }
}

export class MigrationLockLostError extends Error {
  constructor() {
    super(
      'migration lock is no longer held by this session; aborting before applying further migrations',
    );
    this.name = 'MigrationLockLostError';
  }
}

/** Non-blocking acquire on this session. Returns false if another session holds it. */
export async function tryAcquireMigrationLock(conn: Sql): Promise<boolean> {
  const rows = await conn<{ acquired: boolean }[]>`
    select pg_try_advisory_lock(${MIGRATION_LOCK_NAMESPACE}::int4, ${MIGRATION_LOCK_RESOURCE}::int4) as acquired
  `;
  return rows[0]?.acquired === true;
}

/** True iff THIS session (pg_backend_pid) currently holds the migration lock. */
export async function holdsMigrationLock(conn: Sql): Promise<boolean> {
  const rows = await conn<{ held: boolean }[]>`
    select exists (
      select 1 from pg_locks
       where locktype = 'advisory'
         and database = (select oid from pg_database where datname = current_database())
         and classid = ${MIGRATION_LOCK_NAMESPACE}::int4::oid
         and objid = ${MIGRATION_LOCK_RESOURCE}::int4::oid
         and objsubid = 2
         and pid = pg_backend_pid()
         and granted
    ) as held
  `;
  return rows[0]?.held === true;
}

/** Release on this session. Returns false if the session did not hold it. */
export async function releaseMigrationLock(conn: Sql): Promise<boolean> {
  const rows = await conn<{ released: boolean }[]>`
    select pg_advisory_unlock(${MIGRATION_LOCK_NAMESPACE}::int4, ${MIGRATION_LOCK_RESOURCE}::int4) as released
  `;
  return rows[0]?.released === true;
}
