---
number: 0015
title: Merchants + Merchant Sites + Site verification foundation
status: accepted
date: 2026-08-21
deciders: project owner
supersedes:
superseded-by:
---

# 0015 — Merchants + Merchant Sites + Site verification foundation

## Context

The tenants layer is in place ([ADR-0013](0013-identity-tenants.md)) and the auth surface is wired end-to-end ([ADR-0014](0014-auth-endpoints.md), [ADIM 10.1 hardening](0014-auth-endpoints.md)). The next real business surface is the **merchant + merchant-site** foundation that every downstream context (product feeds, catalog, offers, campaigns, tracking) will join to.

A tenant can own **many merchants** (a holding company with multiple brands, an agency managing several clients). A merchant owns **many merchant sites** (a webshop can operate on `www.example.com` and `example.com.tr`; a chain can have per-region domains).

This sprint lands persistence + a service layer + tenant-scoped HTTP routes + site-verification challenge issuance. It deliberately does NOT implement the DNS/HTTP fetcher that would confirm ownership from the internet side; that lives in a future worker sprint.

## Decision

### Ownership shape

```
User → Tenant → Merchant → MerchantSite
```

- `merchants` — tenant-scoped, RLS + FORCE RLS.
- `merchant_sites` — tenant-scoped, RLS + FORCE RLS, additionally constrained so `site.tenant_id = merchant.tenant_id` at the DB level (see §Ownership consistency).

### Ownership consistency (DB-level, not application-level)

`merchant_sites.tenant_id` must match its `merchants.tenant_id`. Two mechanisms alone would be brittle:

- Application code alone — a bug or a forgotten check silently produces mismatched rows.
- FK to `merchants(id)` alone — nothing constrains `tenant_id`.

The DB-level solution:

```sql
-- merchants
CONSTRAINT merchants_id_tenant_unique UNIQUE (id, tenant_id)

-- merchant_sites
CONSTRAINT merchant_sites_merchant_tenant_fk
  FOREIGN KEY (merchant_id, tenant_id)
  REFERENCES merchants (id, tenant_id)
  ON DELETE RESTRICT
```

`UNIQUE(id, tenant_id)` on `merchants` allows the composite FK to reference `(id, tenant_id)`. The composite FK then makes it structurally impossible to insert a site whose `tenant_id` differs from the referenced merchant's `tenant_id` — the row would fail FK validation, not RLS.

This is defense-in-depth on top of the RLS `WITH CHECK` clause that also prevents cross-tenant writes.

### Domain normalization

Handled at the service boundary by `normalizeDomain(input)` in the merchants module (`validation.ts`). Rules in order:

1. Trim whitespace.
2. Parse via WHATWG `URL` (prepend `https://` if scheme absent). This gives us Punycode + lowercase for IDNs (`türk.example` → `xn--trk-goa.example`).
3. Reject any URL component that is not the bare host: userinfo, port, path (other than `/`), query, fragment.
4. Reject bare IPv4, IPv6, `localhost`, and hosts without a TLD.
5. **Strip a single leading `www.`** — documented and tested. Non-`www` subdomains are preserved intact (`shop.example.com` stays `shop.example.com`).

**Why strip `www.`?** End users treat `www.example.com` and `example.com` as the same site. Forcing two separate registrations + two separate verifications adds no security value and generates support tickets. Google Search Console, Ahrefs, and every mainstream site-verification service treat them as equivalent. Only the leading label is stripped — `sub.www.example.com` is left alone (though such a hostname would be highly unusual in the wild).

**Rejected alternatives:**
- Don't strip `www.` — literalist but leaks confusing "you already verified example.com; go verify www.example.com" flows.
- Strip more subdomain aliases (`m.`, `mobile.`) — provider-specific, opinionated, hard to reverse. Never doing.

### Verified-domain uniqueness (cross-tenant)

