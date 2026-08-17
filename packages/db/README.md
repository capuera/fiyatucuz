# @fiyatucuz/db

Database foundation for FiyatUcuz.

Owns:
- PostgreSQL 16 connection pool (postgres.js driver)
- Drizzle ORM client
- Transaction helpers
- **Tenant transaction context** (transaction-scoped `app.tenant_id` GUC — the substrate for RLS)
- Drizzle Kit migration configuration
- The schema barrel that all bounded contexts contribute to

Does **not** own: Redis, business schemas, repository implementations.

See [ADR-0004](../../adr/0004-multi-tenancy-model.md), [ADR-0005](../../adr/0005-orm-drizzle.md), and [ADR-0012](../../adr/0012-database-foundation.md) for the decisions this package implements.

## Public API

```ts
import {
  // primary handle + tenant context
  loadDbEnv,
  createDbHandle,
  transaction,
  withTenantTransaction,
  TENANT_GUC,
  type DbHandle,
  type Db,
  type Tx,
  type Sql,

  // migrations (hand-written SQL, not diff-generated)
  applyMigrations,
  listAppliedMigrations,
  MIGRATIONS_TABLE,

  // reporting handle — BYPASSRLS role, read-only transactions
  loadReportingDbEnv,
  createReportingHandle,
  withReportingTransaction,
} from '@fiyatucuz/db';
```

### Boot pattern (services/api, workers)

```ts
const env = loadDbEnv(process.env);
const { db, sql, close } = createDbHandle(env);
// db is lazy — no TCP connection until first query.

// On SIGTERM/SIGINT:
await close();
```

### Plain transaction

```ts
await transaction(db, async (tx) => {
  await tx.insert(someTable).values({ /* ... */ });
});
```

### Tenant-scoped transaction

```ts
await withTenantTransaction(db, tenantId, async (tx) => {
  // Every query inside this callback runs with app.tenant_id bound.
  // RLS policies filter on current_setting('app.tenant_id')::uuid.
});
```

The GUC is set via `set_config('app.tenant_id', $1, true)` — the parameterized,
transaction-local equivalent of `SET LOCAL`. Never uses session-scoped `SET`,
so it is safe under pgBouncer transaction pooling.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | *required* | `postgres://user:pass@host:port/db` |
| `DATABASE_POOL_MAX` | `10` | Max connections per process. Size for `(pool_max × replicas) ≤ pg_max_connections`. |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `10` | TCP + handshake timeout. |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `30` | Close idle connections after this. |
| `DATABASE_MAX_LIFETIME_SECONDS` | `1800` | Recycle connections to survive PgBouncer/PG restarts cleanly. |
| `DATABASE_PREPARED_STATEMENTS` | `false` | **Keep false for pgBouncer transaction mode.** Enable only when connecting direct-to-Postgres. |
| `DATABASE_SSL` | `false` | Set `require` in staging/prod. |
| `REPORTING_DATABASE_URL` | *required by `loadReportingDbEnv` only* | Separate URL for the reporting/BYPASSRLS role. `loadReportingDbEnv` hard-fails if missing; **no silent fallback** to `DATABASE_URL`. |

## Migrations

FiyatUcuz migrations are **hand-written** SQL — extensions, roles, RLS policies, and partitioned tables are not expressible via Drizzle diff. Files live in `packages/db/drizzle/*.sql` and are applied in ascending filename order by our custom runner.

```bash
pnpm --filter @fiyatucuz/db db:migrate     # apply pending migrations
pnpm --filter @fiyatucuz/db db:generate    # (future) diff current schema → new SQL
pnpm --filter @fiyatucuz/db db:studio      # local schema browser
```

Every migration file must be **idempotent** (`CREATE ... IF NOT EXISTS`, `DO $$ IF NOT EXISTS ... $$`). Each file runs inside its own transaction opened by the migrator — do not add `BEGIN`/`COMMIT`. See ADR-0012 §Migration mechanism.

The foundation migration `0001_foundation.sql` creates the `pgcrypto` and `pg_trgm` extensions plus the `fiyatucuz_app` (RLS-enforced) and `fiyatucuz_reporting` (BYPASSRLS) roles. No domain tables.

## Reporting handle

The reporting handle uses a **separate** DB connection URL (`REPORTING_DATABASE_URL`) so BYPASSRLS credentials cannot accidentally reach tenant-facing code paths.

```ts
const env = loadReportingDbEnv(process.env);
const { db, close } = createReportingHandle(env);

await withReportingTransaction(db, async (tx) => {
  // SET TRANSACTION READ ONLY has been issued; writes are rejected.
  // SET LOCAL statement_timeout is bounded (default 30s).
  // BYPASSRLS applies at the role level → cross-tenant SELECTs work.
});

await close();
```

See ADR-0012 §Role and RLS bypass model for why the reporting role uses `BYPASSRLS` rather than `SET row_security = off` (which does not bypass RLS).

## pgBouncer compatibility

- Prepared statements are **off by default** (`prepare: false` in postgres.js) so
  the client works under **pgBouncer transaction pooling** without server-side
  statement cache collisions.
- Tenant context uses **transaction-local** `set_config(..., is_local := true)`,
  never `SET` (session-scoped). Safe across connection re-use.
- No `LISTEN`/`NOTIFY` from the API path (would require session pooling). Wire
  it from a dedicated worker with a direct-to-Postgres connection if needed.

## Money, IDs, partitioning — conventions

Documented in the codebase but **not implemented** in this sprint:

- **Money:** `bigint` in **minor units** + explicit ISO-4217 currency column. Never `float`/`double`/`numeric` for balances. JSON boundaries must serialize `bigint` as string (JSON has no bigint literal).
- **IDs:** sortable, generated in application code, stored as PostgreSQL `uuid`. No `pg_ulid` extension.
- **Partitioning:** `tracking_events`, `price_history`, `audit_log` will be declared via **hand-written migrations** (Drizzle diff does not model partitions). The Drizzle schema keeps the *logical* table shape for typing.

## Outbox

Also **not implemented** in this sprint. Convention:

- The outbox table lives in PostgreSQL.
- Every state change that must be published downstream (Redis, OpenSearch) writes an outbox row **in the same transaction** as the state change. No dual-writes.
- A dispatcher (initially in-process, later a worker) drains outbox rows into Redis/OpenSearch. The API path never writes to Redis or OpenSearch directly.

## Testing

```bash
pnpm --filter @fiyatucuz/db test
```

Integration tests connect to the local Docker PostgreSQL (`fiyatucuz-postgres`)
using the same `DATABASE_URL` conventions as the API. If PostgreSQL is not
reachable, integration test suites **skip cleanly** with a warning; unit tests
(env parsing, drizzle config) always run.
