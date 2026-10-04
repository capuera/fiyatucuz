# Windows deployment — activation and rollback

Design: [ADR-0021](../../adr/0021-windows-deployment-activation-and-rollback.md) (status: **proposed**). Release artifact: [ADR-0020](../../adr/0020-windows-release-artifact-and-dependency-isolation.md) and [`scripts/release/README.md`](../../scripts/release/README.md). Migration safety: [ADR-0019](../../adr/0019-production-database-migration-safety.md).

## Status

| Level                      | State                                                   |
| -------------------------- | ------------------------------------------------------- |
| DESIGN / TOOLING AVAILABLE | **Yes** (ADIM 15A-4) — Node logic tested on macOS/Linux |
| WINDOWS VERIFIED           | **No — NOT VERIFIED / DEFERRED TO 15A-7**               |
| PRODUCTION APPROVED        | **No — requires 15A-7 and 15A-P**                       |

> **The tooling existing in Git does NOT authorize production use.** Production use requires a successful 15A-7, ADR-0021 accepted after it, an approved 15A-P cutover and a per-deployment approval record — see the [production operations standard](production-operations-standard.md#2-production-authorization). Until then the commands below are for **Windows staging** (a separate, non-production machine; never the production server).

Operations documents:

- [production-operations-standard.md](production-operations-standard.md) — environments, change classes, approval, evidence, backup, rollback, secrets, retention, emergency
- [production-deployment-checklist.md](production-deployment-checklist.md) — per-deployment record and GO/NO-GO gates
- [incident-recovery.md](incident-recovery.md) — response per outcome status

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
| `scripts/deploy/test/deploy.test.mjs`                | Tests (`node:test`; development machine only)                   |

The tooling runs from a **separate checkout** (`-ToolsRoot`) of the same commit; `scripts/` is not part of the release artifact.

## Procedure

### Command conventions

- Every command is labelled `[STAGING]` or `[PRODUCTION]` **and** `[READ-ONLY]` or `[MUTATING]`. The tooling has no environment marker (gap G7): the environment is the machine you are on. Check the machine name before every `[MUTATING]` command.
- Commands pass `-Root C:\FiyatUcuz` explicitly. The staging machine mirrors the production layout, so the labels and the machine — not the path — distinguish the environments.
- `<…>` placeholders (`<TOOLS_ROOT>`, `<RELEASE_ID>`, …) must be replaced; PowerShell refuses to run them unchanged. `<TOOLS_ROOT>` is a separate checkout of the **same commit** as the release.
- Run in an elevated Windows PowerShell 5.1.

### Steps (Windows staging)

1. **Build the artifact** on the build machine as described in [`scripts/release/README.md`](../../scripts/release/README.md); record the 40-char commit, the manifest SHA-256 and the archive SHA-256.
2. **Preflight** — changes nothing:

   ```powershell
   # [STAGING] [READ-ONLY] preflight
   & <TOOLS_ROOT>\scripts\deploy\windows\Test-FiyatUcuzPreflight.ps1 -Root C:\FiyatUcuz -ToolsRoot <TOOLS_ROOT>
   ```

3. **Prepare** — creates `releases\<id>` and its seal; never touches the service or the activation junctions. Prints the release ID and the **seal SHA-256**:

   ```powershell
   # [STAGING] [MUTATING] prepare (release directory + seal only)
   & <TOOLS_ROOT>\scripts\deploy\windows\Deploy-FiyatUcuzApi.ps1 -Phase Prepare -Root C:\FiyatUcuz -ToolsRoot <TOOLS_ROOT> -Archive <ARCHIVE_TGZ> -ArchiveSha256 <ARCHIVE_SHA256> -ManifestSha256 <MANIFEST_SHA256>
   ```

4. **Review migrations** — read-only status, then a human review of every pending SQL file ([standard §6](production-operations-standard.md#6-migration-review-standard)). The tool does not and cannot prove that SQL is expand-only. Until gap G2 is fixed, also run the raw status command from the [checklist](production-deployment-checklist.md#read-only-verification-commands) to see "recorded but missing from this checkout" entries.

   ```powershell
   # [STAGING] [READ-ONLY] migration status of the prepared release (no lock, no changes)
   & C:\FiyatUcuz\runtime\node22\node.exe <TOOLS_ROOT>\scripts\deploy\deploy-cli.mjs migration --mode status --node C:\FiyatUcuz\runtime\node22\node.exe --cli C:\FiyatUcuz\releases\<RELEASE_ID>\packages\db\dist\cli\migrate.js --env-file C:\FiyatUcuz\config\migration.env
   ```

5. **Activate** — backup and migration when pending, then the junction swap and service restart:

   ```powershell
   # [STAGING] [MUTATING] activate (no pending migrations)
   & <TOOLS_ROOT>\scripts\deploy\windows\Deploy-FiyatUcuzApi.ps1 -Phase Activate -Root C:\FiyatUcuz -ToolsRoot <TOOLS_ROOT> -ReleaseId <RELEASE_ID> -SealSha256 <SEAL_SHA256>

   # [STAGING] [MUTATING] activate (pending migrations: backup + reviewed migrations)
   & <TOOLS_ROOT>\scripts\deploy\windows\Deploy-FiyatUcuzApi.ps1 -Phase Activate -Root C:\FiyatUcuz -ToolsRoot <TOOLS_ROOT> -ReleaseId <RELEASE_ID> -SealSha256 <SEAL_SHA256> -PgDump <PG_DUMP_EXE> -PgRestore <PG_RESTORE_EXE> -ReviewedMigrations <MIGRATION_1>,<MIGRATION_2>
   ```

6. **Verify** — the post-deployment checks in the [checklist](production-deployment-checklist.md#gate-4--post-deployment-go), including a database-reading smoke test and external HTTPS health from outside the server.
7. **Retention report** — advisory only; nothing is deleted:

   ```powershell
   # [STAGING] [READ-ONLY] retention report
   & C:\FiyatUcuz\runtime\node22\node.exe <TOOLS_ROOT>\scripts\deploy\deploy-cli.mjs retention-report --releases C:\FiyatUcuz\releases --protect <CURRENT_RELEASE_DIR>,<PREVIOUS_RELEASE_DIR>
   ```

### Production

**Not authorized** until the conditions in [standard §2](production-operations-standard.md#2-production-authorization) are met. When they are, production uses the same commands with these labels, only under a completed [approval record](production-deployment-checklist.md) whose gates are all GO:

| Step                         | Label                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Preflight                    | `[PRODUCTION] [READ-ONLY]`                                                   |
| Prepare                      | `[PRODUCTION] [MUTATING]` — release directory and seal only                  |
| Migration status             | `[PRODUCTION] [READ-ONLY]`                                                   |
| Activate                     | `[PRODUCTION] [MUTATING]` — Gates 1–3 GO first                               |
| Post-deployment verification | `[PRODUCTION] [READ-ONLY]`                                                   |
| Retention report             | `[PRODUCTION] [READ-ONLY]`                                                   |
| Manual rollback              | `[PRODUCTION] [MUTATING]` — see [incident-recovery.md](incident-recovery.md) |

Every production command passes `-Root C:\FiyatUcuz` explicitly, as in the staging examples. The first switch from the legacy `app\` directory to `current` is not covered by these steps; it is part of 15A-P (gap G8).

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

```powershell
# [STAGING] [MUTATING] application rollback to the release in current.prev
& <TOOLS_ROOT>\scripts\deploy\windows\Rollback-FiyatUcuzApi.ps1 -Root C:\FiyatUcuz -ToolsRoot <TOOLS_ROOT> -ToReleaseId <PREVIOUS_RELEASE_ID> -SealSha256 <PREVIOUS_SEAL_SHA256>

# [STAGING] [MUTATING] application rollback to the legacy app\ directory (explicit only)
& <TOOLS_ROOT>\scripts\deploy\windows\Rollback-FiyatUcuzApi.ps1 -Root C:\FiyatUcuz -ToolsRoot <TOOLS_ROOT> -ToLegacy
```

In production these are `[PRODUCTION] [MUTATING]` and follow [incident-recovery.md](incident-recovery.md). A manual rollback is an **application** rollback only; a database restore is a separate, manual, approved decision ([standard §8](production-operations-standard.md#8-rollback-standard)).

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
