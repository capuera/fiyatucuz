# API release tooling (ADIM 15A-3)

Prepares and verifies a release of `@fiyatucuz/api` for the Windows host without
ever shipping a `node_modules` built on another OS. Decision record:
[ADR-0020](../../adr/0020-windows-release-artifact-and-dependency-isolation.md).

Node built-ins only — no dependencies, not a pnpm workspace package (so the
lockfile is unaffected).

## Commands

```bash
node scripts/release/api-release.mjs closure
node scripts/release/api-release.mjs prepare --output <dir>          # dir must not exist, outside the repo
node scripts/release/api-release.mjs verify --release <dir> --stage source [--manifest-sha256 <hex>]
node scripts/release/api-release.mjs verify --release <dir> --stage materialized
node scripts/release/api-release.mjs install-plan --release <dir> [--node <node.exe>] [--pnpm <pnpm.cjs>] [--store <dir>]

node --test scripts/release/test/release.test.mjs
```

Exit codes: `0` ok, `1` preparation/verification failure, `2` usage error.

## Stages

1. **Source artifact** (`prepare`, any OS). Requires a clean working tree.
   Copies an **allowlist** and writes `release-manifest.json` (SHA-256 of every
   file; `createdAt` is the commit time, so a commit always yields the same
   manifest). `prepare` prints the manifest's SHA-256 — record it out of band
   and pass it to `verify --manifest-sha256` on the target host.

   | Included                                                                                | Never included                                                         |
   | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
   | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc`, `tsconfig.base.json` | `node_modules`, `dist`, `*.tsbuildinfo`, tests                         |
   | `package.json` of every workspace (metadata for the frozen lockfile)                    | sources of excluded workspaces (`apps/web`, `apps/mobile`)             |
   | closure packages: `tsconfig.json` + `src/**`                                            | `.env*`, `migration.env`, keys/certs, dumps, logs, `raw.xml`/`raw.csv` |
   | `packages/db/drizzle/*.sql`                                                             | symlinks (fail closed)                                                 |

2. **Materialized release** (target host, ADIM 15A-4). Run the commands from
   `install-plan` in the release directory, then
   `verify --stage materialized`:

   ```text
   <NODE> <PNPM_CLI_JS> install --frozen-lockfile --package-import-method copy \
       --store-dir <STORE_DIR> --filter @fiyatucuz/api... --ignore-scripts
   <NODE> <pkg>/node_modules/typescript/bin/tsc -p <pkg>/tsconfig.json   # per package, dependencies first
   ```

   - Every executable is an explicit path (portable Node, pnpm's CLI script):
     no global Node/pnpm, no `PATH` lookup.
   - `--package-import-method copy` + an isolated `--store-dir`: dependency files
     are fresh copies that inherit the release directory's ACL, never hard
     links into an Administrator/global pnpm store.
   - `--filter @fiyatucuz/api...`: the API and its workspace dependencies only.
   - `--ignore-scripts`: no install script in the closure is needed
     (`@node-rs/argon2` ships prebuilt binaries via optionalDependencies).

   `verify --stage materialized` re-checks every source hash, requires the
   build outputs (`services/api/dist/index.js`, `packages/*/dist/index.js`,
   `packages/db/dist/cli/migrate.js`, …), rejects any dependency file with a
   link count > 1, and rejects `react-native`/`expo`/`next` in the store layout.

## What is (not) verified here

- Hard-link detection uses `lstat().nlink`. On the Mac it is exercised against
  APFS hard links; that Node reports NTFS hard-link counts the same way on
  Windows, and that the commands above install cleanly there, are validated in
  ADIM 15A-4 / 15A-7 — not claimed by these tests.
- Migration credentials are never part of a release; the migration CLI reads
  them from a separate env file at deploy time (ADR-0019).
