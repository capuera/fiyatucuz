# DEVELOPMENT

> This document describes the intended developer workflow. Most of it is not yet implemented — items marked _(planned)_ will land as the foundation is built out.

## Prerequisites _(planned)_

- Node.js LTS (>= 20)
- pnpm >= 9
- Docker Desktop (for Postgres, Redis, OpenSearch)
- Git

## Repository install _(planned)_

```bash
pnpm install
```

## Local infrastructure _(planned)_

```bash
docker compose -f infra/dev/docker-compose.yml up -d
```

Provides:

- PostgreSQL on `localhost:5432`
- Redis on `localhost:6379`
- (later) OpenSearch on `localhost:9200`

## Running an app _(planned)_

```bash
pnpm --filter @fiyatucuz/api dev
pnpm --filter @fiyatucuz/web dev
pnpm --filter @fiyatucuz/mobile start
```

## Workspaces

Defined in `pnpm-workspace.yaml`. Current:

- `apps/*`
- `packages/*`
- `services/*`

Task orchestration uses **pnpm scripts** and `pnpm -r <script>` recursion. Turborepo is intentionally not adopted at this stage (see [ADR-0011](../adr/0011-monorepo-pnpm-only.md)); the architecture remains compatible with adding it later.

## Branching

- Always branch from `master` unless the task says otherwise.
- Naming: `feat/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`.
- One PR = one coherent change.

## Commits

- Conventional Commits: `type(scope): subject`.
- Body explains WHY.
- Footer: `Closes #123` where applicable.

## Pull requests

- PR title = final commit title.
- PR body:
  - **Summary** — 1–3 bullets on the change.
  - **Motivation** — why now.
  - **Contracts** — any API / DB / event change.
  - **Test plan** — checklist.
- Required checks (once CI is set up): lint, typecheck, unit tests.
- Squash-merge only.

## Environment

- Every required env var must appear in `.env.example` with a comment describing purpose.
- Never commit `.env`.

## Debugging

- Use structured logs (`pino`) — never `console.log` in committed code.
- Set `LOG_LEVEL=debug` locally to trace request flows.
- Attach a correlation id (`x-request-id`) to any manual API call you want to trace.

## Common tasks (once implemented)

| Task            | Command                                                |
| --------------- | ------------------------------------------------------ |
| Format          | `pnpm format`                                          |
| Lint            | `pnpm lint`                                            |
| Typecheck       | `pnpm typecheck`                                       |
| Test            | `pnpm test`                                            |
| Build all       | `pnpm build`                                           |
| Migration new   | `pnpm --filter @fiyatucuz/api db:migration:new <name>` |
| Migration apply | `pnpm --filter @fiyatucuz/api db:migrate`              |

## When adding a new package or service

1. Create the directory under `packages/` or `services/`.
2. Add a `package.json` with `"name": "@fiyatucuz/<name>"`, `"private": true`, and a `tsconfig.json` extending the root base.
3. Add an entry to any orchestration (Turborepo `turbo.json`) as needed.
4. Add a `README.md` describing purpose in one paragraph.
5. Wire dependencies via `workspace:*`.

## When adding a new bounded context

1. Update `docs/architecture/bounded-contexts.md` in the same PR.
2. Update `docs/domain/ubiquitous-language.md` with any new terms.
3. Add the module directory under `services/api/src/modules/<context>/`.
4. Do not create cross-context imports — communicate via contracts.
