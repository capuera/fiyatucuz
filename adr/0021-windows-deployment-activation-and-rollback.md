---
number: 0021
title: Windows deployment activation and rollback
status: proposed
date: 2026-10-04
deciders: project owner
supersedes:
superseded-by:
---

# 0021 — Windows deployment activation and rollback

## Context

ADR-0020 defines a verifiable, dependency-isolated release artifact. It does not define how that artifact becomes the running API on the Windows Server 2022 host (WinSW service `FiyatUcuzApi` as `NT AUTHORITY\LocalService`, portable Node 22, IIS/ARR in front of `127.0.0.1:4000`), how migrations fit in, or how a failed deploy is undone.

Constraints:

- pnpm on Windows creates junctions in `node_modules` that may hold **absolute** targets. A materialized release cannot be moved or renamed after install.
- NTFS has no atomic multi-entry swap. Renaming a junction that the running service resolves through is unsafe.
- Migrations are forward-only (ADR-0019). A database cannot be rolled back by an application rollback.
- `node --env-file` does not override variables already present in the environment.
- Secrets live in `config\api.env` (runtime, LocalService readable) and `config\migration.env` (Administrators/SYSTEM only).

## Decision

1. **Release per directory.** Each release is extracted, installed and built directly at its final path `C:\FiyatUcuz\releases\<release-id>` (`<release-id>` = UTC commit date `yyyymmdd` + first 12 hex of the commit). It is never moved, renamed, overwritten or reused.
2. **Two phases.** _Prepare_ (archive SHA-256 → tar listing validation → extract to `staging\work` → source verify → copy to final path → isolated install/build per ADR-0020 → materialized verify → seal) never touches the service. _Activate_ (seal verify → migrations → swap → health) is a separate, explicit run.
3. **Seal.** After a successful materialized verify the tool writes `releases\<id>.seal.json` (outside the release, bound to the directory name) with build-output hashes and tree hashes over every `dist` and `node_modules` entry (files, directories, link targets; one JSON tuple per entry). Links are never followed; a link resolving outside the release is refused. Activation and rollback targets are re-verified against the seal; the operator passes the seal SHA-256 printed by Prepare.
4. **Junction activation.** `C:\FiyatUcuz\current` is a junction. Sequence: create `current.next` (service running) → stop `FiyatUcuzApi` → rename `current` → `current.prev` → rename `current.next` → `current` → start. Only `current`, `current.next`, `current.prev`, `current.failed` are ever created, renamed or removed; removal is a non-recursive directory delete after verifying the entry is a junction pointing at a release. The swap is **not atomic**; a pure planner (`planActivationStep`) classifies every intermediate state, resumes recognizable mid-swap states and returns `CRITICAL_OPERATOR_ACTION` for anything else. PowerShell executes one planned step at a time and re-snapshots.
5. **Read-only gate before any migration.** Everything checkable without changing production — preflight (service identity, env, ACL, disk, runtime vs manifest), target seal, junction state (`precheckActivation`), the rollback target's seal, a strictly parsed migration status with **no migrations recorded in the database but missing from the release** (an older release is never activated on a newer schema; fix-forward only; rollback paths do not apply this check), the review gate and backup tools — is checked before the database can change; seal and junction state are re-checked right before activation.
6. **Migrations before stop, behind a human gate.** Pending migrations are applied while the old release still runs (expand-only per ADR-0019). The tool **cannot prove** a migration is expand-only and does not try: the operator must pass exactly the pending set via `-ReviewedMigrations`. A verified backup (`pg_dump --format=custom` + `pg_restore --list`) is mandatory when anything is pending.
7. **Env isolation.** Migration and backup child processes get an allowlisted environment (no inherited `DATABASE_*`/`PG*`); credentials reach the migration CLI only via `--env-file=<path>` and `pg_dump` only via `PG*` child variables. Secret values never appear in argv, stdout, receipts or errors. `api.env` policy is validated (exact `NODE_ENV=production`, `API_HOST=127.0.0.1`, `API_PORT=4000`, no migration keys, feed archive at `data\feed-archive`).
8. **Gates.** Local health (`http://127.0.0.1:4000/health`, 90 s, 2 s poll) and a listener check (only `127.0.0.1:4000`, owned by the service process tree) are the activation gates. Public HTTPS health is an operator check, not a gate.
9. **Service control.** Only `FiyatUcuzApi` (fixed, identity verified: name, WinSW path, LocalService). Stop timeout 60 s, start 30 s. No process is ever force-killed; a stop timeout aborts.
10. **Rollback.** On failure after the swap began: stop, rename `current` → `current.failed`, `current.prev` → `current`, start, health. Final statuses: `COMPLETED`, `FAILED_NO_CHANGE`, `FAILED_MIGRATION_PARTIAL`, `ROLLED_BACK`, `ROLLED_BACK_APP_ONLY` (migrations remain applied — receipt says **DB NOT ROLLED BACK**), `CRITICAL_OPERATOR_ACTION`. Statuses are decided by one tested function from the failed phase, the migration state (`NOT_NEEDED` / `NOT_ATTEMPTED` / `SUCCEEDED` / `INCOMPLETE` / `FAILED_NO_CHANGE` / `PARTIAL` / `UNKNOWN`, with the known applied IDs) and the rollback result; any state where the database may have changed is never reported as unchanged. A manual rollback script exists; it checks everything before stopping the service and always reports `ROLLED_BACK_APP_ONLY`, because it cannot know which migrations a failed deployment applied.
11. **Receipts.** `deployments\<id>.json` is written atomically (temp + fsync + rename) before the first mutation and after every phase. Before the service is stopped, a failed write stops the deployment; after the swap began, safety wins (rollback proceeds, its receipt writes are best effort); a healthy deployment whose final write fails is not rolled back and is never recorded as `COMPLETED` (exit 3). Content is checked for credential patterns and for values of credential keys. Release identity in the receipt comes only from verified data (Prepare's own hashes, the verified seal) and is write-once; operator inputs are stored separately; the archive SHA-256 is Prepare evidence only. Backup evidence records the database name (never a URL or user), UTC timestamps and the exact `pg_dump` version.
12. **No automatic cleanup.** Retention is a report only; nothing is deleted by the tooling.

## Alternatives considered

- **Rename/move release directories into place** — rejected: breaks pnpm absolute junction targets.
- **In-place update of one app directory** — rejected: no rollback target, the 15A-3 incident class.
- **Stop service before migrating** — rejected as default: longer downtime; ADR-0019 already requires backward-compatible migrations.
- **Automatic expand-only SQL classification** — rejected: cannot be made reliable; a human review gate is explicit.
- **Automatic DB restore on failure** — rejected: data loss risk; restore is a manual decision.
- **Symlink (`mklink /D`) instead of junction** — rejected: requires symlink privilege evaluation for LocalService; junctions are local-only and sufficient.

## Consequences

- Downtime is limited to stop → two renames → start → health.
- Each release costs disk (full `node_modules` copy); 5 GiB free is required and cleanup is manual.
- A deployment with migrations can end `ROLLED_BACK_APP_ONLY`; the previous release must tolerate the new schema (ADR-0019).
- Tooling is split: decisions in Node (`scripts/deploy/deploy-lib.mjs`, tested on any OS), Windows facts and single-step execution in PowerShell 5.1 (`scripts/deploy/windows/`). The tooling runs from a separate checkout (`-ToolsRoot`), not from the release.

## Follow-ups

- **15A-7:** Windows verification — PowerShell 5.1 parse/run, junction `LinkType`/`Target`, rename semantics while the service is stopped, `tar.exe` listing format, `Get-NetTCPConnection`, WinSW stop behaviour and XML syntax, NTFS `nlink`, effective LocalService access.
- **15A-P:** production cutover (WinSW XML switch to `current`, ACL setup); this ADR moves to `accepted` only after 15A-7.
- Add this ADR to `.fiyatucuz/DECISIONS.md` when accepted.
