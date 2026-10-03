---
number: 0019
title: Production database migration safety (credentials, target guard, exclusive lock, expand/contract)
status: accepted
date: 2026-10-03
deciders: project owner
supersedes:
superseded-by:
---

# 0019 — Production database migration safety

## Context

Migrations are hand-written SQL applied by our own runner (ADR-0012 §Migration mechanism): files in `packages/db/drizzle/` in lexicographic order, each in its own transaction together with its row in `_fiyatucuz_migrations`.

The ADIM 14 production rollout exposed gaps:

- The CLI loaded the API's `.env` and connected with the **runtime** credential, which deliberately has no DDL rights (`42501`). The migration was then applied by hand.
- Nothing verified _which_ database the CLI was connected to.
- There was no read-only way to see pending migrations.
- Two runners could read the same "already applied" snapshot and race on the same file (only the tracking primary key would stop the second one, after its SQL had run).
- Rollback safety of schema changes was implicit.

ADIM 15A-1 fixed the first three in code; ADIM 15A-2 adds the lock and writes the policy down. This ADR records both.

## Decision

### 1. Separate migration credential (ADIM 15A-1)

- The migration CLI connects only with `DATABASE_MIGRATION_URL` (`loadMigrationDbEnv`). **There is no fallback to `DATABASE_URL` in any environment**, and none keyed on `NODE_ENV` (whose default is `development`, so such a fallback would fail open).
- The API runtime never reads the migration credential; in production it must not live in the API's env file.
- Pool is pinned to one connection.
- Same pattern as `REPORTING_DATABASE_URL` (ADR-0012).

### 2. Expected-database guard (ADIM 15A-1)

`DATABASE_MIGRATION_EXPECTED_DB` is required. After connecting, the CLI compares it with `current_database()`. A mismatch aborts before any status read, lock or statement that could change anything.

### 3. Status is read-only and lock-free (ADIM 15A-1)

`--status`:

- runs in a `READ ONLY` transaction;
- looks up the tracking table with `to_regclass` (never creates it);
- takes **no** migration lock;
- exits `0` even when migrations are pending.

### 4. Exclusive, fail-fast migration lock (ADIM 15A-2)

`applyMigrations()` holds a PostgreSQL **session-level advisory lock** for the whole run.

- **Function:** `pg_try_advisory_lock(int4, int4)`, which is non-blocking. A second runner gets `MigrationLockUnavailableError` ("another migration process is already running"), applies nothing (not even the tracking table) and the CLI exits `1`. Deployments never queue silently behind each other.
- **Key:** two constant int4 values, `classid = 0x46594155` (ASCII `"FYAU"`) and `objid = 1` (schema migrations).
  - No hashing (`hashtext()` is not a stable API) and no JS bigint concern.
  - Advisory locks are already scoped to the current database by PostgreSQL.
- **Session ownership:**
  - The lock belongs to one backend connection. `applyMigrations()` therefore takes **one reserved connection** (`sql.reserve()`) and runs lock, tracking reads and every migration on it. A pooled `sql` may route queries to other sessions or recycle the connection.
  - Each file still runs in **one transaction**: `BEGIN` → SQL → tracking `INSERT` → `COMMIT` (or `ROLLBACK`). It is written as explicit statements because postgres.js 3.4 reserved connections have no `.begin()` at runtime; postgres.js explicitly allows `BEGIN` on reserved connections.
  - Inside each file's transaction the runner checks `pg_locks` that **this** backend (`pg_backend_pid()`) still holds the lock. Otherwise it throws `MigrationLockLostError` before applying that file.
- **Placement:** the lock lives in `applyMigrations()` itself, not in the CLI, so no caller can bypass it.
- **Order:**

  ```
  load env → connect → current_database() check → acquire lock → ensure tracking table → apply files → release lock → release connection → close
  ```

  - Release is explicit in `finally`; a failure to release never masks the migration error.
  - If the session dies, PostgreSQL releases the lock.

