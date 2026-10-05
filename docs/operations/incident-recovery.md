# Incident recovery — deployment outcomes

Operational response to deployment outcomes of the 15A-4 tooling, under the [production operations standard](production-operations-standard.md). Statuses are defined in [windows-deployment.md](windows-deployment.md#final-statuses).

> This runbook does **not** authorize production use of the tooling ([standard §2](production-operations-standard.md#2-production-authorization)). Until then it applies to Windows staging rehearsals.

## Ground rules for every incident

1. **Stop and read before acting.** Collect the evidence below before any change. Prefer doing nothing over guessing.
2. **The database is never rolled back by tooling.** An application rollback after a migration is **APP-ONLY**, never a "full rollback". A database restore is a separate, manual, approved decision that loses writes made after the backup ([standard §8](production-operations-standard.md#8-rollback-standard)).
3. **Only `FiyatUcuzApi`** may be controlled. The [permanent prohibitions](production-operations-standard.md#14-permanent-production-prohibitions) apply during incidents too — urgency does not relax them.
4. **Record everything** in an incident record linked from the deployment's approval record: time, who, what was observed, what was done.
5. Escalate to the approver for any action this runbook does not list under MAY.

## Evidence to collect (read-only)

Run in an elevated Windows PowerShell 5.1 on the affected server. `<…>` placeholders must be replaced; PowerShell refuses to run them unchanged. None of these commands changes anything. Use `[STAGING]` instead of `[PRODUCTION]` when the incident is on the staging machine.

```powershell
# [PRODUCTION] [READ-ONLY] latest receipts
Get-ChildItem -LiteralPath C:\FiyatUcuz\deployments -Filter *.json | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, LastWriteTime

# [PRODUCTION] [READ-ONLY] one receipt (secret-free by construction; still do not paste it into chat)
Get-Content -LiteralPath C:\FiyatUcuz\deployments\<RECEIPT_FILE>.json

# [PRODUCTION] [READ-ONLY] service state and PID
Get-CimInstance -ClassName Win32_Service -Filter "Name='FiyatUcuzApi'" | Select-Object Name, State, ProcessId, StartName, PathName

# [PRODUCTION] [READ-ONLY] child processes of the service PID
Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=<SERVICE_PID>" | Select-Object ProcessId, Name, CommandLine

# [PRODUCTION] [READ-ONLY] activation pointers (each may be absent)
foreach ($n in 'current', 'current.next', 'current.prev', 'current.failed') { Get-Item -LiteralPath (Join-Path C:\FiyatUcuz $n) -Force -ErrorAction SilentlyContinue | Select-Object Name, LinkType, Target }

# [PRODUCTION] [READ-ONLY] listeners on port 4000
Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess

# [PRODUCTION] [READ-ONLY] recent API / WinSW logs
Get-ChildItem -LiteralPath C:\FiyatUcuz\logs\api | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, LastWriteTime
Get-Content -LiteralPath C:\FiyatUcuz\logs\api\<LOG_FILE> -Tail 200
```

Migration status (read-only, no lock) — see the [checklist](production-deployment-checklist.md#read-only-verification-commands) for the exact command.

**Preserve, never delete or edit:** the receipt(s), `C:\FiyatUcuz\staging\work\snapshots\*`, `C:\FiyatUcuz\logs\api\*`, the release directories involved and their seals, the deployment backup in `C:\FiyatUcuz\staging\db-backups\`. Copies for analysis stay on the server or in an access-controlled location; never attach logs or receipts containing connection details to tickets or chat.

## Response matrix

### FAILED_NO_CHANGE

Stopped before any production change; the database may still be checked to confirm.

- **MAY:** read the receipt for the failed check; fix the cause (e.g. disk, ACL, env policy, wrong seal digest); start a new deployment with a new approval record.
- **If the cause is `RECORDED_BUT_MISSING`:** the database records migrations this release does not contain (the release is older than the schema). Build a fix-forward release that contains every recorded migration file. Never edit or delete tracking rows, never write a down-migration.
- **MUST NOT:** bypass or edit the gate; reuse an approval record whose identifiers changed.
- **PRESERVE:** receipt, preflight output, snapshots.

### FAILED_MIGRATION_PARTIAL

The database **may have changed**; the new release was **not** activated; the previous release still serves.

- **MAY:** read `migrations.state` and `migrations.knownApplied` in the receipt; run the read-only migration status; confirm the running release is healthy; plan a fix-forward release with a newly reviewed migration; ask the approver whether a database restore must be considered.
- **MUST NOT:** re-run the deployment unchanged; run SQL by hand; create, edit or delete migration tracking rows; write a down-migration; restore the database without approval.
- **PRESERVE:** receipt, migration CLI output in the receipt, the pre-migration backup (retention extended until the incident is closed).

### ROLLED_BACK

Activation failed and the previous release is serving again; the database is unchanged (no migration ran).

- **MAY:** analyse logs of the failed start/health/listener; verify the post-deployment checks against the restored release; prepare a fixed release.
- **MUST NOT:** re-activate the same release without a fix; delete the failed release directory while the incident is open.
- **PRESERVE:** receipt, `logs\api`, failed release directory and seal, `current.failed` pointer.

### ROLLED_BACK_APP_ONLY

The previous application is serving again; **DB NOT ROLLED BACK** — migrations of the failed deployment remain applied.

- **MAY:** confirm the restored release works with the new schema (post-deployment checks plus a database-reading smoke test); plan a fix-forward release.
- **EXPECTED:** the migration status of the restored release reports `RECORDED_BUT_MISSING` with the failed deployment's migration IDs — the restored release is older than the schema. The next normal deployment must be a **fix-forward** release containing every migration file recorded in the database; Activate refuses anything older.
- **MUST NOT:** call this a full rollback; restore the database without an approved data-loss assessment; remove the applied migrations by hand.
- **PRESERVE:** receipt (including the DB note), the pre-migration backup (extended retention), logs, the failed release.

### CRITICAL_OPERATOR_ACTION

State is uncertain (stop timeout, ambiguous junctions, failed rollback, unknown phase).

- **MAY:** collect all read-only evidence; compare the junction snapshot with the receipt; decide together with the approver on **one** explicit next step and record it before executing it.
- **MUST NOT:** re-run Activate or Rollback blindly; kill processes; use wildcard service commands; delete junctions recursively; rename or move release directories; restart IIS.
- **PRESERVE:** everything listed above.

### Receipt failure

- **Exit 3 (healthy, receipt not finalized):** the release is active and verified; the receipt still says `IN_PROGRESS`.
  - **MAY:** fix the cause (disk space, ACL on `deployments\`); record the final outcome in the approval record by hand, referencing the receipt.
  - **MUST NOT:** edit or overwrite the receipt; mark it `COMPLETED` by hand; roll back a healthy release because of it.
- **Before the service stop:** the deployment stopped; treat as `FAILED_NO_CHANGE` / `FAILED_MIGRATION_PARTIAL` per the reported status.
- **During rollback:** rollback continued (safety first); the final status may be missing from the receipt — reconstruct it from the console output and snapshots.
- **PRESERVE:** the receipt as it is, console output.

### Health failure / listener failure

After activation these trigger an automatic application rollback.

- **MAY:** read `logs\api`; check `api.env` with the key-only validator; check the listener owner and address.
- **MUST NOT:** open port 4000 beyond `127.0.0.1`; change firewall or IIS/ARR; restart IIS; edit `api.env` to bind other addresses.
- **PRESERVE:** logs, listener snapshot, receipt.

### Service stop timeout

`FiyatUcuzApi` did not stop within 60 s → `CRITICAL_OPERATOR_ACTION`; junctions were not swapped; nothing was killed.

- **MAY:** wait and observe the service state; inspect the process tree of the service PID; decide with the approver.
- **MUST NOT:** `taskkill` or `Stop-Process` any Node process; stop other services; reboot without approval.
- **PRESERVE:** service state, process list, WinSW log.

### Service start timeout

After the swap this triggers an automatic application rollback.

- **MAY:** read the WinSW and API logs; confirm the restored release is healthy.
- **MUST NOT:** hand-edit the WinSW XML or service configuration; change the service account.
- **PRESERVE:** WinSW log, receipt.

### Ambiguous junction state

Any activation pointer that is a real directory, points outside `releases\`, or a combination the planner does not recognize.

- **MAY:** collect the pointer listing above; compare with the receipt's `junctions.before`/`after`; with the approver, decide one correction of **activation pointers only**.
- **MUST NOT:** delete anything recursively; rename or move a release directory; remove a pointer that is not a junction; run Activate or Rollback to "see what happens".
- **PRESERVE:** pointer listing, snapshots, receipt.

## Closing an incident

An incident is closed when the approver has recorded: final service state, active release ID, migration status, whether a database restore was considered and why it was or was not done, and the follow-up items. Evidence is kept for 90 days after closing ([standard §10](production-operations-standard.md#10-retention)).
