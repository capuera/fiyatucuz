# ARCHITECTURE (Foundation)

> Executive summary. Detailed material lives in `docs/architecture/` and `adr/`.
> This document is deliberately compact. Add depth in the linked files, not here.

## 1. Shape

FiyatUcuz is a **modular monolith backend** ([ADR-0003](../adr/0003-modular-monolith.md)) surrounded by dedicated client applications and a small set of asynchronous workers (introduced only when required). All code lives in a single **pnpm workspace monorepo** ([ADR-0011](../adr/0011-monorepo-pnpm-only.md)). Turborepo is deliberately not adopted at this stage; the architecture remains compatible with adding it later.

```
                       ┌───────────────────────────────┐
                       │  Consumer web (Next.js SSR)   │  SEO-first
                       │  Merchant panel (Next.js)     │
                       │  Admin panel (Next.js)        │
                       │  Mobile (React Native + Expo) │
                       └──────────────┬────────────────┘
                                      │ HTTPS
                       ┌──────────────▼────────────────┐
                       │       API (modular monolith)  │
                       │  Fastify + TS bounded modules │
                       └──┬─────────────┬──────────────┘
                          │             │
                    Postgres         Redis (cache, queue)
                          │             │
                    Object storage    Workers (BullMQ)
                          │             │
                       (feeds, media)  (feed ingest, matching, tracking rollups)
                          │
                    OpenSearch (introduced when catalog scale demands it)
```

## 2. Runtimes and languages

- **Backend:** Node.js LTS + TypeScript, single language across web/mobile/backend/shared packages ([ADR-0001](../adr/0001-backend-runtime.md)).
- **HTTP framework:** Fastify ([ADR-0001](../adr/0001-backend-runtime.md)).
- **DB access:** Drizzle ORM + Drizzle Kit migrations ([ADR-0005](../adr/0005-orm-drizzle.md)).
- **Validation:** Zod at runtime boundaries, shared between server, web, and mobile via `packages/validation`.
- **API contract:** OpenAPI 3.1 authoritative ([ADR-0006](../adr/0006-api-contract-openapi-first.md)); typed clients generated into `packages/api-client` when endpoints exist.
- **Async:** `JobQueue` abstraction ([ADR-0009](../adr/0009-jobs-abstraction-first.md)); default in-process implementation; durable implementation (BullMQ + Redis is the leading candidate) introduced when the first async workload lands.
- **Realtime:** `Broadcaster` abstraction ([ADR-0010](../adr/0010-realtime-abstraction-first.md)); default in-process implementation; transport (WebSocket + Redis pub/sub is the leading candidate) introduced on first real use case.

## 3. Bounded contexts (initial, deferred implementation)

See `docs/architecture/bounded-contexts.md` for the full table.

Grouped by concern:

- **People:** `identity`, `users`, `tenants`, `merchants`
- **Catalog:** `catalog`, `feed`, `normalization`, `matching`, `categories`, `keywords`
- **Commerce surface:** `offers`, `pricing`, `search`
- **Advertising:** `advertising`, `campaigns`, `tracking`, `attribution`
- **Money:** `wallet`, `packages`, `billing`
- **Insight:** `analytics`, `reporting`
- **Platform:** `notifications`, `seo`, `content`, `admin`, `audit`, `outbox`
- **Reserved:** `ai-discovery` — allocated a boundary but no implementation planned in the initial phase.

The `outbox` context is a cross-module reliability primitive (see [ADR-0012](../adr/0012-database-foundation.md)): every state change that must be published downstream writes an outbox row in the same transaction as the state change, and a dispatcher drains it to Redis/OpenSearch. No direct dual-writes are permitted.

Each context becomes a module folder under `services/api/src/modules/<context>/` and — once shared types stabilize — a package under `packages/<context>-contracts/`.

## 4. Tenancy model

Shared schema, `tenant_id` column, application-layer enforcement in phase 1, PostgreSQL Row-Level Security in phase 2. See [ADR-0004](../adr/0004-multi-tenancy-model.md).

Rationale (short): the platform expects hundreds to low-thousands of merchant tenants with vastly asymmetric data volumes. Schema-per-tenant would explode migration cost; DB-per-tenant would explode ops cost. Shared schema keeps migrations single-shot and reporting cross-tenant.

## 5. Identity & access

