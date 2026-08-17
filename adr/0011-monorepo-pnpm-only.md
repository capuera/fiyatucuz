---
number: 0011
title: Monorepo tooling is pnpm workspaces only (Turborepo deferred)
status: accepted
date: 2026-08-08
deciders: project owner
supersedes: 0002
superseded-by:
---

# 0011 — Monorepo tooling is pnpm workspaces only (Turborepo deferred)

## Context

[ADR-0002](0002-monorepo-tooling.md) originally accepted pnpm workspaces + Turborepo. The project owner subsequently directed: no Turborepo at this stage, no `turbo.json`, keep the build system simple, and preserve compatibility with adding Turborepo later. Turborepo may be reconsidered once build time or CI minutes become a measurable pain point.

## Decision

- **Package management and workspace resolution:** pnpm ≥ 9.
- **Task orchestration:** pnpm scripts only. No Turborepo, no `turbo.json` in this phase.
- Each workspace package exposes its own scripts (`lint`, `typecheck`, `build`, `test`, `dev`).
- The root `package.json` exposes umbrella scripts using pnpm recursion (`pnpm -r lint`, `pnpm -r typecheck`, etc.).
- All packages remain independently buildable so that Turborepo can be layered on later without restructuring: no cross-package top-level side effects, no non-standard build inputs/outputs, no reliance on runtime task ordering that a caching runner could not derive.

## Alternatives considered

- **pnpm + Turborepo now** — original ADR-0002 decision. Rejected in favor of simplicity until a measurable need appears.
- **Nx** — heavier and more opinionated; rejected on the same simplicity grounds.
- **Custom Node scripts** — reinvents pnpm's recursion for no gain.

## Consequences

**Positive**

- One less tool to configure, learn, and maintain.
- No remote cache decision required at foundation time.
- Contributors need to know only pnpm and TypeScript.

**Negative**

- No incremental / cached CI. Every job re-runs everything until Turborepo (or an equivalent) lands.
- Slower CI as the monorepo grows. Acceptable while the graph is small.

**Neutral**

- The architecture remains compatible with adding Turborepo later; the trigger will be a measurable pain point (e.g., median PR CI > 6 min, or too many redundant rebuilds).

## Follow-ups

- Do not create `turbo.json` in the foundation scaffold.
- If Turborepo (or an alternative like Nx or Moon) is later adopted, open a new ADR superseding this one and preserve the pipeline definitions Turborepo would need in the same PR.
