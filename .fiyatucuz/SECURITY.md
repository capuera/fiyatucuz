# SECURITY

Foundation security principles. Expand and formalize as concrete threats and controls emerge.

## 1. Threat model (initial)

Primary adversaries at MVP:

- **Fraudsters** — inflating clicks/impressions to drain merchant budgets, or claiming attribution they didn't earn.
- **Competitor scrapers** — mass-scraping catalog and pricing for arbitrage or price war intelligence.
- **Compromised merchants** — reading or mutating another tenant's data.
- **Opportunistic attackers** — SQL injection, XSS, credential stuffing, session hijack, insecure direct object reference.

Deferred (not MVP): nation-state, insider ops, physical security.

## 2. Data classification

| Class                     | Examples                                         | Handling                                                     |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| **Secret**                | private keys, DB passwords, OAuth client secrets | outside repo; secret manager only                            |
| **PII**                   | user email, name, phone, address                 | encrypted at rest, minimum viable retention, tenant-isolated |
| **Merchant confidential** | wallet balance, campaign spend, feed contents    | tenant-isolated; never returned cross-tenant                 |
| **Business sensitive**    | aggregate analytics, click-through rates         | authenticated + authorized                                   |
| **Public**                | product catalog, live prices, comparison pages   | CDN-cacheable                                                |

## 3. Authentication

- Passwords hashed with **Argon2id** (id, memory ≥ 64 MB, iterations ≥ 3, parallelism ≥ 1). Never SHA-family, never bcrypt for new code.
- OAuth for consumers: **Google + Apple** OpenID Connect. Store only the subject id + minimum profile.
- Tokens:
  - Access: JWT, EdDSA (Ed25519) signed, ~10 minute TTL, includes `sub`, `tenant`, `roles[]`, `jti`.
  - Refresh: opaque random 256-bit token, DB-backed, rotated on every use, revocable per session.
- Admin accounts: TOTP MFA **mandatory**. Optional IP allowlist.
- Merchant accounts: TOTP MFA optional at MVP, mandatory when managing billing or campaigns above a threshold (TBD).
- Sessions revocable individually and per-tenant.

## 4. Authorization

- RBAC + permission model. Roles at MVP: `platform_admin`, `platform_support`, `merchant_owner`, `merchant_staff`, `consumer`.
- Permissions expressed as `resource:action` (e.g. `campaign:create`, `wallet:read`).
- **Every request** passes through a single `authorize(principal, permission, resource)` function; no ad-hoc checks scattered through handlers.
- Tenant scoping is a first-class predicate — a permission is meaningless without the tenant context it applies to.

## 5. Tenant isolation

- **Application layer (phase 1):** every repository method takes an explicit `tenantId`; tenant filter applied before any query executes. Missing filter → runtime error in dev, refused query in prod.
- **Database layer (phase 2):** Postgres RLS policies with `tenant_id = current_setting('app.tenant_id')::uuid`. Connection pool sets the tenant per transaction.
- **Never** derive tenant from client input; always from the authenticated principal.
- Cross-tenant queries (admin, reporting) are explicit, audited, and route through dedicated repository methods.

## 6. Input validation

- Zod at every trust boundary: HTTP body, query, params, headers, uploads, feed contents.
- Reject unknown fields (`.strict()`) at API boundaries. Log dropped fields for anomaly detection.
- Uploads: content-type sniffed server-side, extension not trusted, size-capped.

## 7. Output encoding

- HTML by default (React auto-escapes) — never `dangerouslySetInnerHTML` on user or merchant content without a documented sanitizer.
- JSON responses set `Content-Type: application/json; charset=utf-8`.
- CSV / Excel export escapes formula-injection characters (`=`, `+`, `-`, `@`).

## 8. Transport and headers

- HTTPS only. HSTS with preload after production launch.
- CSP: strict default-src, allowlisted script sources, no unsafe-inline. Nonces on any inline script.
- CORS: allowlisted origins only, credentials disabled by default.
- SameSite=Lax on session cookies; httpOnly on all auth cookies; Secure in all environments except local dev.

## 9. Secrets

- No secrets in git — enforced by pre-commit hook (planned) and CI scan.
- `.env.example` documents every variable; real values via secret manager (choice deferred).
- Rotate on schedule and on suspected compromise.

## 10. Dependencies

- `pnpm audit` on every CI run; high/critical fails the build.
- SBOM (CycloneDX) published per release (planned).
- Dependabot / Renovate for automated updates (planned).
- No `postinstall` scripts without review.

## 11. Logging and audit

- Structured JSON logs — never log secrets, tokens, or full PII payloads.
- Audit log for every: auth event, permission change, tenant/merchant creation, wallet mutation, campaign lifecycle event.
- Audit records immutable; append-only table; retention policy TBD.

## 12. Rate limiting and abuse

- Per-IP and per-principal rate limits on:
  - Auth endpoints (aggressive)
  - Search endpoints
  - Tracking endpoints (with a separate bot-friendly bucket)
- CAPTCHA on suspicious auth activity — provider TBD.
- Bot filtering on tracking hot path — known-bot UA list + heuristic scoring, evolvable.

## 13. Click / impression fraud

- Idempotency keys on billable events; replays never double-charge.
- Per-IP + per-session + per-token dedup windows.
- Statistical anomaly detection at rollup time; suspicious spend held pending review.

## 14. Backup and recovery

- Postgres: daily full + WAL streaming to object storage; retention TBD.
- Object storage: versioned buckets.
- Restore drills quarterly (planned).

## 15. Incident response

Not yet defined. Owner and process to be captured before production launch.

## 16. Compliance posture

- **KVKK (Turkish GDPR-equivalent)**: retention limits, data export on request, deletion on request. Must be architected in from the start, not bolted on.
- **PCI**: no card data handled by FiyatUcuz directly at MVP — all wallet top-ups via a PSP that owns PCI scope.
