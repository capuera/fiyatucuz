# Production operations standard

Status: **ADIM 15A-5 policy.** It governs how the deployment mechanisms from ADIM 15A-1 … 15A-4 may be used. It is a policy, not a deployment engine, and it adds no new architecture.

Related:

- Migration safety: [ADR-0019](../../adr/0019-production-database-migration-safety.md) (accepted)
- Release artifact: [ADR-0020](../../adr/0020-windows-release-artifact-and-dependency-isolation.md) (accepted)
- Activation and rollback: [ADR-0021](../../adr/0021-windows-deployment-activation-and-rollback.md) (**proposed**)
- Tooling reference: [windows-deployment.md](windows-deployment.md)
- Per-deployment record: [production-deployment-checklist.md](production-deployment-checklist.md)
- Incidents: [incident-recovery.md](incident-recovery.md)

> **The deployment tooling existing in Git does NOT authorize its use in production.** See [§2](#2-production-authorization).

---

## 1. Environments

|                            | DEVELOPMENT                             | WINDOWS STAGING                                                             | PRODUCTION              |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------------- | ----------------------- |
| Host                       | Developer machine                       | A **separate, non-production** Windows Server 2022 machine or VM            | The production server   |
| Database                   | Local development / test databases only | A non-production test database containing **no production data**            | The production database |
| Secrets                    | Development values                      | Staging-only values                                                         | Production values       |
| Purpose                    | Code, unit and integration tests        | Rehearsal of the exact Windows procedure (15A-7 and per-release rehearsals) | Serving users           |
| May run deployment tooling | Tests only                              | Yes, by an operator                                                         | Only as described in §2 |

Rules:

- **Never use the production server as staging.** The tooling controls the fixed service name `FiyatUcuzApi` and defaults to `C:\FiyatUcuz`; on the production server a "staging" run would act on production.
- The tooling has **no environment marker** yet (gap G7, §16). The environment is identified only by the machine. Every runbook command is therefore labelled `[STAGING]` or `[PRODUCTION]` and `[READ-ONLY]` or `[MUTATING]`, and production commands always pass `-Root C:\FiyatUcuz` explicitly.
- A staging instruction, staging result or staging approval is **never** a production authorization.
- Production data and production secrets never go to development or staging.

## 2. Production authorization

Production use of the 15A-4 tooling requires **all** of:

1. a successful ADIM 15A-7 Windows staging validation with the evidence in §12;
2. ADR-0021 changed to `accepted` **after** that validation;
3. a separately approved ADIM 15A-P production cutover (including the first legacy `app\` → `current` switch, gap G8);
4. a per-deployment approval record ([checklist](production-deployment-checklist.md)) with every gate GO.

Until 1–3 are complete, no production deployment uses this tooling, whatever the documentation shows.

## 3. Change classes

The migration class is decided by **human review** (ADR-0019 §5). No tool proves that SQL is expand-only, and nothing in this standard claims it does. There are no down-migrations.

| Class                    | Definition                                                                                                                         | Approval                                                                          | Backup                                        | Downtime                                          | Rollback consequence                                                                    | Eligibility                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — application-only** | No pending migration                                                                                                               | Preparer + approver                                                               | Not required by the tooling                   | Stop → swap → start (seconds)                     | `ROLLED_BACK` restores the previous application; the database is unchanged              | Normal deployment                                                                                                                                                              |
| **B — SAFE/ADDITIVE**    | Only expand-only changes (ADR-0019 table)                                                                                          | Preparer + approver + written migration review                                    | **Mandatory**, verified, before the migration | As A; migrations run while the old release serves | `ROLLED_BACK_APP_ONLY`: the schema change stays; the previous release must work with it | Normal deployment                                                                                                                                                              |
| **C — REQUIRES REVIEW**  | Any ADR-0019 "requires review" change (index on a populated table, backfill, constraint on an existing table, grant/RLS change, …) | As B + written note: lock impact, runtime, data volume, old-release compatibility | Mandatory                                     | May block writes; schedule a low-traffic window   | APP-ONLY; a database restore loses writes made after the backup                         | Only in an agreed window                                                                                                                                                       |
| **D — CONTRACT/DEFER**   | Drops, renames, incompatible type changes, tightening, data removal                                                                | As C, in its **own** release                                                      | Mandatory; extended retention                 | Window                                            | Effectively forward-only; only a database restore goes back                             | Only after **no rollback target** still depends on what is removed. Never in the same release that introduces the new code dependency (no same-release introduce/remove cycle) |
| **E — emergency/hotfix** | Urgent fix                                                                                                                         | §11                                                                               | As its A–D class                              | As its A–D class                                  | As its A–D class                                                                        | Never class D                                                                                                                                                                  |

A release's class is the highest class of its migrations. An unclassified migration is NO-GO.

## 4. Approval model

Each production deployment has one approval record with:

- **PREPARED BY** — builds the artifact, collects the evidence (§5), classifies migrations, fills the checklist.
- **REVIEWED/APPROVED BY** — checks the evidence against the exact identifiers, reviews the classification, approves the window.
- **OPERATOR** — runs the commands (recorded in the receipt).

If one person holds both PREPARED BY and REVIEWED/APPROVED BY, the record says **`SELF-APPROVED (single operator)`** with a reason. A two-person review is never implied when it did not happen. For class C and D a second reviewer is strongly recommended; if none is available, the record says so explicitly.

The record is stored with the deployment receipts (`C:\FiyatUcuz\deployments\`) or referenced from them. No identity system is introduced by this standard.

## 5. Required release evidence

Production deployments are based only on exact, immutable identifiers — never on "latest main" or "latest build".

| Evidence                 | Requirement                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git commit               | Full 40-character SHA                                                                                                                                   |
| Provenance               | Approver confirms the commit exists on `origin/main` (gap G13: not checked by tooling)                                                                  |
| Clean prepare            | `api-release.mjs prepare` ran on a clean tree at that commit                                                                                            |
| Manifest SHA-256         | Printed by `prepare`, recorded out of band                                                                                                              |
| Archive SHA-256          | Of the exact `.tgz` transferred                                                                                                                         |
| Seal SHA-256             | Printed by the Windows Prepare phase                                                                                                                    |
| Release ID               | `yyyymmdd-<first 12 hex of the commit>`                                                                                                                 |
| Tests / build            | Results recorded by the preparer for that commit (gap G5: current CI is not sufficient evidence)                                                        |
| Migration status         | Pending list from the read-only status; **no "recorded but missing from this checkout" entries** (normal Activate refuses them: `RECORDED_BUT_MISSING`) |
| Migration classification | Class per file (§3) and the review (§6)                                                                                                                 |
| Known issues             | Listed with a disposition; no unresolved critical issue                                                                                                 |
| Backup readiness         | pg_dump / pg_restore paths and versions; pg_dump major version ≥ server version; free disk                                                              |
| 15A-7 evidence           | Reference to the accepted validation record (§12)                                                                                                       |
| Staging rehearsal        | Per-release rehearsal on Windows staging: required for B–D, recommended for A                                                                           |
| Rollback target          | Release ID of the current release (the tooling verifies its seal)                                                                                       |
| People and time          | Operator, PREPARED BY, REVIEWED/APPROVED BY, planned window                                                                                             |

## 6. Migration review standard

For every pending migration file the reviewer records:

1. **Classification** — SAFE/ADDITIVE, REQUIRES REVIEW or CONTRACT/DEFER (ADR-0019 table).
2. **Forward compatibility** — the currently running release keeps working against the new schema.
3. **Locking** — lock level and expected duration; whether `SET LOCAL lock_timeout` is needed for DDL on busy tables (gap G11: a DDL statement waiting on a lock blocks traffic queued behind it).
4. **Table rewrite risk** — e.g. column type changes, volatile defaults.
5. **Index creation** — `CREATE INDEX` on a populated table blocks writes; `CONCURRENTLY` cannot run inside the runner's per-file transaction.
6. **Long transactions / backfills** — row counts, duration, row locks, FORCE RLS effects.
7. **RLS, policies, grants, ownership** on existing objects.
8. **Conventions** — idempotent (`IF NOT EXISTS`), no `BEGIN`/`COMMIT` (ADR-0012).
9. **Expected database** — `DATABASE_MIGRATION_EXPECTED_DB` matches the target.
10. **Backup / restore implication** — restore point, and what writes after it would be lost.
11. **Rollback consequence** — written explicitly, e.g. "application rollback is APP-ONLY; schema stays".

A CONTRACT migration never ships in the release that first introduces the new application dependency unless this is explicitly reviewed and recorded. Migration tracking rows are never created, edited or deleted by hand.

## 7. Backup standard

- **Any migration ⇒ a verified backup before the migration.** The tooling enforces this when migrations are pending.
- Class A deployments do not require a deployment backup; platform backup (WAL / point-in-time recovery) is a separate, open item in `.fiyatucuz/SECURITY.md` §14.
- **Evidence**, recorded by the tooling in the receipt's `backup` section (no secret values): path, database **name** only (from the validated migration configuration; never a URL, user or password), bytes, SHA-256, `pg_restore --list` success, `createdAt` (UTC, immediately before `pg_dump`), `completedAt` (UTC, after `pg_restore --list`), and the version of the exact `pg_dump` executable used (`pgDumpVersion`, `pgDumpMajor`). If that executable's `--version` fails or is not recognized, no backup and no migration run.
- **Storage**: `C:\FiyatUcuz\staging\db-backups`, Administrators/SYSTEM only. A dump contains personal data and password hashes: never copied off the host unencrypted, never put in Git, tickets, chat or shared folders.
- **Retention**: §10.
- A restore drill against a **non-production** database is part of 15A-7.

## 8. Rollback standard

Two different operations, never confused:

|             | APPLICATION ROLLBACK                                                  | DATABASE RESTORE                              |
| ----------- | --------------------------------------------------------------------- | --------------------------------------------- |
| What        | Point `current` back to the previous release                          | Restore the pre-migration backup              |
| How         | Automatic after an activation failure, or `Rollback-FiyatUcuzApi.ps1` | Manual, outside the deployment tooling        |
| Approval    | Operator (automatic) / approver (manual)                              | Approver, with a written data-loss assessment |
| Data effect | None                                                                  | **Loses every write made after the backup**   |

- After a migration, an application rollback is **APP-ONLY** (`ROLLED_BACK_APP_ONLY`). It is never called a full rollback.
- No automatic or hand-written down-migration.
- When to act:
  - **automatic application rollback** — done by the tooling after a swap, start, health or listener failure;
  - **manual application rollback** — a regression found after `COMPLETED`; the target is `current.prev`;
  - **stop and escalate** — any `CRITICAL_OPERATOR_ACTION`, ambiguous junction state, stop timeout or failed rollback ([incident-recovery.md](incident-recovery.md));
  - **consider a database restore** — only for data corruption or a schema state the restored application cannot run against; approver decision.

## 9. Secret standard

| Item                                | Access                                                                        | Rules                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `C:\FiyatUcuz\config\api.env`       | Administrators/SYSTEM full control; `NT AUTHORITY\LocalService` **read only** | Runtime credential only; never contains `DATABASE_MIGRATION_*`                       |
| `C:\FiyatUcuz\config\migration.env` | Administrators/SYSTEM only; LocalService **no access**                        | Migration credential only; used only via `--env-file`; never merged with `api.env`   |
| Backup credential                   | —                                                                             | Reaches `pg_dump` only as `PG*` variables of the child process, from `migration.env` |

A production secret never appears in: Git, command-line arguments, receipts, screenshots, tickets or chat, copied or attached logs, development or staging environments. Env files are checked with the key-only validators (`validate-api-env`, `validate-migration-env`); their contents are never displayed. Rotate on suspected exposure and when people with access leave.

Known accepted risk (gap G12): the migration credential is currently an administrative login (ADR-0019 follow-up).

## 10. Retention

**No automatic deletion.** `retention-report` is advisory only.

Keep:

- the current release and the rollback target (`current`, `current.prev`), with their seals;
- the last two successful releases;
- every release referenced by an open incident;
- deployment receipts and approval records — indefinitely;
- migration backups — at least **30 days AND at least two later successful deployments**; only then may one be considered for **manual** deletion;
- incident evidence — until the incident is closed, plus 90 days.

Cleaning `staging\work` is a manual decision. The raw feed archive (`data\feed-archive`) is a separate storage concern and is **never** reduced by deployment cleanup.

## 11. Emergency / hotfix (class E)

There is **no force or bypass mode**.

May be shortened, only when recorded in the approval record:

- the per-release staging rehearsal, for application-only fixes;
- the second person: `SELF-APPROVED (emergency)` with a written review within 24 hours.

Never skipped:

- exact SHA and artifact integrity (manifest, archive, seal);
- secret separation and env policy;
- service identity;
- junction precheck;
- migration review and classification;
- backup when any migration exists;
- health and listener verification;
- receipt.

Class D is never deployed as an emergency. Hand-run SQL is not an emergency procedure.

## 12. 15A-7 Windows staging gate

ADR-0021 stays **proposed** until a dated 15A-7 record on Windows staging (non-production database) contains evidence for:

| Area                  | Evidence                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| PowerShell            | 5.1 version output; every script parses and runs                                               |
| Junctions             | create, read (`LinkType`, `Target`), rename, non-recursive delete; dangling junction detection |
| Partial swap recovery | interrupted activation and interrupted rollback recovered                                      |
| NTFS hard links       | a hard link is detected; copy-imported files report link count 1                               |
| Install / build       | copy-import, filtered `pnpm install` (frozen lockfile), `tsc` build per package                |
| Native module         | `@node-rs/argon2` loads under LocalService                                                     |
| LocalService access   | effective allowed and denied access per path (staging only)                                    |
| WinSW                 | v2.12.0 XML verified/corrected (gap G6); stop and start behaviour and timings                  |
| Listener              | listener and process-tree snapshot accepted; wrong bind rejected                               |
| Archive               | Windows `tar.exe` listing format; rejection cases                                              |
| Backup                | real `pg_dump` / `pg_restore --list` against the non-production DB; restore drill              |
| Migrations            | status, apply, lock-busy and wrong-DB cases against the non-production DB                      |
| Receipts              | receipts of all runs above, checked for secrets                                                |
| Tooling follow-ups    | G1, G2, G3 (code-resolved in 15A-6A, §16) behave as specified on Windows                       |

## 13. Post-deployment verification

Required after every production deployment (commands in the [checklist](production-deployment-checklist.md)):

1. `FiyatUcuzApi` is Running.
2. Local `http://127.0.0.1:4000/health` returns 200 with `{"status":"ok"}`.
3. The only listener on port 4000 is `127.0.0.1:4000`.
4. Migration status: nothing pending and nothing "recorded but missing from this checkout". (After `ROLLED_BACK_APP_ONLY` the restored, older release legitimately shows recorded-but-missing migrations — see [incident-recovery.md](incident-recovery.md#rolled_back_app_only).)
5. The receipt's final status is `COMPLETED`.
6. `current` points to the approved release ID.
7. The seal of the active release verifies.
8. A manual smoke test of one endpoint that reads the database (gap G4: `/health` is liveness only).
9. External HTTPS health from a machine **outside** the server (NAT hairpin is unreliable).

No IIS reset is part of verification.

## 14. Permanent production prohibitions

Only the `FiyatUcuzApi` service may be controlled by FiyatUcuz deployment. Never:

- `iisreset`, or IIS / ARR / SSL / firewall changes as part of a deployment;
- replace the global Node, change the system `PATH` or machine environment, change global pnpm / Corepack;
- restart SQL Server, PM2 or any DataMedia service;
- `taskkill` node.exe, or `Stop-Process` against Node processes in general;
- wildcard service operations;
- expose port 4000 beyond `127.0.0.1`;
- delete activation junctions recursively;
- rename or move a release directory;
- create, edit or delete migration tracking rows by hand;
- create temporary services or Scheduled Tasks for deployment.

## 15. Operator command safety

- Production commands use exact paths, the exact service name and an explicit `-Root C:\FiyatUcuz`.
- Every command is labelled `[STAGING]`/`[PRODUCTION]` and `[READ-ONLY]`/`[MUTATING]`.
- Placeholders are written as `<…>`; PowerShell refuses to run them unchanged, so a block cannot be pasted and executed by accident.
- Before any `[MUTATING]` production command, the operator re-reads the approval record and confirms the release ID, seal SHA-256 and the machine name.
- No wildcard, recursive-delete or "cleanup" convenience commands appear in runbooks.

## 16. Known tooling gaps

Code-resolved in ADIM 15A-6A — still to be proven on Windows staging (15A-7):

| Gap    | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** | Receipt identity (`release.id`, `gitCommit`, `manifestSha256`, `sealSha256`) comes only from verified data — Prepare's own hashes and the verified seal — and is write-once: a missing value never erases it, a different value fails closed (`RECEIPT_IDENTITY_CONFLICT`). Operator inputs are kept separately under `requested`. `archiveSha256` is Prepare evidence; Activate leaves it `null` (the Prepare and Activate receipts link via release ID + manifest SHA-256). |
| **G2** | The status parser is strict (unrecognized output → `STATUS_UNPARSEABLE`) and reports recorded-but-missing migrations separately. Normal Activate refuses them (`RECORDED_BUT_MISSING`) before review, backup, migration, service stop and any junction change. Rollback paths do not run this check.                                                                                                                                                                          |
| **G3** | Backup evidence includes database name, `createdAt`, `completedAt`, `pgDumpVersion` and `pgDumpMajor` (§7).                                                                                                                                                                                                                                                                                                                                                                   |

Recorded, handled by policy for now:

| Gap | Handling                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- |
| G4  | `/health` is liveness, not database readiness → manual database-reading smoke test (§13).                                           |
| G5  | Current CI (format, lint, typecheck, build; no tests) is not sufficient release evidence → preparer records test/build results.     |
| G6  | WinSW v2.12.0 XML must be verified/corrected in 15A-7 (the template uses a newer `serviceaccount` form).                            |
| G7  | No environment marker → labelled runbooks, explicit `-Root`, separate staging machine.                                              |
| G8  | The first legacy `app\` → `current` cutover is a 15A-P procedure; Activate requires `current` to already point to a sealed release. |
| G11 | Migration review must consider `lock_timeout` (§6).                                                                                 |
| G12 | Administrative migration credential is a known accepted risk for now.                                                               |
| G13 | Approver manually confirms the exact commit exists on `origin/main`.                                                                |
