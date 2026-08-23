---
number: 0016
title: Feed + Feed Fetch foundation (SSRF-safe, streaming, parser abstraction)
status: accepted
date: 2026-08-22
deciders: project owner
supersedes:
superseded-by:
---

# 0016 — Feed ingestion foundation

## Context

ADIM 11 landed `merchants` and `merchant_sites`. The next brick down the chain is **feeds**: merchant-supplied XML/CSV URLs that will eventually populate catalog + offers. This sprint ships the persistence + service + background-fetch foundation only — no product/catalog schema.

The single most important thing this sprint gets right is **SSRF safety on merchant-controlled URLs**. Everything else is table-shape, indexes, and glue.

## Decision

### Ownership shape

```
Tenant → Merchant → MerchantSite → Feed → FeedFetch (append-only history)
```

- `feeds` — tenant-scoped, RLS + FORCE RLS. Composite FK on `(merchant_site_id, tenant_id) → merchant_sites (id, tenant_id)`, same pattern established in ADR-0015. Prevents a feed from belonging to a site in a different tenant at the DB level.
- `feed_fetches` — tenant-scoped, RLS + FORCE RLS. Composite FK on `(feed_id, tenant_id) → feeds (id, tenant_id)`.

To enable the composite FK from feeds, migration 0005 adds `UNIQUE(id, tenant_id)` to `merchant_sites` via forward-only ALTER TABLE (0004 unchanged).

### Feed status vs feed fetch status

Two distinct enums:

- `feed_status`: `ACTIVE | PAUSED | ERROR | DISABLED` — configuration state, mutated by admin actions and (in the future) by the scheduler when a feed persistently fails.
- `feed_fetch_status`: `QUEUED | FETCHING | SUCCESS | NOT_MODIFIED | FAILED | REJECTED` — per-attempt lifecycle.

### Append-only semantics for feed_fetches

Rows are INSERTed at `QUEUED`; the fetcher transitions them through a **bounded state machine** (`QUEUED → FETCHING → SUCCESS | NOT_MODIFIED | FAILED | REJECTED`). No arbitrary UPDATE / DELETE surface is exposed to callers; the only mutations happen inside `service.performFetch` and `repo.markFetchState` (whose call sites are enumerable).

A future append-only-first architecture could replace UPDATE with INSERT of a new event row + a view; deferred as YAGNI for now.

### Raw feed storage

`raw_archive_ref` is nullable. **This sprint stores NULL** — the raw body is streamed, hashed, and discarded. Object storage (S3 / Azure / MinIO) is deferred; introducing a cloud dependency for the fetch foundation would be premature. When we adopt one:

- The schema is ready (column exists).
- A `FeedArchive` interface will land in a future sprint (`store(fetchId, stream) → ref`) with a `DiscardingArchive` default and one production implementation.

### SSRF threat model + validation layers

Merchant-supplied URLs are UNTRUSTED. Every fetch runs through `SafeUrlValidator`:

1. **Syntactic** (always runs, even in tests):
   - Scheme in `{http:, https:}`.
   - No userinfo (`user:pass@…`).
   - Port in `{'', 80, 443, 8080, 8443}`.
   - Hostname literal blocklist (`localhost`, `metadata.google.internal`, `metadata`, `instance-data`, `*.internal`, `*.local`, `*.arpa`).
   - IP-literal hostnames range-checked immediately.
2. **Network** (skipped only when `FEED_FETCH_ALLOW_PRIVATE_ADDRESSES=true`, which is TEST-ONLY and boot-fails in `NODE_ENV=production`):
   - Resolve the hostname via `dns.lookup(host, { all: true })`.
   - Reject if **any** resolved IP falls in an IPv4 blocked range (`0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` — includes AWS/GCP IMDS 169.254.169.254 — `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255`) or IPv6 blocked range (`::`, `::1`, `fc00::/7`, `fd00::/8`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `100::/64`, `64:ff9b::/`, IPv4-mapped `::ffff:*`).

