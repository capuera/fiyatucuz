# Windows deployment — activation and rollback

Design: [ADR-0021](../../adr/0021-windows-deployment-activation-and-rollback.md) (status: **proposed**). Release artifact: [ADR-0020](../../adr/0020-windows-release-artifact-and-dependency-isolation.md) and [`scripts/release/README.md`](../../scripts/release/README.md). Migration safety: [ADR-0019](../../adr/0019-production-database-migration-safety.md).

## Status

| Level                      | State                                                   |
| -------------------------- | ------------------------------------------------------- |
| DESIGN / TOOLING AVAILABLE | **Yes** (ADIM 15A-4) — Node logic tested on macOS/Linux |
| WINDOWS VERIFIED           | **No — NOT VERIFIED / DEFERRED TO 15A-7**               |
| PRODUCTION APPROVED        | **No — requires 15A-7 and 15A-P**                       |

> Do **not** run these scripts against `C:\FiyatUcuz` on the production host before 15A-7 (Windows verification on a non-production host) and 15A-P (production cutover approval). The commands below describe the intended procedure only.

## Layout

```
C:\FiyatUcuz\
  releases\<release-id>\           one directory per release, never moved/renamed
  releases\<release-id>.seal.json  seal (outside the release)
  current        -> junction to the active release
  current.next   -> junction, staged during activation
  current.prev   -> junction to the previous release (rollback target)
  current.failed -> junction to a rolled-back release
  app\                             legacy checkout (rollback only with -ToLegacy)
  config\api.env                   runtime env (LocalService: read)
  config\migration.env             migration env (Administrators/SYSTEM only)
  runtime\node22\node.exe          portable Node 22
  runtime\pnpm\9.15.4\bin\pnpm.cjs portable pnpm
  runtime\service\FiyatUcuzApi.exe WinSW
  staging\work, staging\pnpm-store, staging\db-backups
  deployments\<deployment-id>.json receipts
  data\feed-archive, logs\api
```

`<release-id>` = `yyyymmdd` (UTC commit date) + `-` + first 12 hex of the commit, e.g. `20261004-ebf9da9a1b2c`.

## Files

| File                                                 | Purpose                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `scripts/deploy/deploy-lib.mjs`                      | Pure decisions: env policy, junction planner, receipts, backup… |
| `scripts/deploy/deploy-cli.mjs`                      | JSON CLI used by PowerShell                                     |
| `scripts/deploy/windows/FiyatUcuz.Deploy.psm1`       | Windows facts + one-step execution                              |
| `scripts/deploy/windows/Test-FiyatUcuzPreflight.ps1` | Read-only preflight                                             |
| `scripts/deploy/windows/Deploy-FiyatUcuzApi.ps1`     | `-Phase Prepare` / `-Phase Activate`                            |
| `scripts/deploy/windows/Rollback-FiyatUcuzApi.ps1`   | Manual application rollback                                     |
| `scripts/deploy/windows/FiyatUcuzApi.xml.template`   | WinSW config template (applied in 15A-P)                        |
| `scripts/deploy/test/deploy.test.mjs`                | Tests (`node --test scripts/deploy/test/deploy.test.mjs`)       |

The tooling runs from a **separate checkout** (`-ToolsRoot`) of the same commit; `scripts/` is not part of the release artifact.

## Procedure (intended; not yet approved for production)

