# Architecture overview

This document is the long-form counterpart to `.fiyatucuz/ARCHITECTURE.md`. Read that first for the executive summary; read this for the full blueprint.

## 1. Guiding forces

FiyatUcuz's architecture is shaped by four forces:

1. **SEO is a first-class user.** The public web app must render fully on the server, expose stable URLs, and emit structured data. Anything that harms SSR performance harms revenue.
2. **Tracking is the hot path.** Click and impression endpoints are the highest-QPS surface. They must be cheap, idempotent, and fraud-aware.
3. **Merchants and money are involved.** Every billable event must be auditable and reversible. Every tenant must be strictly isolated from every other.
4. **The team is small.** No architectural choice may exceed the team's operational capacity. This forces a modular monolith, one primary datastore, and a boring stack until scale demands otherwise.

## 2. High-level topology

```
Consumers (web + mobile)          Merchants (web)          Admins (web)
        │                              │                       │
        └──────────────┬───────────────┴───────────────────────┘
                       │
                CDN (public reads)
                       │
                ┌──────▼──────┐
                │  Next.js    │  SSR/ISR for consumer, CSR for merchant/admin
                │  frontends  │
                └──────┬──────┘
                       │ HTTPS + JSON
                ┌──────▼──────┐
                │   API       │  Fastify + TS, modular monolith
                │  monolith   │
                └──┬────┬─────┘
                   │    │
             ┌─────▼┐  ┌▼──────────┐
             │  PG  │  │  Redis    │  cache, session index, BullMQ
             └──┬───┘  └─────┬─────┘
                │            │
             partitioned  ┌──▼──────────┐
             tables       │  Workers    │  feed ingest, matching, rollups
                          └──┬──────────┘
                             │
                       ┌─────▼───────┐
                       │ Object      │  S3-compatible: feed archives, media
                       │ storage     │
                       └─────────────┘

Search: OpenSearch introduced at phase 2 when Postgres FTS is no longer enough.
Observability: OpenTelemetry → traces + metrics + logs shipped to a chosen backend.
```

## 3. Trust boundaries

- **Public internet ↔ CDN** — DDoS scrubbing, WAF, TLS termination.
- **CDN ↔ frontends** — origin authentication for non-public paths.
- **Frontends ↔ API** — session cookies (web) or bearer tokens (mobile); rate limits per principal.
- **API ↔ Postgres** — network-restricted; connection strings from secret manager; least-privilege DB roles.
- **API/workers ↔ object storage** — presigned URLs preferred over broad IAM.
- **Merchant-facing endpoints ↔ merchant** — MFA optional at MVP, mandatory for high-risk actions.

## 4. Runtime processes

At the start of implementation, the platform runs as:

1. `services/api` — the Fastify monolith serving all HTTP.
2. `apps/web` — Next.js consumer site (SSR/ISR).
3. `apps/merchant` — Next.js merchant panel (CSR after login).
4. `apps/admin` — Next.js admin panel (CSR after login).

Processes added on demand:

- `services/worker-feed` — scheduled feed ingestion + normalization.
- `services/worker-matching` — product matching pipeline.
- `services/worker-tracking` — click/impression aggregation and billing.
- `services/worker-search-indexer` — appears with OpenSearch adoption.
- `services/worker-sitemap` — generates and publishes sitemap partitions.

## 5. Data topology

Single PostgreSQL cluster at MVP. Logical partitioning by concern:

- **Hot OLTP** — catalog, offers, wallet ledger, sessions.
- **Append-heavy** — tracking events (partitioned by day), audit log (partitioned by month).
- **Reporting** — read replica when reads compete with writes.

Redis:

- Cache (query results, rendered fragments).
- BullMQ queues.
- Rate limit counters.
- Ephemeral session index (revocation lookup).

Object storage:

- Raw feed archives (compliance + reprocessing).
- Product media uploads (via presigned URL flow).
- Sitemap partitions.

## 6. Domain model at a glance