- **Consumer auth:** Google + Apple OAuth via OpenID Connect. Email/password not planned for MVP.
- **Merchant auth:** email/password + optional TOTP MFA. Website ownership verification via DNS TXT or file drop.
- **Admin auth:** email/password + mandatory TOTP MFA + IP allowlist option.
- **Session model:** **opaque, DB-backed** session token (~24h TTL) rotated on every refresh + rotating refresh token (opaque, DB-backed, ~30 days). Both stored as HMAC-SHA256 hashes; raw values live only in `HttpOnly SameSite=Lax` cookies (see [ADR-0014](../adr/0014-auth-endpoints.md)). JWTs are not used for session/access tokens because every request still requires a revocation check against the database. Secure keychain for mobile clients.
- **RBAC:** role + permission model scoped by tenant. Roles at MVP: `platform_admin`, `platform_support`, `merchant_owner`, `merchant_staff`, `consumer`. Permissions expressed as `resource:action` and evaluated in a single authorization function per request.

## 6. API architecture

- **Contract format:** hand-authored **OpenAPI 3.1** documents in `contracts/openapi/` are authoritative ([ADR-0006](../adr/0006-api-contract-openapi-first.md)). Zod schemas are aligned with OpenAPI components and enforce runtime validation. A CI drift check keeps the two in sync.
- **Client generation:** typed client SDKs for web, mobile, admin, and merchant clients are generated from the OpenAPI documents into `packages/api-client`.
- **Transport:** JSON over HTTPS. GraphQL rejected for foundation phase (SEO/CDN/caching complexity, tenant authz overhead).
- **Versioning:** URL-prefixed (`/v1/…`). Additive changes preferred; breaking changes require a new version and a deprecation window.
- **Public/consumer read paths:** cacheable at CDN edge with tenant-agnostic keys.
- **Merchant/admin paths:** authenticated, no CDN caching, per-tenant rate limits.

## 7. Database strategy

- **PostgreSQL 16+** as the single relational store — authoritative for all transactional data ([ADR-0012](../adr/0012-database-foundation.md)).
- **ORM & migrations:** Drizzle ORM + Drizzle Kit, wrapped in the `@fiyatucuz/db` package ([ADR-0005](../adr/0005-orm-drizzle.md), [ADR-0012](../adr/0012-database-foundation.md)). Migrations are code-reviewed, deterministic, and additive.
- **Driver:** `postgres` (postgres.js) with `prepare: false` — safe under pgBouncer transaction pooling.
- **Row-Level Security:** enforced via `app.tenant_id` GUC set with transaction-local `set_config(name, value, is_local := true)` inside `withTenantTransaction` — never session-scoped `SET`. Policy shape: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.
- **IDs:** sortable identifiers generated in **application code**, stored as PostgreSQL `uuid`. No `pg_ulid` extension.
- **Money:** `bigint` in minor units + a currency column. No floats. JSON boundaries serialize `bigint` as string.
- **Time:** `timestamptz`, always UTC.
- **Partitioned tables** (`tracking_events`, `price_history`, `audit_log`) are declared via hand-written migration SQL; the Drizzle schema keeps the logical table for typing.
- **Outbox pattern** is used for any write that must be published to Redis or OpenSearch — same-transaction, dispatcher-drained. No direct dual-writes.

## 8. Search strategy

- Phase 1: Postgres full-text search (`tsvector`) + trigram indexes for product names. Sufficient up to ~1M products.
- Phase 2: OpenSearch-compatible search introduced when facet counts, typo tolerance, or query latency demand it. A dedicated `services/search-indexer` worker consumes catalog change events and reindexes.
- Merchant-visible search never returns cross-tenant leakage.

## 9. Product feed strategy

- Feed contexts: `feed` (ingest), `normalization` (attribute normalization), `matching` (cross-merchant product identity).
- Ingest pattern: pull-based scheduled fetch → object storage archive → parser → staging tables → normalization → matching → catalog upsert.
- Supported formats at MVP: XML (Google Merchant, custom XML), CSV. JSON later.
- Feed changes never mutate live offers directly; they land in a staging area and are diffed before publication.

## 10. Click / impression tracking

- **Tracking endpoints:** dedicated lightweight HTTP handlers, no session lookup on the hot path. Signed short-lived click tokens embedded in redirect URLs.
- **Write path:** append-only event log (Postgres partitioned table initially → optionally ClickHouse or Timescale if volume demands).
- **Fraud & de-dup:** per-IP + per-session + per-token deduplication windows. Bot filtering via known-bot list + heuristic scoring.
- **Aggregation:** hourly + daily rollups computed by a scheduled worker; live dashboards read rollups, not raw events.
- **Attribution:** last-click within a configurable window at MVP; extensible model interface for later.

## 11. Advertising and balance