**Per-hop revalidation for redirects.** The fetcher uses `redirect: 'manual'` on `fetch()`; on every `3xx` it resolves `Location` against the current URL and re-runs the full SSRF validation before hopping. Hop count is capped by `FEED_FETCH_MAX_REDIRECTS`.

### DNS rebinding — closed via connection-time IP pinning (ADIM 12.1)

The fetcher now uses **Undici with a per-request `Agent` whose connector
returns a caller-supplied IP** — no second OS DNS lookup happens between
validation and connect. Concretely:

1. `validateSafeUrl` resolves the hostname (all A/AAAA), rejects if ANY
   resolved IP is in a blocked range, and returns the resolved set.
2. The fetcher picks one validated IP and builds:
   ```ts
   const agent = new Agent({
     connect: {
       lookup: (_hostname, _opts, cb) => cb(null, resolvedIp, family),
     },
   });
   await undici.fetch(url, { dispatcher: agent, ... });
   ```
3. Undici's connector uses the `hostname` from the URL to derive TLS SNI /
   `servername`, so HTTPS certificate verification runs against the domain
   name — not the pinned IP. **HTTPS hostname verification is preserved.**
4. The Agent is scoped to a single fetch. Every redirect hop discards the
   previous agent (`agent.close()`) and creates a fresh one after
   re-validating the new URL against the SSRF policy.

The DNS rebinding TOCTOU is closed: even if the attacker's authoritative
DNS returns a public IP to our probe and a private IP to a subsequent
lookup, no second lookup happens — the socket-level connect targets the IP
we validated. This is scoped to `SafeFeedFetcher`; nothing else in the API
changes DNS behavior for unrelated HTTP clients.

**Multiple A/AAAA results.** `validateSafeUrl` returns `resolvedAddresses`
(all of them). The fetcher currently pins to the first entry; RFC-6555
happy-eyeballs-style failover is deferred (documented as a follow-up).

**Remaining limitations (documented, not blocking):**
- If we ever adopt a persistent Agent pool across fetches, we lose the
  per-request pin; the current design refuses this optimization.
- TLS SNI is fixed at connect time; a MITM that swaps certificates during
  the TLS handshake is out of scope for this validator (baseline PKI risk).

### Fetch limits

Env-configurable:

| Var | Default | Purpose |
|---|---|---|
| `FEED_FETCH_TIMEOUT_MS` | 30 000 | AbortController-based per-request timeout |
| `FEED_FETCH_MAX_BYTES` | 52 428 800 (50 MiB) | Streaming hard cap; canceling the reader on overrun |
| `FEED_FETCH_MAX_REDIRECTS` | 3 | Redirect hop cap (each hop re-validated for SSRF + freshly pinned) |
| `FEED_FETCH_USER_AGENT` | `FiyatUcuzFeedBot/1.0` | Identifies our fetcher to upstream operators |
| `FEED_FETCH_ALLOW_PRIVATE_ADDRESSES` | `false` | TEST-ONLY; boot fails in prod |
| `RATE_LIMIT_FEED_FETCH_MAX` | 5 | ADIM 12.1: per-client cap on `POST …/fetch`. GET endpoints unaffected. |
| `RATE_LIMIT_FEED_FETCH_TIMEWINDOW` | `1 minute` | Time window for the above; ms-friendly string. |

**Rate limit note (ADIM 12.1).** `POST …/fetch` is rate-limited via
`@fastify/rate-limit` with per-route budget. In-memory store — single-node
correct, multi-node conservative floor. Production scale-out will require
a shared limiter (Redis) alongside the existing multi-node concerns for
`@fastify/rate-limit` on auth endpoints; deferred as part of the general
rate-limit maturation sprint.

Streaming: `Response.body.getReader()` reads chunks incrementally, feeds `crypto.createHash('sha256')` for `content_hash`, and cancels the reader if the byte total exceeds `FEED_FETCH_MAX_BYTES`. The response body is NEVER materialized into a single buffer — only the first 64 KiB are retained for the XML security preflight.

### Conditional requests / 304 handling