Per-tenant uniqueness alone is not enough: once **verified**, the same domain must not be claimable by a second tenant. Otherwise Tenant A verifies `example.com`, Tenant B later verifies `example.com` too, and we have two conflicting claims on one internet identity.

**Chosen:** PostgreSQL **partial unique index**:

```sql
CREATE UNIQUE INDEX merchant_sites_verified_domain_unique
  ON merchant_sites (normalized_domain)
  WHERE verification_status = 'VERIFIED';
```

Semantics:
- Multiple UNVERIFIED / PENDING / FAILED rows can share a domain across tenants (two tenants may both be trying to prove ownership; only one can win).
- The transition to VERIFIED atomically checks the partial index. If another row is already VERIFIED for that domain, the UPDATE fails with SQLSTATE 23505 and the service raises `MerchantSiteDomainAlreadyVerifiedElsewhereError` (HTTP 409).

**Race safety:** two concurrent finalizations serialise on the unique index; exactly one succeeds. No application-level lock required.

**Rejected alternatives:**
- App-layer check + insert — inherently race-prone.
- Global UNIQUE on `normalized_domain` — forbids even unverified duplicates, which breaks the legitimate "two prospects considering the same domain" flow before either has proven ownership.
- Separate `verified_site_domains` registry table — extra join surface for no benefit; the partial index gives us the same guarantee inside the primary table.

### Site verification token storage

Verification-challenge tokens are treated as opaque high-entropy secrets, hashed with the **same HMAC secret as auth tokens** (`AUTH_TOKEN_HMAC_SECRET`, ADR-0014):

- On challenge creation: generate 32-byte random via `crypto.randomBytes` → base64url raw token → HMAC-SHA256 hash → store hash in `merchant_sites.verification_token_hash`.
- **Return the raw token exactly once** — in the response of `POST /v1/merchants/:merchantId/sites/:siteId/verification`.
- Never persist raw. Never log raw. `LOG_REDACTION_PATHS` includes `*.verificationToken`, `*.verification_token`, `*.verificationTokenHash`, `*.verification_token_hash`.

**Why share the auth HMAC secret?** Rotating a second secret in lock-step with sessions is operationally worse than sharing one. The blast radius on secret compromise is bounded regardless: an attacker with the secret can forge session cookies (already game-over), and can validate a stolen verification hash (much less severe — verification tokens are published to public DNS/HTTP once the challenge is created).

**Rotation impact:** rotating `AUTH_TOKEN_HMAC_SECRET` invalidates every pending verification challenge (their stored hashes no longer match). Documented as expected behavior; callers must reissue.

### Verification state machine

```
UNVERIFIED
    │  POST /verification (create challenge)
    ▼
 PENDING ──── presented token matches ──→ VERIFIED
    │
    └── presented token mismatch ──→ FAILED
                                       │
                                       │  POST /verification again
                                       ▼
                                    PENDING
```

`finalizeSiteVerification(tenantId, merchantId, siteId, rawToken)` compares the HMAC of the presented raw token against the stored hash. Match → VERIFIED + `verified_at = now()`. Mismatch → FAILED (token hash left in place so a retry with the correct token still works). If another tenant already verified this domain → `MerchantSiteDomainAlreadyVerifiedElsewhereError` (409).

**External DNS/HTTP fetching is out of scope for this sprint.** A future worker sprint will pull DNS TXT records / fetch `/.well-known/fiyatucuz-challenge/*.txt` / parse HTML meta tags, and call `finalizeSiteVerification` on success. No abstraction interface is introduced here — YAGNI until the worker actually exists.

### RLS

Both `merchants` and `merchant_sites`:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;

