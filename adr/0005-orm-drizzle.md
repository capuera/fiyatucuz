---
number: 0005
title: Database access via Drizzle ORM
status: accepted
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by:
---

# 0005 — Database access via Drizzle ORM

## Context

FiyatUcuz uses PostgreSQL as its primary datastore ([ARCHITECTURE.md §Database](../.fiyatucuz/ARCHITECTURE.md)). Two candidates were on the table for TS DB access: **Drizzle** (SQL-first, TS-typed, honest about SQL) and **Prisma** (schema DSL, generated client, migrations built-in). The project owner directed Drizzle.

## Decision

- **ORM:** Drizzle ORM for schema definition, queries, and typed results.
- **Migrations:** Drizzle Kit for generating and applying migrations.
- **Style:** repositories at module boundaries call Drizzle; higher layers see typed value objects, not raw rows.
- **Transactions:** explicit; a repository method that mutates always accepts a transaction handle or opens one at the boundary.
- **RLS compatibility:** connection acquisition sets `app.tenant_id` per transaction (see [ADR-0004](0004-multi-tenancy-model.md)).

## Alternatives considered

- **Prisma** — great DX, but its generated client, migration engine, and query runtime add layers between the code and Postgres. The team prefers SQL clarity for a workload dominated by analytical queries, partitioning, and RLS.
- **Raw pg + hand-typed queries** — maximum control, minimum ergonomics. Rejected as too far the other way.
- **Kysely** — strong query builder, but weaker schema-first story than Drizzle. Reject in favor of Drizzle.

## Consequences

**Positive**

- SQL is visible; performance tuning is straightforward.
- Types derived from schema; no separate generation step to run in dev.
- RLS and partitioning work naturally because we own the SQL.

**Negative**

- Less automation than Prisma; the team writes more explicit code.
- Smaller ecosystem than Prisma; some integrations (e.g., admin panels) may need custom work.

**Neutral**

- Drizzle Kit migrations are code-reviewed like any other code.

## Follow-ups

- Establish the repository pattern once the first module lands.
- Define the connection-pool + tenant-set pattern (compatible with pgBouncer transaction mode).
- Add `drizzle.config.ts` and migration scripts when the first schema lands (not in the foundation phase).
