# Local development infrastructure

PostgreSQL 16 + Redis 7 for local development.

## Start / stop

```bash
docker compose -f infra/dev/docker-compose.yml up -d
docker compose -f infra/dev/docker-compose.yml down
```

## Connection strings (dev only)

- Postgres: `postgres://fiyatucuz:fiyatucuz@localhost:5432/fiyatucuz`
- Redis: `redis://localhost:6379/0`

These match [`.env.example`](../../.env.example). Never use these credentials outside local development.
