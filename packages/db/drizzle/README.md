# Migrations

Drizzle Kit writes generated migrations here (`0001_*.sql`, `meta/`, …).

**Empty during the database-foundation sprint.** No business tables exist yet, so
there is nothing to migrate. Migrations land as bounded contexts start
contributing schemas via `packages/db/src/schema/index.ts` (see ADR-0012).

## Conventions (per ADR-0012)

- Every migration is hand-reviewable SQL. `drizzle-kit generate` produces it;
  humans read it before it ships.
- **Partitioned tables** (`tracking_events`, `price_history`, `audit_log`) are
  declared via **hand-written migrations**, not the Drizzle diff. The Drizzle
  schema keeps the *logical* table shape for typing.
- **Extensions** (`pgcrypto`, `pg_trgm`) and **roles** (`fiyatucuz_app`,
  `fiyatucuz_reporting`) will be created by the first foundation migration
  (deferred to the next sprint).
- **RLS policies** are declared alongside the tables they protect, in the same
  migration.
- **Outbox events** and their state changes must land inside the same
  transaction — no dual-writes.

## Commands

```bash
pnpm --filter @fiyatucuz/db db:generate   # diff schema → new SQL migration
pnpm --filter @fiyatucuz/db db:migrate    # apply pending migrations
pnpm --filter @fiyatucuz/db db:migrate:status  # read-only: applied / pending
pnpm --filter @fiyatucuz/db db:check      # verify migration graph integrity
pnpm --filter @fiyatucuz/db db:studio     # local schema browser
```

Credentials differ per command:

- `db:migrate` / `db:migrate:status` require `DATABASE_MIGRATION_URL` (migration-only
  credential) and `DATABASE_MIGRATION_EXPECTED_DB` (wrong-target guard). They never
  fall back to `DATABASE_URL`.
- `DATABASE_URL` is the API runtime credential; only the drizzle-kit commands
  (`db:generate`, `db:check`, `db:studio`) read it, via `drizzle.config.ts`.
