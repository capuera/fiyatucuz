# Bounded-context modules

Each bounded context registered in [`docs/architecture/bounded-contexts.md`](../../../../docs/architecture/bounded-contexts.md) lives as a top-level folder here (`identity/`, `tenants/`, `merchants/`, `catalog/`, …) when its implementation begins.

**Rules (per [ADR-0003](../../../../adr/0003-modular-monolith.md)):**

- Each module exposes a `index.ts` that names its public API. Other modules import only from there.
- No deep imports across modules.
- No cross-module direct DB access — go through the owning module's API.

No modules exist yet — the foundation phase only wires the process, health check, and abstractions.
