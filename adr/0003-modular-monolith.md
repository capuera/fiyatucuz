---
number: 0003
title: Initial deploy shape is a modular monolith
status: accepted
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by:
---

# 0003 — Initial deploy shape is a modular monolith

## Context

FiyatUcuz spans ~25 bounded contexts (identity, catalog, feed, matching, offers, pricing, search, advertising, tracking, wallet, billing, analytics, …). A microservices-first split would create ~10+ deployables before the first customer, imposing infrastructure, coordination, and observability cost the team cannot absorb pre-revenue.

At the same time, monolithic code without module discipline collapses into a big-ball-of-mud that later cannot be split.

## Decision

Backend ships as a **modular monolith**:

- One deployable, `services/api`, built as a single Fastify process.
- Each bounded context is a top-level folder under `services/api/src/modules/<context>/`.
- Cross-module communication goes through **explicit module APIs** (an index file exposing only intended-public types and functions).
- **No cross-module deep imports.** A lint rule enforces this once tooling lands.
- **Contracts live in shared packages** (`packages/*-contracts`) once they need to be consumed by clients or extracted services.
- Workers ship as separate processes (`services/worker-*`) as soon as the first async workload appears (feed ingest, tracking rollups). Workers may share code with the API via internal packages but do not share the DB connection pool.

## Alternatives considered

- **Microservices from day one** — rejected. Explosion of infrastructure, distributed-tracing complexity, and coordination overhead before product/market fit.
- **Monolith without module discipline** — rejected. Guarantees the code can never be split later.
- **Multiple bounded monoliths (e.g. one per domain family)** — rejected as premature optimization; one process is easier to operate and refactor.

## Consequences

**Positive**

- One deploy, one log stream, one DB — massively simpler operations.
- Refactoring cross-module contracts is a compile-time task, not a distributed change.
- Extracting a hot module later (e.g. tracking) is straightforward if module boundaries are honored.

**Negative**

- A memory or CPU hog in one module affects all others until extracted.
- Deploys are all-or-nothing until we invest in feature flags.
- Team must self-enforce module boundaries; lint rules are necessary but not sufficient.

**Neutral**

- The monolith target does not preclude workers, jobs, or edge functions from existing separately.

## Follow-ups

- Define the enforced module boundary lint rule (e.g. `eslint-plugin-boundaries` or `dependency-cruiser`).
- Define the criteria that trigger an extraction (an ADR: "when to split a module out of the monolith").
- Define the deployment container image and process model.
