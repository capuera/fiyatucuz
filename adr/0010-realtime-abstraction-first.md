---
number: 0010
title: Realtime notifications are behind an abstraction; concrete implementation deferred
status: accepted
date: 2026-08-08
deciders: project owner
supersedes:
superseded-by:
---

# 0010 — Realtime notifications are behind an abstraction; concrete implementation deferred

## Context

Real-time push (live merchant dashboards, ad decisions, notification bells, admin alerts) is anticipated but not required in the foundation phase. The project owner directed: **design an abstraction now, do not introduce realtime infrastructure yet**.

## Decision

- Define a minimal `Broadcaster` interface in `services/api/src/lib/realtime/` (design-only in the foundation phase):

  ```ts
  type Channel = string;
  interface Broadcaster {
    publish<T>(channel: Channel, event: string, payload: T): Promise<void>;
    subscribe<T>(channel: Channel, handler: (event: string, payload: T) => void): () => void;
  }
  ```

- Ship an **in-process no-op / event-emitter implementation** as the default so callers can `publish` today without pulling in WebSockets or Redis pub/sub.
- Channels are tenant-scoped by convention (`tenant:{tenantId}:...`); the concrete implementation must enforce this at the transport boundary when it lands.
- When realtime is required, evaluate:
  - Fastify WebSocket + Redis pub/sub fan-out.
  - Server-Sent Events for one-way merchant/admin dashboards.
  - A managed provider (Ably, Pusher) — only after [ADR-0008](0008-hosting-container-first-turkey.md) cloud choice.
- **Do not** ship SignalR, Socket.IO, or any full realtime stack in the foundation phase.

## Alternatives considered

- **Adopt Socket.IO or Fastify WebSocket now** — rejected. No consumer exists; premature infrastructure.
- **Skip the abstraction and add realtime directly when needed** — rejected. Same coupling risk as [ADR-0009](0009-jobs-abstraction-first.md).

## Consequences

**Positive**

- Callers program to a stable interface from day one.
- No premature infrastructure.
- Transport choice (WS vs SSE vs managed) can be made from evidence, not guesswork.

**Negative**

- The in-process implementation does not fan out across processes; any real realtime feature requires the switch to a proper broker.
- Tenant isolation must be re-verified when a real transport is chosen.

**Neutral**

- No dependency added in the foundation scaffold.

## Follow-ups

- Add the `Broadcaster` interface and in-process implementation in the foundation scaffold. No channels defined yet.
- When realtime is required, open a new ADR ("Adopt WebSocket + Redis pub/sub for realtime") and pick the transport based on the first real use case.
