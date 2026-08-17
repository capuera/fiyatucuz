# @fiyatucuz/validation

Foundation Zod schemas shared across backend, web, and mobile.

**Scope:** primitive validators (`UlidSchema`, `EmailSchema`, `MoneySchema`, `PageRequestSchema`, `ApiErrorSchema`).

**Out of scope:** domain schemas. Those live in the bounded context that owns them. See [ADR-0006](../../adr/0006-api-contract-openapi-first.md) — OpenAPI is authoritative; Zod validates at runtime.
