# DECISIONS

Index of accepted, proposed, and open architectural decisions.

Full ADRs live under `adr/`. This file is the fast-lookup index.

## Accepted

| #                                                     | Title                | Status   | Summary                                                            |
| ----------------------------------------------------- | -------------------- | -------- | ------------------------------------------------------------------ |
| [0001](../adr/0001-backend-runtime.md)                | Backend runtime      | accepted | Node.js + TypeScript. Fastify confirmed.                           |
| [0003](../adr/0003-modular-monolith.md)               | Initial deploy shape | accepted | Modular monolith; extract services only when justified.            |
| [0004](../adr/0004-multi-tenancy-model.md)            | Multi-tenancy model  | accepted | Shared schema, `tenant_id` column, RLS as phase-2 hardening.       |
| [0005](../adr/0005-orm-drizzle.md)                    | ORM                  | accepted | Drizzle ORM + Drizzle Kit migrations.                              |
| [0006](../adr/0006-api-contract-openapi-first.md)     | API contract style   | accepted | OpenAPI 3.1 authoritative; Zod for runtime validation.             |
| [0007](../adr/0007-payment-provider-abstraction.md)   | Payment provider     | accepted | Provider abstraction; concrete PSP TBD.                            |
| [0008](../adr/0008-hosting-container-first-turkey.md) | Hosting              | accepted | Container-first, Turkey-preferred residency; cloud TBD.            |
| [0009](../adr/0009-jobs-abstraction-first.md)         | Background jobs      | accepted | `JobQueue` abstraction; in-process default; durable impl deferred. |
| [0010](../adr/0010-realtime-abstraction-first.md)     | Realtime             | accepted | `Broadcaster` abstraction; in-process default; transport deferred. |
| [0011](../adr/0011-monorepo-pnpm-only.md)             | Monorepo tooling     | accepted | pnpm workspaces only; Turborepo deferred; remain compatible.       |

## Superseded

| #                                       | Title            | Superseded by                                 |
| --------------------------------------- | ---------------- | --------------------------------------------- |
| [0002](../adr/0002-monorepo-tooling.md) | pnpm + Turborepo | [ADR-0011](../adr/0011-monorepo-pnpm-only.md) |

## Open questions requiring the user (TBD)

These are genuinely unresolved — do not invent answers.

1. **Payment provider selection** — Iyzico / Craftgate / PayTR / Stripe / other. Blocked on business input (fees, KYC, coverage, settlement cadence). Domain is provider-agnostic per [ADR-0007](../adr/0007-payment-provider-abstraction.md).
2. **Cloud vendor / hosting** — Turkish provider, AWS Istanbul, GCP, Azure, self-managed VPS. Architecture is container-portable per [ADR-0008](../adr/0008-hosting-container-first-turkey.md); vendor choice deferred to a business decision.
3. **English locale at MVP** — Turkish primary confirmed; English support TBD (impacts SEO and content pipeline).
4. **Frontend styling library** — Tailwind is the assumed default. Confirm before real UI work begins.
5. **Error tracking** — Sentry SaaS vs self-hosted alternative. Cost/ops decision before launch.
6. **CI cache and remote build cache** — currently none. Revisit if CI time becomes painful.
7. **Legal domicile of the operating company** — impacts KVKK vs GDPR posture and data residency policy fine print.

## ADR process

- New decision → new file `adr/NNNN-slug.md` from `adr/template.md`.
- Change decision → new ADR that `supersedes: NNNN` in its front-matter. Update the superseded ADR's status to `superseded` and add `superseded-by: NNNN`. Do not delete the superseded ADR.
- Merged ADR is binding. To change behavior, first update the ADR.
