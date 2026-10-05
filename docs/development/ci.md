# CI and quality gates

Workflow: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) (ADIM 15A-6B). It runs on every pull request and push to `main` / `master`.

CI uses **no production secrets, databases or services**. The only database is a throwaway `postgres:16-alpine` service container (the same image as `infra/dev/docker-compose.yml`) with a dummy CI-only password.

## Required checks

All steps run in one job; the job must be green before merging. To enforce this, mark the `format + lint + typecheck + build + test` job as a required status check in the GitHub branch protection settings (a repository setting, not part of this repo).

| #   | Step                                   | What it proves                                                                                                                                                                   |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install --frozen-lockfile`       | Reproducible install from `pnpm-lock.yaml` (pnpm 9.15.4, Node from `.nvmrc` = 22)                                                                                                |
| 2   | Format gate                            | No new formatting debt (see below)                                                                                                                                               |
| 3   | `pnpm run lint`                        | ESLint over the whole repository                                                                                                                                                 |
| 4   | `pnpm run typecheck`                   | `tsc --noEmit` in every workspace package                                                                                                                                        |
| 5   | `pnpm run build`                       | Every workspace package builds                                                                                                                                                   |
| 6   | `pnpm run test:tooling`                | `node:test` suites: `scripts/release`, `scripts/deploy`, `scripts/ci`                                                                                                            |
| 7   | Migrations                             | The real migration CLI (`packages/db/dist/cli/migrate.js`) applies all migrations to the empty CI database                                                                       |
| 8   | Contract check                         | `deploy-cli migration --mode status` parses the real `migrate.js --status` output with the strict deployment parser (ADIM 15A-6A); output drift fails CI instead of a deployment |
| 9   | `pnpm -r run test` with `DATABASE_URL` | `@fiyatucuz/db` and `@fiyatucuz/api` vitest suites **including the integration tests** (they skip without `DATABASE_URL`)                                                        |

The integration-test guard (`packages/db/test/helpers.ts`) only accepts the database name `fiyatucuz_adim14`, so the CI database uses that name.

## Local equivalents

```bash
pnpm install --frozen-lockfile
pnpm format                 # format gate (baseline-aware)
pnpm lint
pnpm typecheck
pnpm build
pnpm run test:tooling       # release / deploy / CI-gate tests, no database needed
# Integration tests: local test database only (never the development database `fiyatucuz`)
DATABASE_URL=postgres://fiyatucuz:fiyatucuz@127.0.0.1:5432/fiyatucuz_adim14 pnpm -r run test
```

`pnpm test` runs the workspace suites and then `test:tooling`. Without `DATABASE_URL` the integration tests are skipped, so a local `pnpm test` without it is **not** equivalent to CI.

## Formatting baseline policy

When the gate was introduced, 74 files (51 in `services/api`, 15 in `packages/db`, 8 ADRs) were not Prettier-formatted. They are listed in [`scripts/ci/prettier-baseline.txt`](../../scripts/ci/prettier-baseline.txt) and are **not** reformatted in bulk: a repository-wide formatting commit would hide real changes in history and in reviews.

The gate (`scripts/ci/check-format.mjs`) enforces:

1. **Every other file must be formatted.** A new or changed file outside the baseline that Prettier would change fails CI.
2. **The baseline only shrinks.** A listed file that is now formatted (or deleted) must be removed from the list; CI fails until it is. Never add a file to the list to make CI pass (a test also refuses tooling paths such as `scripts/deploy/**` and limits the list to the original 74 entries).
3. **Touching a baseline file pays its debt.** In CI the gate runs with `--changed-since <base commit>`: a baseline file changed in the pull request / push must be formatted in that same change and removed from the list.

Paying the debt for a file you are editing:

```bash
pnpm exec prettier --write path/to/file.ts   # that file only
# then delete its line from scripts/ci/prettier-baseline.txt
pnpm format
```

Do **not** run `pnpm format:write` (repository-wide `prettier --write .`) to clear the baseline in one go. `pnpm format:all` shows the full historical debt without changing anything.

**Removing the debt eventually:** files leave the baseline as they are touched. Remaining files can be formatted in small dedicated commits (one package or directory at a time, formatting only, no behaviour change), each removing its lines from the baseline. When the list is empty, `format` can go back to a plain `prettier --check .` and the baseline file can be deleted.

## What CI does not prove

- **Windows behaviour.** CI runs on Linux. The deployment tooling's Windows-specific behaviour (PowerShell 5.1, junctions, NTFS hard links, LocalService access, WinSW, Windows `tar.exe`, real `pg_dump` / `pg_restore`) is **not verified** by CI; it is ADIM 15A-7 on a separate Windows staging machine ([production operations standard §12](../operations/production-operations-standard.md#12-15a-7-windows-staging-gate)).
- **Production readiness.** A green CI run is required release evidence for the exact commit, not a production authorization ([standard §2](../operations/production-operations-standard.md#2-production-authorization)).
