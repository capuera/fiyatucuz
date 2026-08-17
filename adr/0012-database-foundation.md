---
number: 0012
title: Database foundation — packages/db, postgres.js driver, transaction-scoped tenant GUC
status: accepted
date: 2026-08-17
deciders: project owner
supersedes:
superseded-by:
---

# 0012 — Database foundation (packages/db)

## Context

[ADR-0005](0005-orm-drizzle.md) selected Drizzle ORM. [ADR-0004](0004-multi-tenancy-model.md) selected shared-schema multi-tenancy with a `tenant_id` column and phase-2 RLS enforcement. [ADR-0003](0003-modular-monolith.md) locked the deploy shape as a modular monolith with future workers.

Before any bounded context can persist state, the platform needs a single, well-defined database access surface — with pool management, transaction and tenant-context helpers, and a migration pipeline — that both `services/api` and future `services/worker-*` processes depend on.

## Decision

The database foundation ships as a workspace package: **`packages/db`** (`@fiyatucuz/db`). It owns:

- **PostgreSQL driver:** `postgres` (postgres.js).
- **ORM:** Drizzle for schema and queries; Drizzle Kit for migrations.
- **Pool:** created lazily by `postgres()`; wrapped in a `DbHandle` with a `close()` method for graceful shutdown.
- **Env contract:** `loadDbEnv(process.env)` — the single source of truth for `DATABASE_URL` and pool tuning variables. `services/api`'s env schema does not redeclare these.
- **Transactions:** `transaction(db, fn)` — commits on resolve, rolls back on throw.
- **Tenant context:** `withTenantTransaction(db, tenantId, fn)` — binds `app.tenant_id` using **`set_config(name, value, is_local := true)`**, the parameterized, transaction-local equivalent of `SET LOCAL`. Never uses session-scoped `SET`.
- **Schema barrel:** `src/schema/index.ts` — empty in this sprint. Bounded contexts contribute tables via re-export as they land.
- **Drizzle Kit config:** `drizzle.config.ts` at the package root, output to `packages/db/drizzle/`.

**Driver-level defaults:**

- `prepare: false` — prepared statements OFF by default so the client is safe under **pgBouncer transaction pooling** without server-side statement cache collisions. Enable only when connecting direct-to-Postgres.
- `max_lifetime` on connections so pooler/PG restarts recycle cleanly.
- SSL configurable via env; off in local development, `require` in staging/prod.

## Alternatives considered

- **`pg` (node-postgres)** — solid, but its prepared-statement handling under pgBouncer transaction mode is fiddlier; postgres.js exposes a first-class `prepare` toggle and a cleaner `end({ timeout })` shutdown API. Rejected.
- **Sharing the schema directly from `services/api`** — makes it impossible for a worker to import the schema without pulling Fastify, pino, and the Fastify route surface. Rejected.
- **Setting the tenant GUC with raw `SET LOCAL app.tenant_id = '...'`** — requires string interpolation (SET does not accept parameters), which is unsafe unless the input is exhaustively validated at every call site. `set_config(..., true)` accepts parameters and is functionally identical. Chosen.
- **Session-scoped `SET app.tenant_id`** — leaks across checkouts of the same physical connection under any pooler. Rejected outright.

## Consequences

**Positive**
- One package to inspect, test, and evolve for anything database-related.
- Workers can adopt the exact same pool/transaction/tenant patterns without any refactor.
- The tenant helper makes tenant leakage difficult by construction: callers cannot forget to unset (there is nothing to unset), and cannot forget to open a transaction (the helper owns it).
- pgBouncer transaction pooling works with zero further configuration.

**Negative**
- Every module must accept a `Db`/`Tx` handle rather than reaching for a global. Correct, but slightly more code.
- Prepared statements are off by default; workloads that need them (direct-to-Postgres batch jobs) must opt in via env.

**Neutral**
- The API can boot without PostgreSQL reachable because the pool is lazy; `/health` remains liveness-only.

## Conventions established (documented, not implemented in this sprint)

These belong to future bounded contexts but are recorded here so no context re-litigates them:

- **Money:** PostgreSQL `bigint` in **minor units** + a separate ISO-4217 currency column. Never `float`/`double`/`numeric` for balances. JSON boundaries serialize `bigint` as string (JSON has no bigint literal).
- **IDs:** sortable identifiers generated in **application code**, stored as PostgreSQL `uuid`. No `pg_ulid` extension — the format is a repository-layer concern.
- **Partitioned tables** (`tracking_events`, `price_history`, `audit_log`) are declared via **hand-written migration SQL**, not the Drizzle diff. The Drizzle schema keeps the *logical* table for typing.
- **Outbox pattern:** any state change that must be published downstream (Redis, OpenSearch) writes an outbox row **in the same transaction** as the state change. A dispatcher — initially in-process, later a worker — drains it. **No direct dual-writes.**
- **PostgreSQL is authoritative.** OpenSearch is a rebuildable read model; Redis is infrastructure (cache, queue, pub/sub, rate limit), never a source of truth.

## Migration mechanism (added in ADIM 8)

Drizzle Kit's built-in migrator is designed around diff-generated migrations and a `meta/_journal.json`. FiyatUcuz's migrations are **hand-written** (extensions, roles, RLS policies, partitioned tables) — the diff generator cannot express most of them. The migration runner therefore lives in this package:

