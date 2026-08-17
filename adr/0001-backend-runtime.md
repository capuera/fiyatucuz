---
number: 0001
title: Backend runtime is Node.js + TypeScript
status: accepted
date: 2026-08-08
deciders: project owner (sadikergun@datamedia.com.tr)
supersedes:
superseded-by:
---

# 0001 — Backend runtime is Node.js + TypeScript

## Context

The `README.md` (foundation commit) declared a **.NET 10 / ASP.NET Core** backend with SignalR and RabbitMQ. During the architecture discovery phase, the project owner explicitly redirected the backend runtime to **Node.js + TypeScript** to match the rest of the stack (Next.js web, React Native mobile, shared TS packages).

This ADR records that redirection and formally supersedes the README's stated backend direction. The README will be updated to reference this ADR.

## Decision

All backend services in the FiyatUcuz platform are implemented in **Node.js (current LTS, ≥ 20) + TypeScript in strict mode**.

- Web framework: **Fastify** — confirmed by the project owner on 2026-08-08 (no spike required).
- Language: TypeScript, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- No native code dependencies unless explicitly justified.
- No polyglot backend at MVP.

## Alternatives considered

- **.NET 10 / ASP.NET Core** _(rejected)_ — the original README direction. Rejected because it forces a language boundary between backend and frontend/mobile, prevents shared types and validation packages, and imposes a heavier operational footprint on a small team.
- **Hybrid (TS edge + .NET core services)** _(rejected)_ — highest complexity, two ecosystems, two toolchains, two deploy pipelines. Only justifiable when an existing .NET codebase or team constraint mandates it. Neither applies here.
- **Go / Rust** _(rejected)_ — high performance ceiling but breaks the shared-types goal and adds recruiting friction.

## Consequences

**Positive**

- Single language across web, mobile, backend, workers, and shared packages.
- Shared validation (Zod), types, and API-client packages become trivial.
- Faster onboarding for full-stack contributors.
- Vast ecosystem for HTTP, DB, queue, and observability.

**Negative**

- Node has weaker concurrency primitives than .NET; CPU-bound work (image processing, matching) may need worker offload.
- Startup memory is competitive with .NET but not superior.
- Some enterprise integrations have first-class .NET SDKs and only community Node SDKs.

**Neutral**

- Backend deployments will target Linux containers regardless.
- `.editorconfig` retains `.cs` and `.csproj` rules for now (harmless); may be trimmed later.

## Follow-ups

- ~~Choose HTTP framework~~ — Fastify confirmed 2026-08-08 (in this ADR).
- ORM chosen: Drizzle — see [ADR-0005](0005-orm-drizzle.md).
- API contract style chosen: OpenAPI-first — see [ADR-0006](0006-api-contract-openapi-first.md).
- Update `README.md` §Backend to reflect this decision and link here. _(done)_