### 5. Expand / contract policy

Production deploys must leave the **previous application release able to run against the new schema**. That is what makes an application-only rollback possible. A schema change that breaks the old release is split:

- **Release N (expand):** additive changes the old code ignores. The new code starts using them.
- **Release N+1 or later (contract):** remove or tighten things the code no longer uses. This happens only after the release that stopped using them is in production and no longer a rollback target.

Contract changes never ship in the same deployment as the code change that makes them possible.

**Classification for review** (by humans; there is no automatic SQL linter, and keyword matching is not treated as a safety guarantee):

| Class                | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rule                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **SAFE / ADDITIVE**  | `CREATE TABLE`; `ADD COLUMN` nullable or with a constant default; new type; new index/constraint/policy/grant **on a new table**; new view                                                                                                                                                                                                                                                                                                                       | Allowed in an expand release.                                                                                        |
| **REQUIRES REVIEW**  | `CREATE INDEX` on an existing large table (blocks writes; `CONCURRENTLY` cannot run inside the runner's transaction); adding a CHECK/FK to an existing table (prefer `NOT VALID` + later `VALIDATE`); `UPDATE`/`DELETE` backfills (long transactions, row locks, FORCE RLS applies to the owner); `ALTER TYPE … ADD VALUE`; `DROP NOT NULL`; `DROP CONSTRAINT`; default changes; ownership, role, grant or RLS-policy changes on existing objects; type widening | Allowed only with a written note in the PR covering lock impact, runtime, data volume and old-release compatibility. |
| **CONTRACT / DEFER** | `DROP TABLE` / `DROP COLUMN` / `DROP TYPE`; `RENAME` of table or column; incompatible `ALTER COLUMN … TYPE`; `SET NOT NULL` where the old release may write `NULL`; tightening a CHECK; removing enum semantics; `TRUNCATE` or deleting data the old release reads                                                                                                                                                                                               | Never in the same deploy as the code change. Ship later as a separate, reviewed contract migration.                  |

Existing rules stay in force (ADR-0012):

- migration files are idempotent;
- files contain no `BEGIN`/`COMMIT`;
- statements that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`) need a dedicated runner path first.

## Rollback limitations

- There are **no down-migrations**. Application rollback is safe only because of expand/contract.
- A database rollback means restoring the pre-migration backup, which loses writes made after it.
- A failing file rolls back **only that file**. Files applied earlier in the same run stay applied, so every file must be backward-compatible on its own.
- The lock prevents concurrent runners; it does not make a run all-or-nothing.

## Alternatives considered

- **Blocking `pg_advisory_lock`** — rejected. A second deploy would hang behind the first instead of failing visibly.
- **Transaction-level lock per file (`pg_try_advisory_xact_lock`)** — rejected. It is released between files, so a second runner with a stale "applied" snapshot could slip in.
- **Lock in the CLI only** — rejected. Direct callers of `applyMigrations()` would bypass it.
- **Relying on pool `max = 1`** — rejected. postgres.js may still recycle the connection (idle/lifetime timeouts), silently dropping a session lock. Test handles also use larger pools.
- **Automatic destructive-SQL linter** — deferred. A regex is not a SQL parser and would give false confidence.

## Consequences

**Positive:**

- One runner per database, enforced by the database itself.
- Wrong-target and wrong-credential mistakes fail before any change.
- Status is safe to run at any time, even during a migration.
- The rollback contract is explicit.

**Negative / costs:**

- A crashed runner's lock lasts until PostgreSQL notices the dead session (normally immediate on a closed socket; longer on a half-open network connection).
- Expand/contract needs two releases for breaking changes.
- The review classification is manual.

## Follow-ups

- Windows deployment wrapper and secret placement for the migration credential (ADIM 15A-4).
- Dedicated least-privilege migrator role and ownership transfer (deferred; the migration credential is currently an administrative login).
- Optional automated lint for the CONTRACT class (deferred).
- Checksums of applied migration files (deferred).