If the feed row carries `etag` or `last_modified`, the fetcher sends `If-None-Match` / `If-Modified-Since`. A `304 Not Modified` response short-circuits: no body is read, `feed_fetches.status = 'NOT_MODIFIED'`, only the (possibly refreshed) `etag` / `Last-Modified` headers are captured. The feed's cursor still bumps `last_fetch_at` but does not touch `last_successful_fetch_at`.

### Content type gate

`Content-Type` is used as a *hint*, not a source of truth:
- `CSV` → accept `text/csv`, `application/csv`, or any `text/*`.
- `GOOGLE_MERCHANT_XML` / `CUSTOM_XML` → accept `text/xml`, `application/xml`, `application/*+xml`, or any `text/*`.
- Missing `Content-Type` is tolerated (some servers omit it).
- Anything else → `REJECTED` with `UNSUPPORTED_CONTENT_TYPE`.

Filename extension is not consulted — it lies too often to be trusted.

### XML security — stream-wide scanner (ADIM 12.1)

**No XML parser dependency is added.** The security scanner examines the
**entire** downloaded body incrementally as chunks arrive, not just a
leading window. Concretely:

- `StreamingXmlSecurityScanner` maintains a small (40-byte) trailing
  overlap buffer.
- On each chunk: decode via `TextDecoder('utf-8', { fatal: false, stream: true })`,
  prepend the previous overlap, run the substring/regex scan, then save
  the last 40 chars as the new overlap.
- Tokens that straddle a chunk boundary (`<!DOCT|YPE`) are caught by the
  overlap; total memory is O(overlap + one chunk).

Detected tokens (case-insensitive, per XML spec ASCII-only):

- `<!DOCTYPE\b` → `XML_DOCTYPE_REJECTED`
- `<!ENTITY\b` → `XML_ENTITY_REJECTED`
- `\bSYSTEM\s+["']` or `\bPUBLIC\s+["']` → `XML_EXTERNAL_REFERENCE_REJECTED`

The scan runs inside the response-body read loop, alongside the byte-cap
check and the SHA-256 hasher. Detection short-circuits the read
(`reader.cancel()`), closes the pinned Agent, and returns
`XML_SECURITY_REJECTED` — no domain body is retained.

**When a real XML parser lands** (future catalog sprint) it must
additionally be configured with entities OFF + DTD OFF + bounded
expansion + streaming (SAX). The byte-level scan then serves as
belt-and-suspenders.

**Historical limitation (closed by ADIM 12.2):** the scan decoded as UTF-8, so
a pathological feed declaring `encoding="utf-16"` and encoding the tokens as
double-byte sequences would previously evade the ASCII pattern. ADIM 12.2
closes this by enforcing a UTF-8-only policy on the response BEFORE the
security scan sees it — see §XML encoding gate below.

### XML encoding gate (ADIM 12.2)

XML feeds are **UTF-8 only** for this foundation. The gate runs on the
first ≤ 1024 bytes of the response body (`XML_ENCODING_PREFIX_MAX_BYTES`)
before any byte reaches the streaming security scanner. Nothing else in
the response is buffered for encoding purposes.

Detection layers:

1. **BOM sniff** (`detectXmlBom`) — UTF-8 (`EF BB BF`) is accepted;
   UTF-16 LE (`FF FE`), UTF-16 BE (`FE FF`), UTF-32 LE (`FF FE 00 00`),
   UTF-32 BE (`00 00 FE FF`) are rejected with `NON_UTF8_BOM`. The
   UTF-32 4-byte check runs before UTF-16 to disambiguate `FF FE …`.
2. **XML declaration `encoding="…"`** — parsed from the ASCII-safe
   portion of the prefix (`<?xml … ?>`, case-insensitive). Any value
   that is not `utf-8` / `utf8` is rejected with
   `NON_UTF8_XML_DECLARATION`. This catches `UTF-16`, `ISO-8859-*`,
   `Windows-125*`, etc.
3. **Content-Type `charset`** — extracted from the response header. If
   present and not UTF-8, rejected with `NON_UTF8_CONTENT_TYPE_CHARSET`.