- **`packages/db/src/migrator.ts`** — `applyMigrations(sql, dir)` scans `packages/db/drizzle/*.sql` in lexicographic filename order and applies each unapplied file inside its own transaction.
- **Tracking table:** `_fiyatucuz_migrations (id text primary key, applied_at timestamptz)` — created lazily; the underscore/namespace prefix means it can never collide with a domain table.
- **Idempotency:** every migration file must be safe to re-run on any state (`CREATE EXTENSION IF NOT EXISTS`, `DO $$ IF NOT EXISTS … CREATE ROLE … ELSE ALTER ROLE …`).
- **CLI:** `pnpm --filter @fiyatucuz/db db:migrate` runs `src/cli/migrate.ts`.
- **Drizzle Kit** remains in the loop for `db:generate` (produces hand-reviewable SQL for future schema diffs) and `db:studio`. The migrator applies whatever `.sql` files land in the directory.

## Foundation migration (`0001_foundation.sql`, added in ADIM 8)

The first migration is deliberately infrastructure-only. It creates:

- **Extensions:** `pgcrypto`, `pg_trgm` — foundation capabilities used by (respectively) crypto helpers and search/trigram indexes.
- **Application role `fiyatucuz_app`** — `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. RLS applies to it. Login credentials for humans/services are provisioned outside the migration and `GRANT`ed into this role.
- **Reporting role `fiyatucuz_reporting`** — same as above **plus `BYPASSRLS`**, no other elevated privileges. NOLOGIN in this migration.
- **Baseline privileges:** `GRANT USAGE ON SCHEMA public` to both roles. Nothing else. Per-table grants land with each domain migration.

The migration does **not** create any table, any login credential, any password, or any `ALTER DEFAULT PRIVILEGES` blanket grant.

## Role and RLS bypass model (added in ADIM 8)

**Important clarification about `row_security`.** `SET LOCAL row_security = off` does NOT bypass RLS. Per the PostgreSQL 16 docs, that GUC merely causes an error if a policy *would have* been applied — it is a `pg_dump` safety check, not an override. The only supported mechanisms to bypass RLS are:

1. **`BYPASSRLS` role attribute** — unconditional per-role bypass.
2. **Table ownership** — the owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set on the table.
3. **`SUPERUSER`** — bypasses every check.

**Decision.** `fiyatucuz_reporting` gets the `BYPASSRLS` attribute explicitly. This corrects the incorrect wording in ADR-0004 §Decision (which suggested `SET LOCAL row_security = off` as the bypass mechanism); see the correction note at the top of ADR-0004.

**Why `BYPASSRLS` over table-owner-based bypass:** ownership-based bypass would require the reporting role to own every domain table, which inverts the app-role/data-owner relationship (the app role must own the tables to grant itself CRUD). `BYPASSRLS` is orthogonal to ownership and doesn't distort the schema.

**Why `BYPASSRLS` is not too broad in our threat model:**

- **`NOLOGIN` in the migration** — the role has no credentials at all. Ops provisions a separate LOGIN role that `GRANT`s membership in `fiyatucuz_reporting`, and only injects those credentials into reporting workers and read-heavy analytics jobs.
- **`REPORTING_DATABASE_URL` is a separate env variable** — `loadReportingDbEnv()` hard-fails if it is missing, with no fallback to `DATABASE_URL`. This makes it impossible to accidentally hand tenant-facing code paths the BYPASSRLS credentials.
- **No write grants** — the reporting role gets `USAGE` on `public` and nothing else at foundation. Per-table `GRANT SELECT` lands with each domain migration; `INSERT`/`UPDATE`/`DELETE` are never granted.
- **Read-only enforcement at the transaction layer** — `withReportingTransaction` opens each transaction with `SET TRANSACTION READ ONLY` + a bounded `statement_timeout`. Even if a stray future grant leaked write access, the transaction rejects mutations.
- **`NOSUPERUSER`** — superuser would bypass every check (RLS, permissions, constraints), making auditing pointless. `BYPASSRLS` is the minimum privilege that satisfies the requirement.

**Privilege model summary:**

| Role | LOGIN | SUPER | CREATEDB | CREATEROLE | REPLICATION | BYPASSRLS | Default table privs |
|---|:---:|:---:|:---:|:---:|:---:|:---:|---|
| `fiyatucuz_app`       | no | no | no | no | no | **no**  | none at foundation; per-table CRUD in domain migrations |
| `fiyatucuz_reporting` | no | no | no | no | no | **yes** | none at foundation; per-table SELECT in domain migrations |

**How reporting access will evolve when domain tables are introduced:**

- Every domain migration that adds a tenant-scoped table also issues:
  - `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO fiyatucuz_app;`
  - `GRANT SELECT ON <table> TO fiyatucuz_reporting;`
  - `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;`
  - `CREATE POLICY <name> ON <table> USING (tenant_id = current_setting('app.tenant_id')::uuid);`
- The reporting role's per-table `SELECT` grants land table-by-table so grant reviews are auditable.
- If a domain table must be **cross-tenant readable by everyone**, that is a table-level decision made in that table's migration — no changes to the reporting role required.

## Follow-ups

- Repository pattern: land alongside the first bounded context (`identity` + `tenants`).
- Ops runbook: create a `fiyatucuz_reporting_login` role (LOGIN, password), `GRANT fiyatucuz_reporting TO fiyatucuz_reporting_login`, provision `REPORTING_DATABASE_URL` for reporting workers.
- Ops runbook: same shape for `fiyatucuz_app_login` once the API is deployed against a non-superuser role in staging/prod.
- BullMQ + Redis introduction ([ADR-0009](0009-jobs-abstraction-first.md)) belongs to a separate infrastructure package, not `@fiyatucuz/db`.
- When `CREATE INDEX CONCURRENTLY` becomes needed, extend the migrator with an out-of-transaction path (naming convention: `NNNN_<name>.notx.sql`).