1. **Build the artifact** on the build machine (ADR-0020): `node scripts/release/api-release.mjs prepare …`, archive with `tar -czf`, record archive SHA-256 and manifest SHA-256.
2. **Preflight** (read-only): `Test-FiyatUcuzPreflight.ps1 -ToolsRoot <tools>`.
3. **Prepare**: `Deploy-FiyatUcuzApi.ps1 -Phase Prepare -ToolsRoot <tools> -Archive <tgz> -ArchiveSha256 <hex> -ManifestSha256 <hex>`. Prints the release id and the **seal SHA-256**. Production is unchanged.
4. **Review migrations**: run `deploy-cli.mjs migration --mode status …` (or read the Activate receipt) and review every pending SQL file for ADR-0019 expand-only compatibility. The tool does not and cannot prove this.
5. **Activate**: `Deploy-FiyatUcuzApi.ps1 -Phase Activate -ToolsRoot <tools> -ReleaseId <id> -SealSha256 <hex> [-PgDump <pg_dump.exe> -PgRestore <pg_restore.exe> -ReviewedMigrations <a.sql>,<b.sql>]`.
6. **External check**: `https://api.fiyatucuz.com/health` from outside the host (operator; not a tool gate).
7. **Retention**: `deploy-cli.mjs retention-report --releases C:\FiyatUcuz\releases --protect <current>,<prev>` — report only; any deletion is manual.

### Prepare details

- The archive is first copied into `staging\work` (Administrators-only); hashing, listing and extraction all use that copy.
- The listing is validated **before** extraction: only regular files and directories; no `..`, absolute, drive, UNC or backslash paths; no Windows-reinterpreted names (`:` / alternate data streams, `CON`/`NUL`/`COMn`/`LPTn`, trailing dot or space, reserved characters, control characters); no case-insensitive duplicates; nothing below a file.
- The seal (`releases\<id>.seal.json`) is bound to the release directory name and records every `dist` and `node_modules` entry (files by SHA-256, directories, link targets) as one JSON tuple per entry. Links are never followed; a link whose target resolves outside the release is refused at seal time and on every verification.

### Activate sequence

1. **Read-only gate — nothing has changed yet.** Any failure → `FAILED_NO_CHANGE`.
   - preflight with the release manifest: service identity, `api.env` / `migration.env` policy, static ACLs, disk, runtime versions vs manifest;
   - target seal (expected SHA-256);
   - junction precheck: every pointer absent or a valid junction, `current` → a release, no `current.next`, target ≠ current, first planned step is `createNext`;
   - the rollback target (current release) passes its own seal verification;
   - migration status; if pending: `-ReviewedMigrations` equals the pending set (`--mode review`, nothing applied), `-PgDump` / `-PgRestore` exist.
2. Backup (only if pending): `pg_dump` custom format, non-zero size, SHA-256, `pg_restore --list`. Failure → `FAILED_NO_CHANGE`, migration not attempted.
3. Apply → status → classification (receipt `migrations.state`, below). Anything but `SUCCEEDED` → stop, new release NOT activated.
4. Re-verify the seal and the junction precheck immediately before activation.
5. Stage `current.next` (and remove an old `current.prev`) while the service runs. Failure → `current.next` removed again, stop.
6. Stop `FiyatUcuzApi` (60 s; on timeout: `CRITICAL_OPERATOR_ACTION`, nothing is killed, junctions untouched).
7. Rename `current` → `current.prev`, `current.next` → `current`.
8. Start (30 s), local health (90 s), listener `127.0.0.1:4000` owned by the service tree.
9. Success → `COMPLETED`. Any failure in 7–8 (including a receipt write failure) → automatic application rollback.

### Migration state in the receipt

`migrations.state` (with `attempted`, `outcome`, `knownApplied`, `before`, `after`, `reviewed`):

| State              | Meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `NOT_NEEDED`       | Nothing pending                                                           |
| `NOT_ATTEMPTED`    | Apply never ran (e.g. review gate)                                        |
| `SUCCEEDED`        | Applied; nothing pending afterwards                                       |
| `INCOMPLETE`       | CLI succeeded but migrations are still pending                            |
| `FAILED_NO_CHANGE` | Apply failed; the after-status proves nothing changed                     |
| `PARTIAL`          | Apply failed after applying `knownApplied`                                |
| `UNKNOWN`          | The database may have changed but this cannot be proven (no after-status) |

