---
number: 0009
title: Background jobs are behind an abstraction; concrete implementation deferred
status: accepted
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by:
---

# 0009 — Background jobs are behind an abstraction; concrete implementation deferred

## Context

Several planned workloads are async by nature: feed ingestion, product matching, tracking rollups, sitemap regeneration, notification delivery. The project owner directed: **design an abstraction now, do not stand up queue infrastructure until it is required**.

## Decision

- Define a minimal `JobQueue` interface in `services/api/src/lib/jobs/` (design-only in the foundation phase):

  ```ts
  interface Job<T> {
    name: string;
    payload: T;
    runAt?: Date;
    idempotencyKey?: string;
  }
  interface JobHandler<T> {
    (job: Job<T>): Promise<void>;
  }
  interface JobQueue {
    enqueue<T>(job: Job<T>): Promise<void>;
    register<T>(name: string, handler: JobHandler<T>): void;
    start(): Promise<void>;
    stop(): Promise<void>;
  }
  ```

- Ship an **in-process synchronous implementation** as the default so callers can `enqueue` today without pulling in Redis/BullMQ. This is deliberately weak; it exists to unblock development and to prove code compiles against the interface.
- When the first true async workload appears, add a Redis + BullMQ implementation behind the same interface without changing callers.
- **Idempotency:** every job carries an optional `idempotencyKey`. The BullMQ implementation, when it lands, uses this key to prevent duplicate execution.
- **Observability:** every job emission and completion produces a structured log line and (once metrics land) a counter. This lands with the first real implementation.

## Alternatives considered

- **Adopt BullMQ + Redis now** — rejected. Adds an operational dependency before any async workload exists.
- **Skip the abstraction and add BullMQ directly when needed** — rejected. Guarantees callers will grow BullMQ-specific coupling that is painful to reverse.
- **Cloud-vendor queue (SQS, PubSub, Azure Service Bus)** — rejected in the foundation phase per [ADR-0008](0008-hosting-container-first-turkey.md); adopt only after hosting is chosen and the ops trade-off is understood.

## Consequences

**Positive**

- Callers program to a stable interface from day one.
- No premature infrastructure.
- Switching to BullMQ (or any other queue) is bounded to the implementation module.

**Negative**

- The in-process implementation cannot survive process restarts or scale across processes. Any real async workload must trigger the switch to a durable implementation.
- Some queue features (delayed jobs, cron, priorities, DLQs) will need interface additions once the concrete backend supports them.

**Neutral**

- No dependency added in the foundation scaffold.

## Follow-ups

- Add the `JobQueue` interface and in-process implementation in the foundation scaffold. No handlers registered yet.
- When the first async workload lands, open a new ADR ("Adopt BullMQ + Redis for background jobs") and extend the interface as needed.
