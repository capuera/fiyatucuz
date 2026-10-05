# Production deployment checklist

Per-deployment approval record for the [production operations standard](production-operations-standard.md). Copy this file's **Record** section into a new file per deployment, store it with the receipts in `C:\FiyatUcuz\deployments\` (or reference it from them), and fill every field. A field that cannot be filled is a **NO-GO**.

> This checklist does **not** authorize production use of the 15A-4 tooling. Production use additionally requires a successful 15A-7, ADR-0021 accepted, and an approved 15A-P cutover ([standard §2](production-operations-standard.md#2-production-authorization)).

**Unknown or ambiguous = NO-GO.** No gate may be marked GO "with exceptions"; an exception is a NO-GO until the cause is fixed.

---

## Record

### Identity

| Field                                                | Value                                                |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Deployment window (planned)                          |                                                      |
| Environment                                          | `PRODUCTION`                                         |
| Machine name                                         |                                                      |
| Git commit (40 hex)                                  |                                                      |
| Commit confirmed on `origin/main` (by approver, G13) | yes / no                                             |
| Release ID (`yyyymmdd-<12 hex>`)                     |                                                      |
| Manifest SHA-256                                     |                                                      |
| Archive SHA-256                                      |                                                      |
| Seal SHA-256 (from Windows Prepare)                  |                                                      |
| Rollback target (current release ID)                 |                                                      |
| Change class (A / B / C / D / E)                     |                                                      |
| Prepare receipt                                      | `C:\FiyatUcuz\deployments\<UTC_STAMP>-prepare.json`  |
| Activate receipt                                     | `C:\FiyatUcuz\deployments\<UTC_STAMP>-activate.json` |

### People

| Role                 | Name                                                       | Date / time |
| -------------------- | ---------------------------------------------------------- | ----------- |
| PREPARED BY          |                                                            |             |
| REVIEWED/APPROVED BY |                                                            |             |
| OPERATOR             |                                                            |             |
| Separation           | two-person / **SELF-APPROVED (single operator)** — reason: |             |

Never record a two-person review that did not happen.

### Evidence

| Evidence                                                                                                  | Value / reference |
| --------------------------------------------------------------------------------------------------------- | ----------------- |
| Clean `prepare` at the commit                                                                             |                   |
| Green CI run for the exact commit (run link; [CI](../development/ci.md))                                  |                   |
| Build / typecheck result                                                                                  |                   |
| Known issues and disposition (no unresolved critical)                                                     |                   |
| 15A-7 validation record                                                                                   |                   |
| Per-release staging rehearsal (required for B–D)                                                          |                   |
| Migration status: pending list                                                                            |                   |
| Migration status: "recorded but missing from this checkout" (must be empty; Activate refuses otherwise)   |                   |
| Migration review (per file, [standard §6](production-operations-standard.md#6-migration-review-standard)) |                   |
| pg_dump / pg_restore paths and versions; DB server version                                                |                   |
| Free disk on `C:`                                                                                         |                   |

---

## Gate 1 — PREPARATION GO

All must be true. Any "no" or "unknown" is NO-GO.

- [ ] Exact 40-char SHA; it exists on `origin/main` (wrong SHA → NO-GO)
- [ ] `prepare` ran on a clean tree (dirty tree → NO-GO)
- [ ] Manifest SHA-256 and archive SHA-256 recorded and re-checked on the host (integrity mismatch → NO-GO)
- [ ] Windows Prepare finished with `PREPARED`, and the seal SHA-256 is recorded
- [ ] Test and build evidence recorded for this commit (missing → NO-GO)
- [ ] Every pending migration classified (unknown classification → NO-GO)
- [ ] No class D migration together with the release that introduces its code dependency
- [ ] Known issues reviewed; no unresolved critical issue
- [ ] 15A-7 record exists; per-release staging rehearsal done when required
- [ ] Approval fields complete (including SELF-APPROVED marking when applicable)

## Gate 2 — MIGRATION GO

Only when migrations are pending. All must be true.

- [ ] Read-only status shows the expected pending set and **no** "recorded but missing from this checkout" entries (Activate refuses them: `RECORDED_BUT_MISSING`)
- [ ] Reviewed list (`-ReviewedMigrations`) equals the pending set exactly
- [ ] Expected database matches the target (wrong DB → NO-GO)
- [ ] pg_dump / pg_restore present; pg_dump major version ≥ server major version
- [ ] Window agreed for class C
- [ ] Backup will be verified before apply (the tooling enforces it; backup failure → NO-GO)
- [ ] No other migration run in progress (migration lock unavailable → NO-GO; never retried in a loop)

## Gate 3 — ACTIVATION GO

The Activate read-only gate checks these automatically; the operator records the outcome. Any failure → NO-GO.

- [ ] Target seal verifies with the recorded seal SHA-256 (seal mismatch → NO-GO)
- [ ] Service identity: `FiyatUcuzApi`, WinSW path, `NT AUTHORITY\LocalService` (mismatch → NO-GO)
- [ ] Junction state clean: `current` → sealed release, no `current.next`, no unexpected entries (ambiguity → NO-GO)
- [ ] Rollback target present and its seal verifies (missing rollback target → NO-GO)
- [ ] Static ACL check passes (mismatch → NO-GO)
- [ ] ≥ 5 GiB free (disk shortage → NO-GO)
- [ ] Portable Node 22 / pnpm 9.15.4 match the manifest (runtime mismatch → NO-GO)
- [ ] `api.env` policy passes (unsafe `api.env` → NO-GO)
- [ ] Migration state is `NOT_NEEDED` or `SUCCEEDED` (anything else → no activation)

## Gate 4 — POST-DEPLOYMENT GO

All on the production server unless stated; all **read-only**. Any failure → follow [incident-recovery.md](incident-recovery.md).

- [ ] Receipt final status `COMPLETED`
- [ ] Receipt `release.gitCommit`, `release.manifestSha256`, `release.sealSha256` equal the approved values (verified identity; `requested.*` only holds the typed inputs)
- [ ] For migration deployments: receipt `backup` shows database name, `createdAt`, `completedAt`, `pgDumpVersion`, SHA-256 and `restoreListOk: true`
- [ ] `FiyatUcuzApi` Running
- [ ] Local `/health` → 200 and `{"status":"ok"}`
- [ ] Only listener on port 4000 is `127.0.0.1:4000`
- [ ] Migration status: nothing pending, nothing "recorded but missing"
- [ ] `current` → approved release ID
- [ ] Active release seal verifies
- [ ] Manual smoke test of one endpoint that reads the database (G4) — endpoint and result:
- [ ] External HTTPS health from a machine **outside** the server — machine and result:

Final outcome recorded: `COMPLETED` / other: \_\_\_\_\_\_ (then incident record reference: \_\_\_\_\_\_)

---

## Read-only verification commands

Run in an elevated Windows PowerShell 5.1 on the production server. `<…>` placeholders must be replaced; PowerShell refuses to run them unchanged. None of these commands changes anything.

```powershell
# [PRODUCTION] [READ-ONLY] service state
Get-CimInstance -ClassName Win32_Service -Filter "Name='FiyatUcuzApi'" | Select-Object Name, State, ProcessId, StartName, PathName

# [PRODUCTION] [READ-ONLY] local health (must be 200 and {"status":"ok"})
Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:4000/health | Select-Object StatusCode, Content

# [PRODUCTION] [READ-ONLY] listeners on port 4000 (only 127.0.0.1 allowed)
Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess

# [PRODUCTION] [READ-ONLY] activation junction
Get-Item -LiteralPath C:\FiyatUcuz\current -Force | Select-Object FullName, LinkType, Target

# [PRODUCTION] [READ-ONLY] seal of the active release
& C:\FiyatUcuz\runtime\node22\node.exe <TOOLS_ROOT>\scripts\release\api-release.mjs verify --release C:\FiyatUcuz\releases\<RELEASE_ID> --stage sealed --seal C:\FiyatUcuz\releases\<RELEASE_ID>.seal.json --seal-sha256 <SEAL_SHA256>

# [PRODUCTION] [READ-ONLY] api.env policy (keys only; values are never printed)
& C:\FiyatUcuz\runtime\node22\node.exe <TOOLS_ROOT>\scripts\deploy\deploy-cli.mjs validate-api-env --file C:\FiyatUcuz\config\api.env --root C:\FiyatUcuz
```

Migration status (read-only, takes no lock). `deploy-cli` runs the migration CLI with a sanitized environment and reports `applied`, `pending` and `recordedMissing` (no credentials, no database user). It exits `1` with `RECORDED_BUT_MISSING` when the database records migrations the release does not contain — expected after `ROLLED_BACK_APP_ONLY`, a NO-GO otherwise:

```powershell
# [PRODUCTION] [READ-ONLY] migration status of the active release
& C:\FiyatUcuz\runtime\node22\node.exe <TOOLS_ROOT>\scripts\deploy\deploy-cli.mjs migration --mode status --node C:\FiyatUcuz\runtime\node22\node.exe --cli C:\FiyatUcuz\current\packages\db\dist\cli\migrate.js --env-file C:\FiyatUcuz\config\migration.env
```

External health — from a machine **outside** the server:

```powershell
# [PRODUCTION] [READ-ONLY] external HTTPS health
curl.exe -sS https://api.fiyatucuz.com/health
```

Never display the contents of `api.env` or `migration.env`, and never paste receipts or logs containing connection details into tickets or chat.