`knownApplied` comes from the before/after status diff when available, otherwise from the CLI's own "Applied" lines (a lower bound). `SUCCEEDED`, `INCOMPLETE`, `PARTIAL` and `UNKNOWN` count as "database may have changed": a later stop is `FAILED_MIGRATION_PARTIAL`, a successful app rollback is `ROLLED_BACK_APP_ONLY`.

### Receipt rules

- Written (atomic temp + fsync + rename, credential check) before the first mutation and at each phase.
- Before the service is stopped, a failed receipt write stops the deployment.
- After the swap began, safety wins: a receipt failure triggers the application rollback; rollback receipt writes are best effort.
- A healthy deployment whose final receipt write fails is **not** rolled back; the script exits `3` and the receipt still says `IN_PROGRESS` (never a false `COMPLETED`).
- Only values of credential keys are treated as secrets (deny by default; known configuration keys such as `NODE_ENV`, `API_HOST`, `API_PORT`, `LOG_LEVEL`, `RATE_LIMIT_*` are not), plus URL passwords.

## Final statuses

| Status                     | Meaning                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `COMPLETED`                | New release active and healthy                                             |
| `FAILED_NO_CHANGE`         | Stopped before any production change                                       |
| `FAILED_MIGRATION_PARTIAL` | The database may have changed (see `migrations.state`); app NOT switched   |
| `ROLLED_BACK`              | App restored, database unchanged                                           |
| `ROLLED_BACK_APP_ONLY`     | App restored; **DB NOT ROLLED BACK** — applied migrations remain           |
| `CRITICAL_OPERATOR_ACTION` | Ambiguous state / stop timeout / rollback failed — operator must intervene |

Statuses are decided in Node (`decideFailureStatus`) and tested. The database is **never** rolled back by tooling. Restoring a backup is a separate, manual decision.

## Manual rollback

```
Rollback-FiyatUcuzApi.ps1 -ToolsRoot <tools> -ToReleaseId <previous-id> [-SealSha256 <hex>]
Rollback-FiyatUcuzApi.ps1 -ToolsRoot <tools> -ToLegacy      # explicit, legacy app\ only
```

- Before the service is stopped: release id format, seal (and digest if given), `api.env` policy, service identity and a dry run of the junction plan. The target must be `current.prev`.
- The legacy directory is never treated as a sealed release; it is reachable only with `-ToLegacy`.
- A successful manual rollback always reports `ROLLED_BACK_APP_ONLY` with the DB note. Reason: the script cannot know which migrations the failed deployment applied (that is in the failed deployment's receipt), so it never claims the database matches the restored application.

## Safety rules enforced by the tooling

- Only service `FiyatUcuzApi` (fixed name, identity verified). No `Stop-Process`, `taskkill`, `iisreset`, IIS/ARR/firewall/PATH changes; enforced by a static scan in the tests.
- Activation junctions removed only after verification, non-recursively; release directories never renamed, moved or deleted.
- Secrets never in argv, output, receipts or errors; migration child env is allowlisted; `migration.env` never merged with `api.env`.

## NOT VERIFIED / DEFERRED TO 15A-7

- PowerShell 5.1 parsing and execution of all scripts (`pwsh` is not available on the development machine).
- `Get-Item` `LinkType`/`Target` for junctions, `New-Item -ItemType Junction`, `Rename-Item` on junctions, `[System.IO.Directory]::Delete(path, $false)` on a junction.
- Windows `tar.exe` listing format and extraction.
- `Get-NetTCPConnection` / `Win32_Process` output shape for the listener check.
- WinSW stop behaviour, `<serviceaccount>` syntax for LocalService, `<stoptimeout>`.
- NTFS hard-link detection (`nlink`) and effective LocalService access (ACLs are only checked statically).
- `pg_dump` / `pg_restore` (tests use fake executables), backup duration vs the 10-minute child timeout.
- Junction existence via `[System.IO.File]::GetAttributes` (dangling junctions), Windows `readlink` format for junctions inside the seal.
- `tar.exe` output decoding of non-ASCII names through PowerShell; native stderr handling under remoting/ISE.