Detail in `docs/architecture/bounded-contexts.md`. Core aggregates:

- **Tenant** — the merchant organization or the platform itself.
- **User** — a human principal, may belong to multiple tenants via `TenantMembership`.
- **Merchant** — the commerce-facing entity of a tenant; may own multiple `MerchantWebsite`s.
- **Product** — a normalized item in the catalog, distinct from any single merchant's SKU.
- **Offer** — a merchant's price/availability for a Product (or an unmatched item pending matching).
- **Category** and **Keyword** — taxonomy and search vocabulary.
- **Campaign** — a merchant's advertising intent, bound to a **Budget** and one or more **Placements**.
- **Placement** — how/where sponsored content is served (search sponsored, showcase, bold, keyword-targeted).
- **ClickEvent** / **ImpressionEvent** — append-only tracking primitives.
- **Attribution** — the derived record connecting an Event to a billable Campaign.
- **Wallet** — a tenant's balance; state derived from an append-only **LedgerEntry** stream.
- **Package** — a purchasable bundle of capacity (impressions, clicks, showcase days).
- **Invoice** — periodic billing artifact; references LedgerEntries.

## 7. Cross-cutting concerns

### 7.1 Authentication

See `.fiyatucuz/SECURITY.md` §3.

### 7.2 Authorization

Single `authorize(principal, permission, resource)` function. Called by an early request lifecycle hook. Failure → 403 with a machine-readable error code.

### 7.3 Correlation

Every request generates a `request_id` (ULID). Propagated via `x-request-id` header on outbound calls and included on every log line, trace span, and error payload.

### 7.4 Idempotency

Every mutating endpoint that is client-retryable accepts an `Idempotency-Key` header. Keys stored for 24h with the response payload; replays return the stored response.

### 7.5 Rate limiting

Redis token buckets. Buckets scoped by:

- Anonymous IP (public endpoints)
- Authenticated principal (private endpoints)
- Tenant (per-tenant global limit for abuse containment)
- Bucket group (auth, search, tracking, general)

### 7.6 Feature flags

Deferred. First candidate: LaunchDarkly-compatible interface with an in-DB provider; adopt SaaS only when the ops burden justifies it.

### 7.7 Internationalization

Turkish primary. Locale carried in URL prefix (`/tr/...` optional or root, TBD). All user-facing strings via i18n dictionaries; no hard-coded copy in components.

## 8. Contract strategy

- Zod schemas are the single source of truth for validation.
- OpenAPI 3.1 generated from Zod for machine consumers and docs.
- Shared clients generated from OpenAPI live in `packages/api-client`.
- Event schemas (AsyncAPI) added when the first event-driven flow lands.

Rationale: writing OpenAPI by hand invites drift; writing Zod first keeps runtime validation and static types identical.

## 9. Failure modes and posture

- **Postgres unavailable** — degraded: reads served from cache where possible, writes reject with a 503 and Retry-After.
- **Redis unavailable** — degraded: rate limits fail-open (log heavily), queues pause, in-process fallback for hot cache.
- **Search unavailable** — degraded: search endpoints fall back to Postgres FTS with a banner (once OpenSearch is adopted).
- **Object storage unavailable** — uploads reject; existing media served via CDN with long TTL.
- **A single module misbehaves** — one process, so the whole API is at risk. Mitigations: circuit breakers on outbound calls, per-route timeouts, per-tenant rate limits to bound blast radius.

## 10. Non-goals (foundation phase)

- Multi-region active-active. Single region at MVP.
- Real-time collaborative merchant tooling.
- Consumer-side checkout.
- LLM-in-the-loop features (reserved as `ai-discovery`, not implemented).
- Self-service white-label deployment.

## 11. Change control

- Any change to this document requires a PR and, if it alters an accepted ADR's direction, a superseding ADR in the same PR.
- Diagrams live inline as ASCII or as `.mmd` (Mermaid) files under `docs/architecture/diagrams/` when they land.
