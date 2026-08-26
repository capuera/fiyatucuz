---
number: 0017
title: Raw feed archive storage (provider-independent, local-first foundation)
status: accepted
date: 2026-08-24
deciders: project owner
supersedes:
superseded-by:
---

# 0017 — Feed archive storage

## Context

ADR-0016 established the feed-fetch pipeline with a deliberate hole: the raw feed body is streamed, hashed, and **discarded**. `feed_fetches.raw_archive_ref` was reserved for future use. Operationally that is untenable — support/debugging, replay against a future catalog parser, and auditability all require the exact bytes that were fetched.

We need to preserve raw feed bodies without:
- putting them in PostgreSQL (multi-MiB feeds; wrong storage tier),
- coupling feed business logic to a specific cloud vendor,
- introducing a required cloud dependency for local development.

## Decision

### 1. Raw bodies never live in PostgreSQL

`feed_fetches.raw_archive_ref` (existing `text NULL` column, migration 0005) stores **only an opaque reference** to a raw body owned by a separate storage layer. No migration is added in this sprint — the existing column is adequate.

### 2. Provider-independent abstraction

A narrow interface (`services/api/src/modules/feeds/archive/`):

```ts
interface FeedArchive {
  openWriter(key: FeedArchiveKey): Promise<FeedArchiveWriter>;
  read(ref: FeedArchiveRef):        Promise<AsyncIterable<Uint8Array>>;
  exists(ref: FeedArchiveRef):      Promise<boolean>;
  delete(ref: FeedArchiveRef):      Promise<void>;
}

interface FeedArchiveWriter {
  write(chunk: Uint8Array): Promise<void>;
  finalize():               Promise<FeedArchiveRef>;
  abort():                  Promise<void>;
}
```

- `FeedArchiveKey = { tenantId, feedId, fetchId, format }` — every ID must be a validated UUID.
- `FeedArchiveRef` is an opaque `feed-archive://…` string (see §Reference format).
- `openWriter` returns a chunk-driven writer so the fetch pipeline never buffers a whole feed.

This shape works unchanged for future adapters — `S3CompatibleFeedArchive`, `AzureBlobFeedArchive`, `GcsFeedArchive`. No feed business logic imports storage internals.

### 3. Local filesystem adapter (this sprint)

`LocalFilesystemFeedArchive` — the only implementation for now.

Layout under `FEED_ARCHIVE_LOCAL_ROOT`:

```
<root>/tenant/<tenantId>/feed/<feedId>/fetch/<fetchId>/raw.<ext>
```

Write discipline:
1. `mkdir -p` target directory with `0o700` (POSIX; on Windows the mode is largely a no-op — directory ACLs are configured out-of-band by the deployment).
2. `open(tmpPath, 'wx', 0o600)` — `O_CREAT|O_EXCL` so a squatting attacker cannot swap in a symlink at the tmp filename.
3. Stream chunks via `FileHandle.write`.
4. On `finalize`: `fsync → close → promote-tmp-to-final`. Promotion is platform-aware (`archive/local.ts §promoteTmpToFinal`):
   - **POSIX**: `link(tmp, final) + unlink(tmp)`. `link` returns `EEXIST` atomically if `final` already exists — the "never overwrite" invariant is enforced at the kernel level. Using `link` here (instead of `rename`, which silently overwrites) closes the POSIX-vs-Windows gap.
   - **Windows / NTFS**: `rename(tmp, final)`. `MoveFile` (without `MOVEFILE_REPLACE_EXISTING`) fails when the destination exists, returning `EEXIST` / `EPERM` / `EACCES` — all mapped to `ARCHIVE_ALREADY_EXISTS`. `link` is not used on Windows because hardlink creation requires elevated privileges on some NTFS mounts.
5. On `abort` (or partial-finalize failure): `unlink` the tmp file.

The final object only becomes visible under its canonical name after the promote step — a partial archive is never mistaken for a successful one, on either platform.

