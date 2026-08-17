---
number: 0002
title: Monorepo tooling is pnpm workspaces + Turborepo
status: superseded
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by: 0011
---

> **Superseded by [ADR-0011](0011-monorepo-pnpm-only.md) on 2026-08-08.** The project owner chose to defer Turborepo adoption until concrete build-time pain justifies it. The remainder of this ADR is preserved for historical context; do not rely on it for current architecture decisions.

# 0002 — Monorepo tooling is pnpm workspaces + Turborepo

## Context

`pnpm-workspace.yaml` is already present. The README lists Turborepo as the planned pipeline runner. The project spans web, admin, merchant, mobile, backend, workers, and shared packages — a modest monorepo that benefits from caching and orchestrated task graphs.

## Decision

- **Package management and workspace resolution:** pnpm ≥ 9.
- **Task orchestration and caching:** Turborepo.
- Root `turbo.json` defines pipelines: `lint`, `typecheck`, `test`, `build`, `dev`.
- Remote cache: enabled via GitHub Actions cache initially; upgrade to Turborepo remote cache when team size or CI minutes justify it.

## Alternatives considered

- **pnpm only, no Turborepo** — sufficient early, but re-runs everything on every CI job. Rejected because the cost of adding Turborepo later grows with the number of packages.
- **Nx** — stronger module boundary enforcement, better code-gen. Rejected because Turborepo has lower conceptual overhead and matches the README's stated intent. Revisit if governance of module boundaries becomes a real pain.
- **Yarn Berry / npm workspaces** — no compelling advantage over pnpm; pnpm's content-addressable store saves significant disk and CI time.

## Consequences

**Positive**

- Fast incremental CI (`turbo run build --filter=[HEAD^]`).
- Enforced dependency hygiene from pnpm.
- Consistent with the ecosystem the majority of contributors will already know.

**Negative**

- Turborepo config drift is a risk if not owned; pipeline changes need review discipline.
- Remote cache setup requires either GitHub Actions cache or a vendor service.

**Neutral**

- pnpm workspaces already declared; only Turborepo is a net-new addition.

## Follow-ups

- Add `turbo.json` when the first buildable package lands.
- Add root `tsconfig.base.json` and per-package `tsconfig.json` extending it.
- Add root `package.json` with pinned pnpm version via `packageManager`.
