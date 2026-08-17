# @fiyatucuz/api

FiyatUcuz backend API. Modular monolith, Fastify, TypeScript strict.

**Foundation state:** health check only. No business logic, no bounded-context modules, no DB, no auth.

## Local run

```bash
pnpm --filter @fiyatucuz/api dev
curl http://localhost:4000/health
curl http://localhost:4000/ready
```

Reads env vars documented in [`.env.example`](../../.env.example).

## Structure

```
src/
  index.ts          # process entry, signal handling
  server.ts         # Fastify factory (buildServer)
  config/env.ts     # Zod-validated env
  lib/logger.ts     # pino logger
  routes/health.ts  # /health and /ready
  lib/jobs/         # JobQueue abstraction (ADR-0009)
  lib/realtime/     # Broadcaster abstraction (ADR-0010)
  modules/          # bounded-context modules land here (empty in foundation phase)
```

## References

- [ADR-0001 backend runtime](../../adr/0001-backend-runtime.md)
- [ADR-0003 modular monolith](../../adr/0003-modular-monolith.md)
- [ADR-0005 ORM (Drizzle)](../../adr/0005-orm-drizzle.md)
- [ADR-0006 API contract (OpenAPI-first)](../../adr/0006-api-contract-openapi-first.md)
- [ADR-0008 hosting (container-first)](../../adr/0008-hosting-container-first-turkey.md)
- [ADR-0009 background jobs abstraction](../../adr/0009-jobs-abstraction-first.md)
- [ADR-0010 realtime abstraction](../../adr/0010-realtime-abstraction-first.md)