CREATE POLICY <t>_tenant_isolation ON <t>
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);
```

Fail-closed on missing `app.tenant_id` — `current_setting(...)` without `missing_ok` raises rather than returns NULL. Same pattern as `tenant_users` (ADR-0013 §RLS).

### Grants

| Table | `fiyatucuz_app` | `fiyatucuz_reporting` |
|---|---|---|
| `merchants` | `SELECT, INSERT, UPDATE, DELETE` | `SELECT` |
| `merchant_sites` | `SELECT, INSERT, UPDATE, DELETE` | `SELECT` |

No TRUNCATE / REFERENCES / TRIGGER for either role. `fiyatucuz_reporting` retains `BYPASSRLS` (ADR-0012) so cross-tenant analytics reads work; `fiyatucuz_app` still has no BYPASSRLS.

### Response envelope

Route responses map DB rows to a wire envelope that **strips `verification_token_hash`** — the hash is a server-side secret and should never appear over the wire even to the owning tenant. The raw verification token is only ever returned by the challenge-creation endpoint.

### HTTP routes

All routes under `/v1/merchants` require `request.user` (401 if missing) AND `request.tenantId` (403 if missing). The auth middleware from ADR-0014 populates both.

- `GET    /v1/merchants` — list merchants for the bound tenant.
- `POST   /v1/merchants` — create merchant.
- `GET    /v1/merchants/:merchantId` — fetch merchant.
- `PATCH  /v1/merchants/:merchantId` — partial update.
- `GET    /v1/merchants/:merchantId/sites` — list sites for merchant.
- `POST   /v1/merchants/:merchantId/sites` — create site.
- `GET    /v1/merchants/:merchantId/sites/:siteId` — fetch site.
- `PATCH  /v1/merchants/:merchantId/sites/:siteId` — partial update.
- `POST   /v1/merchants/:merchantId/sites/:siteId/verification` — issue new challenge (returns raw token once).

Tenant boundary is `request.tenantId`, not the request body. Route handlers NEVER accept `tenant_id` from a client-supplied payload; the middleware-populated value is authoritative.

## Alternatives considered

- **Slug globally unique** — rejected; two tenants must be able to have a merchant named `flagship-store`.
- **App-layer verified-domain uniqueness** — rejected; not race-safe.
- **Separate table for verification challenges** — adds join surface + a second row lifecycle; the "one active challenge per site" invariant is naturally expressed as fields on `merchant_sites`.
- **Rotate `AUTH_TOKEN_HMAC_SECRET` never** — noted, but this document does not decide secret-rotation cadence.

## Consequences

**Positive**
- Composite FK makes "site in wrong tenant" impossible at the DB level; no bug can silently create such a row.
- Partial unique index makes "same domain verified twice" impossible; race-safe.
- Site verification foundation is small (~100 lines of service) and shares the auth HMAC primitive.
- Every route is defended by both RLS + `WHERE tenant_id = ?` — belt and suspenders.

**Negative**
- Two BYPASSRLS roles remain in the cluster (`fiyatucuz_reporting`, `fiyatucuz_secdef`); this sprint adds no new bypass surface but doesn't reduce the existing one either.
- Composite FK adds a small write overhead vs a single-column FK; unmeasurable at this scale.
- Rotating `AUTH_TOKEN_HMAC_SECRET` invalidates pending site challenges as well as sessions — documented; expected during a maintenance window.

**Neutral**
- Verification workflow currently requires an operator or worker to call `finalizeSiteVerification` explicitly. The public HTTP surface exposes challenge creation only; finalization is service-internal until the DNS/HTTP fetcher worker lands.

## Follow-ups

- Worker sprint: DNS TXT record / HTTP file / meta-tag verifier that periodically polls PENDING sites and calls `finalizeSiteVerification`.
- Site status admin actions (suspend / deactivate) exposed via the merchant panel.
- Merchant ↔ user membership scoping — currently every user in a tenant sees every merchant. When merchants get access-controlled per user, add a `merchant_users` link table with its own RLS/policy.
- XML product-feed ingestion, catalog matching, and offers all pivot on `merchant_sites.id` — schema is designed so those tables can FK to `merchant_sites (id, tenant_id)` and inherit the tenant-consistency guarantee.
