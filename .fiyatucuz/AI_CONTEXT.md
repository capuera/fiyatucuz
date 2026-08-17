# AI_CONTEXT

> Machine-readable project context for AI coding agents (Claude Code, Codex, Copilot, and future agents).
> Human contributors should also read this file before making architectural changes.

## 1. Project identity

- **Name:** FiyatUcuz
- **Domain:** fiyatucuz.com
- **Repository:** https://github.com/capuera/fiyatucuz
- **One-line description:** Multi-tenant, SEO-first price comparison, product discovery, merchant traffic acquisition, and advertising platform.
- **Current phase:** Architecture foundation. No product code exists yet.

## 2. Canonical sources of truth

Rank order — earlier sources override later ones on conflict.

1. `.fiyatucuz/` — AI/human operational rules and architecture summary.
2. `adr/` — Architecture Decision Records. A merged ADR is binding until superseded by another ADR.
3. `docs/architecture/` — Detailed architecture, bounded contexts, contracts.
4. `docs/domain/` — Ubiquitous language.
5. `README.md` — Public-facing summary. **May lag behind ADRs**; when in doubt, trust the ADRs.

If a source below overrides one above (e.g. README contradicts an ADR), open a PR to reconcile the higher-precedence source — do not silently follow the older statement.

## 3. What this project is (and is not)

| Is                                                | Is not                    |
| ------------------------------------------------- | ------------------------- |
| Multi-tenant platform for merchants and consumers | Single-tenant storefront  |
| Price comparison and product discovery            | Marketplace with checkout |
| Traffic acquisition + click/impression billing    | Affiliate network         |
| SEO-first public web + native mobile              | Web-only product          |
| AI-assisted discovery (planned)                   | LLM-centric application   |
| Modular monolith backend (initial)                | Microservice-first        |

## 4. Bounded-context registry (see `docs/architecture/bounded-contexts.md`)

`identity`, `tenants`, `merchants`, `catalog`, `feed`, `normalization`, `matching`, `offers`, `pricing`, `search`, `categories`, `keywords`, `advertising`, `campaigns`, `tracking` (clicks + impressions), `attribution`, `wallet`, `packages`, `billing`, `analytics`, `notifications`, `seo`, `content`, `admin`, `audit`, `ai-discovery` _(reserved, deferred)_.

## 5. Non-negotiable rules for AI agents

1. **Never** run `git commit`, `git push`, `git reset --hard`, `git clean -fd`, or force-push unless the user explicitly asks in the same turn.
2. **Never** delete or rewrite files under `adr/` — supersede them with a new ADR instead.
3. **Never** install a new runtime, framework, or heavy dependency without an ADR.
4. **Never** silently change a bounded context boundary.
5. **Always** prefer editing existing files to creating new ones.
6. **Always** state the smallest coherent change, then implement only that change.
7. When multiple valid choices exist, **explain trade-offs and recommend one** — do not pick silently.
8. If a business rule is ambiguous, **stop and ask** rather than invent it.

## 6. Current architectural commitments (short form)

Full detail lives in the linked ADRs.

| Commitment                                                                             | Source                                                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Backend runtime: **Node.js + TypeScript**, HTTP via **Fastify**                        | [ADR-0001](../adr/0001-backend-runtime.md)                                                         |
| Monorepo tooling: **pnpm workspaces only**, no Turborepo yet                           | [ADR-0011](../adr/0011-monorepo-pnpm-only.md) (supersedes [0002](../adr/0002-monorepo-tooling.md)) |
| Deploy shape: **modular monolith first**                                               | [ADR-0003](../adr/0003-modular-monolith.md)                                                        |
| Tenancy model: **shared schema, `tenant_id` column, RLS follow-up**                    | [ADR-0004](../adr/0004-multi-tenancy-model.md)                                                     |
| Primary datastore: **PostgreSQL** via **Drizzle ORM**                                  | [ADR-0005](../adr/0005-orm-drizzle.md)                                                             |
| API contract: **OpenAPI 3.1 authoritative**, **Zod** for runtime validation            | [ADR-0006](../adr/0006-api-contract-openapi-first.md)                                              |
| Payment provider: **abstraction only**, PSP TBD                                        | [ADR-0007](../adr/0007-payment-provider-abstraction.md)                                            |
| Hosting: **container-first**, Turkey-preferred residency, cloud TBD                    | [ADR-0008](../adr/0008-hosting-container-first-turkey.md)                                          |
| Background jobs: **`JobQueue` abstraction**, in-process default, durable impl deferred | [ADR-0009](../adr/0009-jobs-abstraction-first.md)                                                  |
| Realtime: **`Broadcaster` abstraction**, in-process default, transport deferred        | [ADR-0010](../adr/0010-realtime-abstraction-first.md)                                              |
| Cache: **Redis** (used as it becomes needed)                                           | ARCHITECTURE.md §Async                                                                             |
| Search: **OpenSearch-compatible** (introduced only when catalog scale requires it)     | ARCHITECTURE.md §Search                                                                            |
| Web framework: **Next.js (App Router)**                                                | ARCHITECTURE.md §Web                                                                               |
| Mobile framework: **React Native + Expo (Expo Router)**                                | ARCHITECTURE.md §Mobile                                                                            |

## 7. Directory conventions (target, not current)

```
.fiyatucuz/     Operational rules, architecture summary, decisions index (AI-facing)
adr/            Architecture Decision Records
docs/           Human-facing product & technical documentation
apps/           Deployable frontends (web, admin, merchant, mobile)
services/       Deployable backend services (api monolith, workers as they emerge)
packages/       Shared TS libraries (types, validation, ui, auth, api-client, config)
contracts/      API + event contracts (OpenAPI, Zod, AsyncAPI)
schemas/        DB schemas, JSON Schema, feed schemas
infra/          IaC, Docker, deployment manifests
knowledge/      Ubiquitous language, glossary, machine-readable domain knowledge
scripts/        One-off maintenance and developer scripts
tests/          Cross-cutting integration/e2e assets
```

**A directory only exists once it has justified content.** Do not scaffold empty placeholders.

## 8. Repository state on foundation completion

- Existing files preserved: `README.md`, `pnpm-workspace.yaml`, `.editorconfig`, `.gitattributes`, `.gitignore`.
- No application code, no dependencies installed, no build system, no CI configured yet.
- Next sprint priorities live in `.fiyatucuz/ARCHITECTURE.md` §Recommended next sprint.

## 9. When you (the AI agent) are unsure

Read in this order:

1. This file.
2. `.fiyatucuz/PROJECT_RULES.md`
3. `.fiyatucuz/ARCHITECTURE.md`
4. Relevant ADR under `adr/`
5. The specific `docs/*` subdirectory for the concern.

If a question is not answered by any of the above, **ask the user before writing code**.