- Balances held in `wallet` context, atomic ledger — never mutate a running total; append entries and derive.
- Click and impression billing charges the wallet at aggregation time, not on the hot event path.
- Every billable event carries a stable idempotency key so replays never double-charge.
- Packages (keyword packages, showcase slots, bold placements) are wallet-derived products with expiry and quotas.
- Ad serving decisions (which sponsored offer to show for a query) live in the `advertising` context and consult budget/eligibility via cached wallet state.
- **Payments:** wallet top-ups go through a `PaymentProvider` abstraction ([ADR-0007](../adr/0007-payment-provider-abstraction.md)). The concrete PSP is TBD and must not be referenced from the domain layer.

## 12. SEO architecture

- **Rendering:** Next.js App Router with server components; product and comparison pages SSR + ISR.
- **URLs:** stable, human-readable, Turkish-locale slugs. Canonical URLs enforced. No trailing slashes.
- **Structured data:** JSON-LD for `Product`, `Offer`, `AggregateOffer`, `BreadcrumbList`, `Organization`, `WebSite`.
- **Sitemaps:** partitioned XML sitemaps generated by a scheduled worker; sitemap index served from the web app.
- **hreflang / i18n:** Turkish primary. English optional post-MVP.
- **AI-search discoverability:** stable OpenAPI + JSON-LD + a machine-readable `/.well-known/ai-plugin.json`-style manifest are open questions.

## 13. Mobile architecture

- Expo managed workflow with EAS Build. Expo Router for file-based routing.
- Shared code with web via `packages/api-client`, `packages/types`, `packages/validation`.
- Auth: Google/Apple native SDKs → exchange for platform tokens against the API.
- Offline: read-through cache in TanStack Query; no offline mutations at MVP.

## 14. Observability

- **Logs:** structured JSON via pino. Correlation id (`request_id`) propagated per request; tenant id tagged on every log line where known.
- **Metrics:** Prometheus-compatible endpoint. RED metrics on API, per-module. Business metrics (clicks, impressions, spend) exposed alongside infra metrics.
- **Traces:** OpenTelemetry SDK. Sampling: 100% for errors, tail-based sampling for the rest.
- **Errors:** Sentry (or self-hosted alternative — decision deferred).

## 15. Security

Detail in `.fiyatucuz/SECURITY.md`. Summary:

- Least privilege everywhere.
- Every mutation authenticated, authorized, audited.
- Tenant isolation enforced at the DB layer eventually, at the repository layer always.
- Dependency review + SBOM in CI.
- Secrets rotated; short-lived tokens preferred.

## 16. Testing

- **Unit:** Vitest.
- **Integration:** Vitest + Testcontainers (real Postgres, real Redis).
- **API contract:** schema-driven — request/response validated against the same Zod schemas the runtime uses.
- **E2E web:** Playwright, running against a preview deployment.
- **E2E mobile:** Maestro or Detox — decision deferred until mobile work begins.
- **Load:** k6 for API endpoints on the hot path (tracking, search).

## 17. CI/CD

- **CI:** GitHub Actions. Jobs run on pnpm cache. Turborepo remote cache intentionally not adopted at this stage ([ADR-0011](../adr/0011-monorepo-pnpm-only.md)).
- **Required checks:** lint, typecheck, unit tests, integration tests (matrix subset), build.
- **PR workflow:** required review, required green checks, squash-merge to `master`.
- **CD:** deferred — hosting target not yet chosen ([ADR-0008](../adr/0008-hosting-container-first-turkey.md)).
- **Packaging:** every deployable service ships as an OCI container image built in CI.

## 18. Development workflow

Detail in `.fiyatucuz/DEVELOPMENT.md`.

## 19. Recommended next sprint

In priority order:

1. **Scaffold `services/api`** as a Fastify skeleton with a health check, env parsing, structured logging, and the `JobQueue` + `Broadcaster` interfaces (no handlers, no modules). No business logic.
2. **Scaffold `packages/types`, `packages/validation`, `packages/config`** — the shared surface every other package needs.
3. **Scaffold `apps/web`** minimal Next.js foundation (App Router, TypeScript strict).
4. **Scaffold `apps/mobile`** minimal Expo foundation (Expo Router, TypeScript strict).
5. **Add Postgres + Redis compose file** under `infra/dev/` for local development.
6. **Root TypeScript configuration** — `tsconfig.base.json`, per-package `tsconfig.json`.
7. **Root `package.json`** with pinned pnpm and umbrella scripts (`lint`, `typecheck`, `build`, `test`).
8. **`.env.example`** with all foundation variables documented.
9. **GitHub Actions baseline** — lint + typecheck + build on PR.
10. **First endpoint design** (deferred to a later sprint): draft OpenAPI 3.1 conventions, error envelope, and pick the OpenAPI ↔ Zod tooling.

## 20. Open questions

See `.fiyatucuz/DECISIONS.md` §Open.