4. **Cross-source conflict** — if the Content-Type charset and the XML
   declaration encoding are both present and disagree (case-insensitive,
   `utf-8` == `utf8`), rejected with `ENCODING_CONFLICT` regardless of
   individual values. This surfaces a distinct error code for
   "self-contradictory metadata" even though the strict UTF-8 rule
   would have rejected on one of the two independently.

Wire-level error code: `XML_ENCODING_REJECTED`. Rejections short-circuit
the read loop (`reader.cancel()`), close the pinned Agent, mark the
`feed_fetches` row `REJECTED` with `error_code = 'XML_ENCODING_REJECTED'`
and a one-line `error_message` that includes the subcode.

The security scanner still sees the full accepted stream: on acceptance
the buffered prefix is flushed into `StreamingXmlSecurityScanner.update`
before subsequent chunks flow through, so a late `<!DOCTYPE>` past the
prefix cap is still caught by the security scanner (proved by an
end-to-end test with 4 KiB of harmless padding preceding the token).

**Test isolation (cosmetic).** `InProcessJobQueue.awaitIdle()` is called
from `feeds-routes.test.ts` `afterEach` before `TRUNCATE`, so a
setImmediate-scheduled `feed.fetch` handler cannot race the next test's
row cleanup. This eliminated spurious `FEED_FETCH_NOT_FOUND` warnings
in the test logs — no functional change.

### Parser abstraction

`FeedParser` interface with `format`, `supports(format)`, `validate(text) → FeedValidationResult`, and `parse(text) → never`. Three implementations registered — `GoogleMerchantXmlParser`, `CustomXmlParser`, `CsvParser`. Only `validate()` does real work in this sprint (XML security scan for the XML parsers, no-op for CSV). `parse()` throws `ParserNotImplementedError` — actual domain mapping is deferred to the catalog sprint, and inventing catalog schema now would violate the prompt.

`parserFor(format)` throws `UnsupportedFeedFormatError` for unknown formats.

### JobQueue integration

Uses the existing `JobQueue` abstraction (ADR-0009). One job type: `feed.fetch` with payload `{ tenantId, feedId, fetchId }` — tenant context is explicit in the payload so the handler can open the correct `withTenantTransaction`.

`InProcessJobQueue.enqueue` changed to **fire-and-forget** (schedules the handler via `setImmediate`, returns immediately). This aligns with the abstract contract — production `BullMQ` also returns after persisting to Redis — and lets `POST …/fetch` respond `202 Accepted` without blocking on the download. A test-only `awaitIdle()` is exposed for reliable job-settlement waits.

`FeedService.performFetch(tenantId, fetchId)` is the public sync entry point used by the handler AND by tests that want to drive the fetch directly.

### Scheduling

`feeds.fetch_schedule` is a free-form `text NULL` column. Interpretation deferred to a future scheduler sprint. Reasoning: locking in a cadence semantics (fixed enum vs cron string) prematurely would either over- or under-model. `next_fetch_at` is a nullable timestamp that a future scheduler will populate; the composite index `(status, next_fetch_at)` is ready for the "give me due feeds" query when we get there.

### HTTP API

All routes require `request.user` (401 else) AND `request.tenantId` (403 else). Tenant boundary is NEVER read from the request body.

- `GET/POST /v1/merchants/:merchantId/sites/:siteId/feeds`
- `GET/PATCH /v1/merchants/:merchantId/sites/:siteId/feeds/:feedId`
- `POST /v1/merchants/:merchantId/sites/:siteId/feeds/:feedId/fetch` → **202 Accepted** + `{ fetchId, status: 'QUEUED' }`
- `GET /v1/merchants/:merchantId/sites/:siteId/feeds/:feedId/fetches`
- `GET /v1/merchants/:merchantId/sites/:siteId/feeds/:feedId/fetches/:fetchId`

Cross-tenant access surfaces as `MerchantNotFoundError` (404), matching the ADIM 11 resource-hiding convention (avoids the enumeration signal that `403` would provide).

### Error model

Bounded, wire-safe fetch error codes stored in `feed_fetches.error_code`:

- `INVALID_URL` — URL is not parseable or scheme/port not allowed.
- `SSRF_REJECTED` — resolved to a blocked IP range or hostname.
- `DNS_FAILURE` — resolver could not answer.
- `CONNECT_TIMEOUT` — TCP/TLS handshake did not complete in time.
- `READ_TIMEOUT` — response body read exceeded the timeout window.
- `TOO_MANY_REDIRECTS` — exceeded `FEED_FETCH_MAX_REDIRECTS`.
- `CONTENT_TOO_LARGE` — body exceeded `FEED_FETCH_MAX_BYTES` while streaming.
- `UNSUPPORTED_CONTENT_TYPE` — response Content-Type not acceptable for the declared format.
- `HTTP_ERROR` — non-2xx / non-3xx / 3xx-without-Location.
- `XML_ENCODING_REJECTED` — feed is not UTF-8 (BOM, XML declaration `encoding`, or Content-Type `charset` says otherwise), or Content-Type charset and XML declaration encoding disagree.
- `XML_SECURITY_REJECTED` — DOCTYPE / ENTITY / SYSTEM / PUBLIC detected in the response head.
- `FETCH_FAILED` — anything else (bucket for unclassified exceptions).

`error_message` is sanitized (whitespace collapsed, capped at 500 chars) so a chatty upstream cannot fill the DB or leak stack traces to merchant-visible responses.

## Alternatives considered

- **Store the raw feed body in `bytea` for now** — rejected: 50 MiB bodies would balloon the DB, and object storage is the correct home for raw archives.
- **Use `undici` with a custom connector to pin to the validated IP** — right long-term answer for DNS rebinding; deferred (a few dozen lines of extra code + more tests). Foundation sprint keeps to Node's built-in `fetch()`.
- **Add an XML parser now (e.g. `sax-js` / `fast-xml-parser`)** — rejected: the security requirements (entities off, DTD off, bounded expansion) can be enforced without a lib for the foundation; adding a lib pins us to its API before we've defined the catalog domain objects. Substring scan is the pragmatic choice.
- **Global cron scheduler with a full cadence enum** — over-engineered; deferred.
- **Return the fetch outcome synchronously in the HTTP response** — rejected: a huge feed download can take minutes; the HTTP request lifecycle should not be a fetch driver.

## Consequences

**Positive**
- SSRF is defended at multiple layers, tested with 15+ scenarios (localhost, private ranges, IPv6 loopback, IMDS, DNS-to-private, redirect-to-private, embedded credentials).
- Feed URL validation and per-hop redirect re-validation reduce the "trusted proxy → private target" attack class.
- XML security preflight is parser-independent — future parser choice does not create a new attack surface.
- 202-Accepted API contract is production-shaped; only the queue implementation changes when BullMQ+Redis lands.
- Every table has RLS + FORCE RLS + explicit `WHERE tenant_id = ?` in the repository — belt and suspenders.

**Negative**
- DNS rebinding TOCTOU window remains open; documented and tracked as a follow-up.
- `InProcessJobQueue` fire-and-forget behavior change is subtle — any future test that assumed synchronous enqueue must call `awaitIdle()` explicitly.
- CSV parser has no validation surface yet — a malformed CSV wastes bytes/time until the mapping sprint lands. Acceptable for foundation.

**Neutral**
- `raw_archive_ref` is stored NULL for now. Future object-storage integration is a service-layer change; schema is already correct.

## Follow-ups

- Object-storage adapter + `FeedArchive` interface.
- undici-connector-based DNS-rebinding closure.
- Scheduler worker that scans `feeds WHERE status='ACTIVE' AND next_fetch_at <= now()`.
- Real parsers wired to the catalog domain — first candidate sprint after the catalog schema lands.
- Rate-limiting on `POST …/fetch` (per feed / per tenant) — deferred to the rate-limiter sprint.
- Structured retry policy (`FAILED` → next_fetch_at + backoff) as part of the scheduler.
- Production worker split (`services/worker-feeds`) when in-process JobQueue is retired.
