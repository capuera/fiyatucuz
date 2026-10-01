---
number: 0018
title: Feed import → normalized merchant offers (identity, mapping, money, idempotency)
status: accepted
date: 2026-10-01
deciders: project owner
supersedes:
superseded-by:
---

# 0018 — Feed import and normalized merchant offers

## Context

ADIM 12–13 (ADR-0016, ADR-0017) fetch merchant feeds safely (SSRF, DNS pinning, byte cap, UTF-8 gate, streaming DOCTYPE/ENTITY scan) and archive the raw body with a SHA-256. Parsing was a deliberate placeholder (`parse(text): never`). ADIM 14 turns an archived feed into **normalized merchant offers** — a Merchant's price/availability per item — without yet building the canonical Product catalog or matching (glossary: Offer ≠ Product).

Merchant XML differs per merchant (`<product><name>` vs `<urun><urunadi>`), feeds can hold 100k+ items, and both the feed and its mapping are untrusted input.

## Decision

### Ownership

Two new tenant-scoped tables (migration `0006`), RLS + FORCE RLS, `fiyatucuz_app` CRUD / `fiyatucuz_reporting` SELECT, composite FKs so the ownership chain can never cross tenants or feeds:

- `feed_imports (fetch_id, feed_id, tenant_id) → feed_fetches (id, feed_id, tenant_id)` — an import belongs to a fetch of the same feed.
- `merchant_offers (feed_id, merchant_site_id, tenant_id) → feeds (id, merchant_site_id, tenant_id)` — an offer's site equals its feed's site.
- `merchant_offers (last_seen_import_id, feed_id, tenant_id) → feed_imports (id, feed_id, tenant_id)`.

Raw items are **not** stored (no staging table): the raw body lives in the archive (ADR-0017) and is reachable via `last_seen_import_id → fetch → raw_archive_ref`. Cross-tenant public reads are out of scope (ADR-0004 phase: later).

### Identity

Offer identity is **`UNIQUE (feed_id, external_id)`**. `external_id` comes from exactly one mapping path (`fields.externalId`, a single path — no list). An item whose identity path is empty is **rejected**; there is no automatic fallback to SKU, GTIN, URL or a content fingerprint, because a fallback lets the same product change identity between runs and duplicate.

- SKU is a merchant attribute, not identity. GTIN is normalized (GS1 check digit, zero-padded GTIN-14) and indexed as a future matching signal; it is **not unique**.
- `content_hash` (SHA-256 of the canonical normalized content) is change detection only.
- Feed-scoped (not site-scoped) identity: two feeds of one site cannot overwrite each other, and unseen-offer deactivation is well-defined per feed. Cross-feed duplicates are a matching concern.

### Mapping

`FeedItemMapping` (zod, strict): `itemElement`, `fields` (externalId, title, price, url required; salePrice, listPrice, currency, sku, gtin, brand, category, description, image, availability, stock, vatRate, vatIncluded optional), `defaultCurrency`, `decimalSeparator` (`.`/`,`/`auto`), `vatIncludedDefault`, `availabilityValues`.

Path grammar — **not XPath**: `segment ("/" segment){0,3}`, `segment = NCName[:NCName] | "@"NCName` (attribute only last), relative to the item element. First non-empty value among a field's paths wins. Paths are only compared as strings against parser events; no mapping value is ever an SQL identifier, a filesystem path, or executable code. Serialized mapping ≤ 8 KiB (DB CHECK backstop 16 KiB).

- `GOOGLE_MERCHANT_XML` → code preset (`item`, `g:id`, `g:price`, `g:sale_price`, …).
- `CUSTOM_XML` → per-feed `feeds.item_mapping` (jsonb), set via feed create/PATCH; import fails `MAPPING_REQUIRED` without it.
- `CSV` → `FORMAT_NOT_SUPPORTED` (deferred).

This amends ADR-0016 §Parser abstraction: `FeedParser.parse(text): never` is replaced by a streaming `createItemExtractor(mapping, limits, onItem)`; there is deliberately no whole-document parse.

### Streaming parse

`saxes` (strict, non-validating, no DTD processing; only the five predefined entities resolve) is the extraction layer. It **does not replace** any existing gate. Import reads the archive twice, never buffering the body:

1. archive ref must parse (ADR-0017 grammar) and name exactly the expected tenant/feed/fetch/format;
2. **pass 1** re-hashes the archive and compares to `feed_fetches.content_hash` — mismatch fails the import before any write;
3. **pass 2** runs byte cap → UTF-8 prefix gate → `StreamingXmlSecurityScanner` → fatal UTF-8 decoder → saxes, and re-hashes (detects a swap between passes). The extractor additionally rejects a DOCTYPE event.

Bounds (env, `FEED_IMPORT_*`): items per document, captured characters per field, nesting depth, elements per item, attributes per element, error samples, batch size, lease. Only mapped paths are captured.

### Price representation

Project standard (ADR-0012): `bigint` minor units + ISO-4217 `char(3)`; `Money`/`CurrencyCodeSchema` reused. Parsing is string → digits → `bigint`; JavaScript numbers never hold an amount. Supported: TRY/USD/EUR/GBP (exponent 2; aliases `TL`, `₺`, `$`, `€`, `£`). Separators: both present → last is decimal; repeated → thousands; single with 1–3 leading and exactly 3 trailing digits (`1.299`) in `auto` → **rejected as ambiguous** (never guessed); spaces/NBSP/apostrophe group thousands. Extra non-zero fraction digits are rejected, never rounded. `price_minor` = current (sale if lower); `list_price_minor` only if strictly higher.

