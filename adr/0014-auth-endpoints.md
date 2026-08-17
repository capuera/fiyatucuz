---
number: 0014
title: Authentication endpoints — sessions, refresh rotation, cookies, Argon2id
status: accepted
date: 2026-08-17
deciders: project owner
supersedes:
superseded-by:
---

# 0014 — Authentication endpoints

## Context

[ADR-0013](0013-identity-tenants.md) established the persistence primitives (`users`, `credentials`, `oauth_identities`, `sessions`, `refresh_tokens`, `tenants`, `tenant_users`) and the tenant-scoping model. The [ADIM-9.5 correction](0013-identity-tenants.md#authentication-bootstrap-rls-resolution-resolved-2026-08-17-migration-0003_auth_bootstrapsql) landed the `auth_bootstrap_memberships` SECURITY DEFINER helper.

This sprint (ADIM 10) delivers the HTTP surface on top: **`POST /v1/auth/{register,login,refresh,logout}`** and the middleware that decorates every subsequent request with `request.user` and (when a tenant is selected) `request.tenantId`.

## Decision

### Session model — opaque tokens, not JWT

Sessions carry an **opaque, DB-backed** token. The raw value lives only in the client cookie; the DB stores `HMAC-SHA256(rawToken, AUTH_TOKEN_HMAC_SECRET)`.

This supersedes the JWT wording in `.fiyatucuz/ARCHITECTURE.md §5` (updated as a doc-hygiene fix in this sprint). Rationale:

- `sessions.session_token_hash` (from `0002_identity_tenants.sql`) already assumes opaque tokens.
- The prompt for ADIM 10 explicitly requires `sessions.session_token_hash kullanılacak`.
- JWT-in-cookie for an app that also needs server-side revocation adds one more thing to break without adding real value — every request would still need a DB lookup to confirm the session isn't revoked, defeating the JWT-stateless argument.

### Password hashing — Argon2id via `@node-rs/argon2`

- Algorithm: **Argon2id**, memory 19 MiB, iterations 2, parallelism 1 — OWASP 2023 interactive-login guidance.
- Library: `@node-rs/argon2`. Pure Rust binding, no native C build fragility; parity with the classic `argon2` package for our needs.
- Length policy: **8..128 chars**. The 128-cap prevents Argon2id DoS via absurdly long inputs.
- The database stores only the encoded hash string. **Plaintext passwords never persist and are never logged.**
- Timing-normalizer: a module-scoped dummy hash is verified on the user-not-found login branch so response time cannot enumerate registered accounts.

### Token hashing — HMAC-SHA256 with a server-side secret

- Env var `AUTH_TOKEN_HMAC_SECRET` (required, ≥ 32 chars).
- Raw session and refresh tokens are 256-bit `crypto.randomBytes` values encoded as base64url.
- Stored form is `HMAC-SHA256(rawToken, secret)`.
- Defense in depth: a DB dump alone cannot forge or validate cookies without the secret.
- Rotation invalidates every existing session and refresh row in one shot (their stored hashes no longer match). Intentional; do it during a maintenance window.
- Comparison uses `crypto.timingSafeEqual` — but the more important protection is that lookup is by hash equality, so byte-compare timing side-channels are irrelevant.

### Refresh rotation + reuse detection

On every `POST /v1/auth/refresh`:

1. Compute HMAC of the presented raw refresh token.
2. Look up by `refresh_tokens.token_hash`.
3. If **not found** → `INVALID_REFRESH` (`not_found`).
4. If `revoked_at IS NOT NULL` → **REUSE DETECTED**. Revoke the entire session (`sessions.revoked_at`) and every one of its refresh tokens. Return `INVALID_REFRESH` (`reuse`). This is the "credential compromise" signal — a revoked token being replayed means either the attacker got the old value from the client, or the client is buggy; both warrant nuking the session.
5. If `expires_at <= now()` → `INVALID_REFRESH` (`expired`).
6. Load the session + user; reject if session revoked/expired or user not `ACTIVE`.
7. **Rotate both tokens**:
   - Update `sessions.session_token_hash` + `expires_at` + `last_seen_at` **in place** (same session id).
   - Insert a new `refresh_tokens` row.
   - Mark the old refresh row `revoked_at = now()`, `replaced_by_token_id = <new row id>`.
8. Set both cookies with the new raw values; return the updated session envelope.

Rotating the session token on each refresh (not only the refresh token) keeps the session cookie short-lived from the client's POV even when session TTL is 24h — the token that was in the client's cookie 30 minutes ago is now invalid.

### Unified authentication error surface

All failures on `POST /v1/auth/login` return **`401 INVALID_CREDENTIALS`** with an identical body. The server distinguishes internally (`no_user | bad_password | blocked_user`) for logging, but the wire response is uniform to reduce user-enumeration signal. Combined with the timing-normalizer, this closes the two obvious enumeration channels (message content + response time).

### Cookie strategy

Two cookies, both `HttpOnly` + `SameSite=Lax` + `Secure` (env-controlled, must be `true` in production over HTTPS):

- **`fu_session`** — Path `/`. Sent on every request. Consumed by the auth middleware.
- **`fu_refresh`** — Path `/v1/auth`. Restricted so it is never sent with normal API traffic — smaller blast radius if any client-side bug ever leaks it. `HttpOnly` already blocks script access; the path restriction is defense-in-depth.

Neither cookie is ever logged. Set-Cookie headers are not included in structured request logs.

### Authentication middleware

Registered as a `fastify-plugin` (so its `decorateRequest` calls escape the encapsulation scope) that runs on every request as a `preHandler`:

1. Read `fu_session` cookie.
2. If absent → leave `request.user = null`, `request.tenantId = null`; return.
3. HMAC the raw token; look up session + user in a single query with `WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > now() AND users.status = 'ACTIVE'`.
4. If no row → leave defaults.
5. Populate `request.user`.
6. Read `X-Tenant-Id` header. If absent or malformed, leave `request.tenantId = null`.
7. Call `listMembershipsForAuthenticatedUser(user.id)` (ADIM-9.5 SECURITY DEFINER helper) and check the user has an `ACTIVE` membership in the requested tenant. If yes, populate `request.tenantId`.

The middleware **never rejects** a request — it only populates. Individual routes decide whether they need `request.user` and/or `request.tenantId` and 401/400 themselves. This keeps the middleware simple and grep-visible.

Tenant-scoped repository code continues to open its own `withTenantTransaction(db, request.tenantId, …)`. The auth path does **not** introduce any new RLS bypass beyond the existing `auth_bootstrap_memberships` helper.

### OAuth foundation (Google + Apple)

- `OAuthProvider` interface: `{ name, verifyIdToken(idToken), isConfigured() }`.
- `createGoogleProvider(env)` and `createAppleProvider(env)` read their creds from env variables and expose `isConfigured()`; `verifyIdToken` throws `NotImplementedError` until the real callback flow lands in a later sprint.
- `createOAuthRegistry(env)` returns a registry with `.require('google' | 'apple')` that throws `OAuthProviderNotConfiguredError` when the env is missing.
- **No live OAuth callback route is registered.** Adding one that returns 501 would be a footgun in production; leaving the shape in place is the right foundation.
- Provider secrets come from env variables only; the code never contains a client_secret or a private key.

## Alternatives considered

- **JWT access tokens in cookies + opaque refresh** — rejected: still needs a DB round-trip to check revocation on every request, so the "stateless JWT" advantage evaporates. Opaque + HMAC gives the same security surface with simpler mental model.
- **Do not rotate the session token on refresh** — rejected: session TTL of 24h + non-rotating token means a leaked cookie is usable for the full remaining TTL. Rotating on every refresh keeps the effective window ≈ 15–60 min for an active client.
- **Return distinct login error codes** — rejected as user-enumeration signal. Log the reason server-side; return unified 401.
- **Store raw tokens in the DB** — rejected. Anyone with SELECT on `sessions` could impersonate every user without touching the client.
- **Argon2i or scrypt** — rejected. Argon2id is the current best-practice recommendation and OWASP's default.
- **Add `X-Session-Token` header as an alternative to the cookie** — rejected for this sprint. HTTP-only cookies remove a whole class of XSS-driven credential theft; a header alternative would give clients a way to bypass that. Revisit if a mobile client cannot manage cookies.

## Consequences

**Positive**
- Every refresh rotates both tokens and burns down the entire session family on reuse detection — a solid defense against stolen cookies replayed twice.
- HMAC-hashed tokens mean a DB dump alone doesn't yield working credentials.
- Unified 401 + Argon2 timing-normalizer close the two obvious login enumeration channels.
- The middleware never rejects; routes stay in control of their own auth requirements.

**Negative**
- Every authenticated request pays two DB queries (session lookup + optional membership check). Acceptable for now; a session-cache layer is a future optimization.
- `AUTH_TOKEN_HMAC_SECRET` rotation is a scheduled maintenance event — not zero-downtime.
- OAuth is scaffolded but not usable; a later sprint must land the JWKS verify + callback endpoints.

**Neutral**
- Session cookies rotate on refresh — a client with two parallel tabs can occasionally see the older cookie become invalid mid-flight. Standard mitigation is a small grace period on the old session; deferred.

## Follow-ups

- Real OAuth flows (`POST /v1/auth/callback/google`, `POST /v1/auth/callback/apple`) with JWKS verify + nonce check + link-vs-create-user logic.
- Session sweeper worker: purge rows past `expires_at + retention window` (indexes already exist on `sessions.expires_at` and `refresh_tokens.expires_at`).
- Optional session cache (Redis) to avoid the per-request DB lookup once traffic volume justifies it.
- Rate-limiting on `/register`, `/login`, `/refresh` (belongs to a separate infrastructure sprint that introduces a rate-limiter).
- Password-reset flow.
- MFA (TOTP) for merchant/admin roles per ARCHITECTURE.md §5.
- Cookie-grace-period on session rotation to close the two-tabs race.
- Move to a session-cache-friendly middleware once a Redis package exists.
