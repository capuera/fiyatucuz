---
number: 0006
title: OpenAPI 3.1 is the authoritative API contract; Zod is used for runtime validation
status: accepted
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by:
---

# 0006 — OpenAPI 3.1 is the authoritative API contract; Zod for runtime validation

## Context

Multiple clients (public web, admin panel, merchant panel, mobile, and eventually third-party integrations) consume the FiyatUcuz API. Two contract strategies were on the table:

- **OpenAPI-first**: hand-authored OpenAPI 3.1 documents are the source of truth; server and client types derive from them; Zod is used at runtime to validate parsed inputs.
- **Zod-first**: Zod schemas are the source of truth; OpenAPI is generated from them.

The project owner directed OpenAPI-first.

## Decision

- **Source of truth:** hand-authored OpenAPI 3.1 documents in `contracts/openapi/` (created when the first endpoint lands).
- **Server:** Fastify routes reference the OpenAPI operation via schema id; request/response types derive from the OpenAPI document via code generation.
- **Runtime validation:** Zod schemas are generated from (or aligned with) the OpenAPI schema components and used at the request boundary; a drift check runs in CI to prove OpenAPI and Zod stay in sync.
- **Clients:** typed client SDKs for web, mobile, and merchant/admin clients are generated from the OpenAPI documents into `packages/api-client` (once endpoints exist).
- **Versioning:** URL-prefixed (`/v1/...`). Additive-only changes within a major version; breaking changes require a new prefix and a documented deprecation window.

## Alternatives considered

- **Zod-first + generated OpenAPI** — excellent DX for TS-only teams. Rejected because it complicates non-TS consumption and treats the contract as a byproduct of one runtime's validation library. OpenAPI-first keeps the contract front-and-center for all consumers.
- **GraphQL** — rejected for foundation phase. Adds SEO/CDN caching complexity, tenant-authz depth, and query-shape unpredictability that hurts the tracking hot path.
- **gRPC** — rejected for public and mobile clients; JSON over HTTPS remains the least-friction transport.

## Consequences

**Positive**

- One authoritative contract consumable by any language.
- Docs (Redoc / Scalar) fall out of the source of truth for free.
- Third-party integrations become straightforward.

**Negative**

- More discipline required: OpenAPI documents are hand-authored, so review and consistency conventions must be enforced.
- OpenAPI ↔ Zod drift is a real risk; the CI drift check is not optional.

**Neutral**

- The generation toolchain (e.g. `openapi-typescript`, `openapi-zod-client`, or `orval`) is chosen at first-endpoint time, not in the foundation phase.

## Follow-ups

- Establish `contracts/openapi/` directory layout when the first endpoint is designed.
- Choose the generator toolchain and add a CI drift check.
- Define response error envelope and error-code taxonomy (`docs/api/errors.md`) before the first non-health endpoint.