Symlink hardening:
- `openWriter` `lstat`s the final path; a symlink triggers `ARCHIVE_UNSAFE_PATH` rather than being overwritten.
- `read`/`exists`/`delete` all `lstat` first; a symlink is refused (or in delete's case, unlinked without following).

### 4. Reference format

```
feed-archive://<tenantId>/<feedId>/<fetchId>/raw.<ext>
```

- `ext ∈ {xml, csv}` — derived from the trusted `FeedFormat`, never from a filename supplied by the remote server or a merchant.
- All three IDs are validated as UUIDs when parsing; any other value fails `INVALID_ARCHIVE_REF`.
- Path traversal (`..`, backslashes, NUL bytes, `//`) rejected in `parseArchiveRef`; even so the local adapter re-verifies that the resolved absolute path stays under `path.resolve(root) + sep`.
- Deterministic: any operator with `(tenantId, feedId, fetchId)` and the format can reconstruct the ref. No DB round-trip needed for archive operations.

Why not store an absolute OS path in the DB? Because:
- it leaks server-internal layout,
- it breaks the moment the archive root moves,
- it invites path-injection bugs on read paths.

### 5. Streaming integration

The fetcher (`services/api/src/modules/feeds/fetcher.ts`) opens the writer **after** the response is confirmed 2xx + accepted content-type, then streams every chunk in one pass alongside:

- byte-count cap (`FEED_FETCH_MAX_BYTES`),
- SHA-256 hasher,
- UTF-8 encoding gate (ADIM 12.2, first ≤ 1 KiB prefix),
- streaming XML security scanner (ADIM 12.1),
- **archive writer** (this sprint).

Nothing buffers the whole body. Peak memory is `O(encoding-prefix + one chunk + scanner-overlap)` per fetch — plus the OS's own write buffering into the tmp file.

### 6. Integrity model

The archive writer receives the **exact bytes** hashed by `crypto.createHash('sha256')`. No transformation, no re-encoding. Tests prove:

- `sha256(archived bytes) === feed_fetches.content_hash` (`req 3` in test list).
- Bytes read back from the archive equal the bytes originally sent (`req 16`).

### 7. Failure semantics

The strict rule:

> A `feed_fetches` row must never claim `SUCCESS` with a `raw_archive_ref` that was not successfully finalized.

Guaranteed by:
- The writer is opened **after** all pre-body validation (SSRF, HTTP status, content-type).
- Any subsequent read/validation error calls `writer.abort()` — removes the tmp file, no visible archive.
- `writer.finalize()` is the last step before returning `success`; a failed finalize returns a `failure` with `ARCHIVE_WRITE_FAILED` and **no** archive ref.
- The service's SUCCESS branch is the only place `rawArchiveRef` is persisted.

The **opposite** failure — archive finalized, DB update fails — is possible. Filesystem/S3 cannot join a PostgreSQL transaction; a distributed 2PC is explicitly out of scope. Handling:

- The service catches the "DB update returned no row" case, best-effort `archive.delete()`s the newly finalized object, and logs a `warn` including the ref.
- If the delete itself also fails, the archive is a documented **orphan** (bytes on disk, no DB row referencing them). A future reconciliation/GC job (`follow-up`) is the right home for periodic cleanup.

### 8. Config

| Env | Default | Purpose |
|---|---|---|
| `FEED_ARCHIVE_DRIVER` | `local` | Enum. Only `local` in this sprint. |
| `FEED_ARCHIVE_LOCAL_ROOT` | dev fallback | Absolute path to archive root. Dev/test fallback: `<os.tmpdir()>/fiyatucuz-feed-archive`. |

Production boot enforces (`assertProductionFeedArchiveSafety`):
- `FEED_ARCHIVE_LOCAL_ROOT` must be set explicitly (no tmpdir fallback in prod),
- must be an absolute path,
- must not live inside `process.cwd()` (heuristic — an archive under the repo would be blown away on redeploy).

### 9. Read access

`FeedArchive.read(ref)` returns an `AsyncIterable<Uint8Array>` — internal use only. **No public raw-feed download endpoint** ships in this sprint. When a future authenticated admin/debug endpoint lands, it will consume this interface unchanged.

### 10. Delete / retention

`FeedArchive.delete(ref)` is idempotent. No automatic retention scheduler in this sprint. Documented follow-up:

- successful raw archives retained N days (configurable),
- FAILED/REJECTED fetches do not retain bodies (already true — writer is aborted),
- reconciliation job: enumerate archives whose `feed_fetches` row is missing/expired and remove them,
- retention runs against `FeedArchive.delete`, so the same policy works for every driver.

We refuse to pick a silent production retention default now — the trade-off between debuggability and storage cost belongs to the deployment, not the code.

### 11. Security model

Audited, with tests:

| Threat | Control |
|---|---|
| Path traversal via ref | UUID-only segments in `parseArchiveRef`; extra `..`/`\`/`\0`/`//` guards. |
| Absolute-path injection | UUID regex rejects any absolute path. |
| Symlink attack on target | `lstat` before open + `wx` (`O_EXCL`) on tmp path. |
| Cross-tenant read | Service constructs the ref from ambient `tenantId` — a ref carrying a foreign tenant would fail service-boundary tenant scoping. Adapter never rewrites tenant. |
| Cross-tenant delete | Same — deletes go through the service; direct adapter calls require the caller to already possess a matching ref. |
| Accidental overwrite | `openWriter` refuses when the final path already exists. |
| Partial file exposed as success | `finalize` uses `fsync + rename`; no visible file until rename. |
| Temp file leakage | Every rejection/failure path calls `writer.abort()` which unlinks the tmp file; a failing `handle.write` self-aborts. |
| Raw path leakage | The DB and API only ever expose `feed-archive://…` URIs — never OS paths. |
| Unbounded buffering | Streaming end-to-end; no `await response.text()` / `arrayBuffer()`. |
| Sensitive feed content in logs | Fetcher & service log refs and error codes only; feed bodies are never logged (existing ADIM 10.1 log-redaction still applies). |
| Web-served archive dir | Documented: production archive root must not be under any web server's document root. |

### 12. Windows Server 2022 (production host)

The **real production host is Windows Server 2022 Standard on x64**; macOS ARM64 is the developer machine only. The application itself supports native Windows execution — no macOS-specific assumptions in code.

Runtime + path handling:
- Every filesystem path is built via `node:path` (`join`, `resolve`, `dirname`, `sep`, `isAbsolute`, `relative`). No `/`-string concatenation for FS paths.
- Archive URIs (`feed-archive://…`) intentionally use `/` because they are opaque URIs, not filesystem paths.
- `chmod 0o700` / `0o600` are POSIX-only; on Windows they set only the read-only bit. **Directory ACLs are the real security boundary on Windows** and must be applied out-of-band by the deployer (see §13).
- Promotion is platform-aware — see §Local adapter §Write discipline step 4. Both platforms end up with the same "never silently overwrite" invariant.
- Antivirus / Windows Search may hold brief locks on newly renamed files. Deployers should exclude `FEED_ARCHIVE_LOCAL_ROOT` from real-time AV scanning for high-volume ingestion.
- **Never** hard-code `C:\` or any specific drive letter; the env var carries the path.
- Local development on macOS/Linux uses the OS temp directory fallback; on Windows dev machines the same fallback resolves to `C:\Users\<user>\AppData\Local\Temp\fiyatucuz-feed-archive`. No Mac-specific paths in code.

### 13. Windows archive configuration / ACL guidance

Production configuration (documentation only — never a default in code):

```
FEED_ARCHIVE_DRIVER=local
FEED_ARCHIVE_LOCAL_ROOT=D:\FiyatUcuzData\FeedArchive
```

Deployment checklist (Windows Server 2022):
- Archive root MUST live on a dedicated data volume (e.g. `D:\` or `E:\`), NOT under the deployment / working directory (the boot assertion rejects any `FEED_ARCHIVE_LOCAL_ROOT` inside `process.cwd()`).
- Archive root MUST be outside the IIS web root. It is internal-only; there is no public download endpoint in this sprint.
- Archive root MUST be excluded from any IIS static content configuration.
- The application service identity requires ACL grants of **only** `Read | Write | Create | Delete` on the archive tree — no execute, no ACL modification.
- Do NOT rely on `chmod 0o700 / 0o600` — those are no-ops on Windows. Configure directory ACLs via `icacls` (or the Windows Server GUI) during deployment.
- Consider excluding the archive directory from Windows Defender real-time scanning for high-volume feed ingestion.
- Backup policy MUST include the archive tree if raw-feed replay is an operational requirement. Otherwise, document that feeds cannot be replayed after backup restore.

### 14. Production hosting shape

Two deployment shapes are supported, evaluated independently:

**A. Native Windows deployment (primary for fiyatucuz.com)**
- Node.js **22 LTS x64** installed on Windows Server 2022 Standard.
- The compiled artifact (`services/api/dist/index.js` + workspace packages' `dist/`) runs directly via `node dist/index.js`.
- Windows service wrapper / process manager (nssm, node-windows, or a native Windows Service) — **choice deferred to a later sprint**.
- IIS ARR (Application Request Routing) or equivalent reverse proxy in front for HTTPS termination — **not configured in this sprint**.
- Persistent archive directory on NTFS (dedicated data volume; see §13).
- Native dependency `@node-rs/argon2` is installed for **win32-x64** at deploy time — either by running `pnpm install --frozen-lockfile` on the Windows host, or by producing a per-target CI artifact. **Never copy `node_modules` from the macOS dev machine to Windows** (§Native dependencies below).

**B. Containerized deployment (Linux container image)**
- The existing `services/api/Dockerfile` produces an Alpine-based x64 Linux image with `@node-rs/argon2` prebuilt for the container's musl runtime.
- Requires a Linux container host / runtime on the deployment side.
- Persistent archive directory is a mounted volume.
- **Docker Desktop on Windows Server is not a supported production platform** — its licensing and its dependency on WSL2 / Hyper-V make it a developer tool. If containerized deployment is desired for fiyatucuz.com, the correct target is a dedicated Linux container host (Kubernetes, Podman on Linux, ECS/AKS/GKE), not Docker Desktop on the Windows box.

Neither IIS nor a specific Windows service manager is installed or configured by this sprint. Only the application-side native-Windows compatibility is delivered here.

### 15. Native dependencies

| Dependency | Native? | Notes |
|---|---|---|
| `@node-rs/argon2` | **yes** (Rust NAPI-RS) | ships prebuilt binaries per platform (`@node-rs/argon2-darwin-arm64`, `@node-rs/argon2-win32-x64-msvc`, `@node-rs/argon2-linux-x64-gnu`, etc.). pnpm selects the right one via `optionalDependencies` at install time. |
| `undici` | no | pure JS. |
| `postgres` (postgres.js) | no | pure JS TCP driver, no `pg-native`. |
| `drizzle-orm` / `drizzle-kit` | no | pure JS. |
| `pino` / `pino-pretty` | no | pure JS. |
| `fastify` / `@fastify/*` | no | pure JS. |
| `zod` | no | pure JS. |

Consequence: **do not copy `node_modules` from the macOS dev machine to the Windows Server 2022 host**. `@node-rs/argon2` would land as the darwin-arm64 binary and fail to load on win32-x64. The correct workflow is either:
- **on-host install**: `pnpm install --frozen-lockfile` on the Windows Server (pnpm picks the `@node-rs/argon2-win32-x64-msvc` optional dep), then `pnpm build` on the Windows host, or
- **CI-per-target build**: run `pnpm install --frozen-lockfile` inside a Windows Server 2022 x64 CI runner, ship the resulting `node_modules` alongside the built `dist/` as a deploy artifact.

Both flows are documented; the choice is a CI/CD decision, not an application decision.

## Alternatives considered

- **Ship an S3 adapter now.** Rejected — the abstraction cost is the same, and dev/self-hosted operators shouldn't be forced onto AWS. Local first proves the shape.
- **Store raw feeds in a `bytea` column.** Rejected — turns the primary DB into a blob store, ruins backups, and does not scale past a few tenants.
- **Two-phase commit (DB + filesystem).** Rejected — not implementable across arbitrary object stores; adds complexity for a small orphan window that a periodic reconciliation covers.
- **Public download endpoint in this sprint.** Rejected — scope creep and a real access-control conversation of its own; the interface is ready when that lands.
- **Retention scheduler.** Rejected — silent destructive defaults are unacceptable. Explicit follow-up.

## Consequences

**Positive**
- SUCCESS ⇒ finalized archive; no false-positive refs.
- Every archive rejection / failure path leaves no visible artifact.
- The DB carries only opaque references — no server-internal paths, no vendor identifiers.
- Feed business logic is unchanged when S3 or Azure Blob adapters ship later.
- Windows / Linux / macOS all supported via Node's `fs` + `path`.

**Negative**
- Orphan objects possible after DB failure — mitigated by best-effort cleanup + a documented reconciliation follow-up.
- Local driver runs on the API host's disk; scale-out will need a shared driver (S3 / Azure) — that's why the abstraction exists.
- No automatic retention — operators must plan disk growth.

**Neutral**
- No migration: `raw_archive_ref` already sized for `text`.
- Dev/test fallback puts the archive in the OS temp dir; explicit prod config is required.

## Follow-ups

- `S3CompatibleFeedArchive` adapter (`aws-sdk` v3 style, MinIO-compatible).
- `AzureBlobFeedArchive` adapter.
- Retention scheduler job with configurable N-day policy per driver.
- Reconciliation / orphan-GC job that walks the archive and compares against `feed_fetches`.
- Authenticated admin download endpoint using `FeedArchive.read`.
- Signed-URL variant for adapters that support it (S3/Azure), still gated behind auth.
