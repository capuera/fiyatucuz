---
number: 0004
title: Multi-tenancy uses shared schema with a tenant_id column
status: accepted
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by:
---

# 0004 — Multi-tenancy uses shared schema with a tenant_id column

> **Correction (2026-08-17, via [ADR-0012](0012-database-foundation.md)):** the phrase *"Admin/reporting queries use a dedicated role that bypasses RLS with `SET LOCAL row_security = off`"* below is **incorrect**. `SET row_security = off` does not bypass RLS — it merely raises an error if a policy would have been applied (a `pg_dump` safety check). The reporting role bypasses RLS via the **`BYPASSRLS` role attribute**; see ADR-0012 §Role and RLS bypass model for the corrected design.

## Context

FiyatUcuz is multi-tenant: many merchant tenants, one platform. Tenants share the vast majority of catalog and product-match data (that is the entire product proposition), but each has private data (offers, wallets, campaigns, analytics).

Three viable models:

- **DB-per-tenant** — full isolation, worst ops (backups, migrations, connections).
- **Schema-per-tenant** — moderate isolation, migrations run N times, connection routing complexity.
- **Shared schema + `tenant_id`** — cheapest ops, hardest to isolate; requires disciplined enforcement.

The catalog / matching / search workload requires cross-tenant reads by design; the private workload (offers, wallets, campaigns) requires strict per-tenant isolation.

## Decision

- All tenant-scoped tables have a **non-null `tenant_id uuid` column**.
- All queries that touch tenant-scoped tables must include a `tenant_id` filter.
- **Enforcement phase 1 — application layer:**
  - Repositories accept `tenantId` as an explicit argument.
  - A test harness runs each repository method with a wrong `tenantId` to prove it returns zero rows.
  - Lint rule: raw SQL touching a tenant-scoped table without a `tenant_id` predicate is a hard error.
- **Enforcement phase 2 — database layer (PostgreSQL RLS):**
  - Every tenant-scoped table has an RLS policy: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.
  - The connection pool sets `app.tenant_id` at the start of every transaction from the authenticated principal.
  - Admin/reporting queries use a dedicated role that bypasses RLS with `SET LOCAL row_security = off`.
- **Cross-tenant read paths** (public catalog, comparison pages) use explicit repository methods that do not require `tenant_id` and never expose merchant-private columns.

## Alternatives considered

- **DB-per-tenant** — rejected. Expected tenant count (hundreds to low thousands) makes migration and connection management untenable, and the shared catalog would require inter-DB references.
- **Schema-per-tenant** — rejected. Migrations run per-schema (fragile at scale), tooling complexity, connection routing overhead, no clear win over shared schema for this workload.
- **Shared schema without RLS forever** — rejected as insufficient long-term. Application-only enforcement is enough for MVP but too fragile once the codebase and team grow.

## Consequences

**Positive**

- Single migration for all tenants.
- Cross-tenant analytics is a normal query, not a distributed one.
- Cheap and simple to operate.

**Negative**

- Isolation is a discipline problem, not a physical one. One buggy query can leak.
- Row-count skew across tenants: a few large merchants can dominate table statistics and vacuum load. Requires partitioning strategy for hot tables.
- RLS adoption (phase 2) requires a connection-pool-aware architecture (per-transaction SET LOCAL).

**Neutral**

- Column choice `tenant_id uuid` is compatible with future partitioning by hash or list.

## Follow-ups

- Define the pool + tenant-set pattern (pgBouncer transaction mode vs application-level pool).
- Define partitioning strategy for tracking events and analytics rollups.
- Define the reporting role that bypasses RLS.
- Define the "wrong-tenant returns zero" test harness.