### Normalization

Text: NFC, lone surrogates → U+FFFD, control/zero-width → space, whitespace collapsed, empty → null; lengths in code points. Required fields (identity ≤ 256, title ≤ 500, price, product URL) invalid/oversize → item rejected. Optional fields invalid → null + warning; long description/brand/category truncated + warning.

URL policies are separate:

- **product URL**: http(s), no credentials, ≤ 2048, host = site `normalized_domain` or a subdomain (suffix tricks don't match).
- **image URL**: http(s), no credentials, ≤ 2048, any host (CDNs).
- Neither is ever fetched — no new SSRF surface.

### Import state and idempotency

`feed_imports.status`: `QUEUED → PROCESSING → SUCCESS | PARTIAL | FAILED`.

- A SUCCESS fetch inserts its QUEUED import **in the same transaction** that marks the fetch SUCCESS; the `feed.import` job is enqueued after commit. `UNIQUE (fetch_id)` → at most one import per fetch.
- Claim is a conditional UPDATE setting a fresh `claim_token` + `lease_expires_at`. A partial unique index allows at most one PROCESSING import per feed. Heartbeats (per batch and on a timer) and finalization require the claim token, so a worker that lost its lease can never finalize. Expired leases are recovered in two ways, so imports cannot stay PROCESSING forever:
  - re-running the **same** import takes it over (new `claim_token`);
  - claiming **another** import of the same feed first closes, in the same transaction, any other PROCESSING import of that feed whose lease has expired → `FAILED` / `LEASE_EXPIRED` (same tenant + feed only; the predicate is re-checked on the locked row, so a live lease — e.g. one just extended by a heartbeat — is never touched).

  The expired owner keeps its token but its row is no longer PROCESSING, so its heartbeat and finalize (status + token guarded) fail and it can neither finalize nor deactivate; a FAILED import never deactivates unseen offers.
- A QUEUED import is FAILED `SUPERSEDED` if a newer import of the feed already started/completed, so the superseded import never applies its stale data. (If the newer import is still QUEUED, the older one may run first; the newer one then corrects the offers.)
- Upsert `ON CONFLICT (feed_id, external_id) DO UPDATE … WHERE last_seen_claim_token IS DISTINCT FROM excluded.last_seen_claim_token`: re-import of identical content changes no content and creates no rows; within one document the **first** occurrence of an external_id wins (later ones are rejected `DUPLICATE_EXTERNAL_ID`). Duplicate detection keys on the attempt's claim token, not the import id, so a lease takeover re-processes rows written by the crashed attempt instead of mistaking them for duplicates (its created/updated counters are then approximate).
- `content_changed_at` moves only when `content_hash` changes; `updated_at` (trigger) records any touch.

### Partial failure and deactivation

- Item-level problems → item rejected or warned; the import continues.
- Document-level problems (malformed XML, security/encoding rejection, integrity mismatch, limits, mapping missing/invalid, zero valid items) → **FAILED**. Batches already committed remain (they are valid, idempotent upserts).
- Status: no rejections → **SUCCESS**; ≥ 1 rejection (incl. duplicates) → **PARTIAL**.
- **Only SUCCESS deactivates** ACTIVE offers of the feed not seen by this import (`status = INACTIVE`, never deleted). PARTIAL and FAILED never deactivate, so a malformed item or a broken mapping cannot mass-deactivate a catalog. Deactivation and finalization commit atomically.
- Each batch is its own short tenant transaction; no transaction is open during archive I/O.

## Alternatives considered

- **Hand-written XML tokenizer** — rejected: a security-critical parser is not where we want bespoke code.
- **DOM / non-streaming parser (fast-xml-parser)** — rejected: memory ∝ feed size.
- **Site-scoped identity / automatic identity fallback / fingerprint identity** — rejected (see Identity).
- **`numeric` money** — rejected: project standard is bigint minor units.
- **Deactivate on PARTIAL** — rejected for now; a trusted reject-ratio threshold is a follow-up.
- **Staging table for raw items** — rejected for now: duplicates the archive; revisit with matching.

## Consequences

**Positive:** feeds become queryable offers with DB-enforced ownership and tenant isolation; re-imports are idempotent; malformed input degrades to PARTIAL/FAILED without catalog damage; existing fetch-time security gates also protect the import path.

**Negative / costs:** archive read twice per import; every seen offer row is written each run (`last_seen_*`), O(items) writes; `saxes` buffers one text node internally (bounded by the fetch byte cap); one PROCESSING import per feed serializes imports per feed; lease timing uses the application clock.

## Follow-ups

- Reject-ratio threshold / trusted-PARTIAL deactivation.
- CSV import.
- Canonical products + matching (GTIN first); price snapshots / history.
- Public cross-tenant offer read model (ADR-0004) and verified-site gating for publication.
- Offer read API; taxonomy mapping; image validation (no fetching today).
- Durable job queue + scheduled sweeper for expired leases (today: same-import takeover, or `LEASE_EXPIRED` recovery when the feed's next import is claimed).
