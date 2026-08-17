---
number: 0013
title: Identity + Tenants bounded contexts — first business schema
status: accepted
date: 2026-08-17
deciders: project owner
supersedes:
superseded-by:
---

# 0013 — Identity + Tenants bounded contexts

## Context

[ADR-0003](0003-modular-monolith.md) laid out ~25 bounded contexts. Every future context that persists tenant-scoped data (merchants, catalog, offers, wallet, tracking, …) joins to `tenants.id`; every context that authenticates a caller joins to `users.id`. Landing these two together prevents rework and forges the repository + RLS patterns everything downstream will reuse.

The database foundation ([ADR-0012](0012-database-foundation.md)) already exists: `packages/db` owns the connection pool, `withTenantTransaction` binds `app.tenant_id` via `set_config(..., is_local := true)`, and the `fiyatucuz_app` (RLS-enforced) and `fiyatucuz_reporting` (BYPASSRLS) roles exist from `0001_foundation.sql`.

## Decision

Ship **two modules together** (`identity`, `tenants`) via **one migration** (`0002_identity_tenants.sql`) and two `services/api/src/modules/*` folders. Nothing else in this sprint — merchants, catalog, wallet, tracking, outbox, and every other context are deferred.

### Schema

- **Global identity tables** (no RLS): `users`, `credentials`, `oauth_identities`, `sessions`, `refresh_tokens`.
- **Global tenant registry** (no RLS): `tenants`.
- **Tenant-scoped membership** (RLS enabled + forced): `tenant_users`.

### Identifier strategy

All primary keys are `uuid`. IDs are generated in **application code** via `newId()` (`packages/db/src/id.ts`), which currently returns `crypto.randomUUID()` (UUIDv4). UUIDv7 (time-ordered, index-friendly) is the target; when a native or lightweight generator is adopted, `newId()` is the single call site that changes. Storage type (`uuid`) is identical for both formats — no schema migration required.

No auto-increment integers, no sequences, no `pg_ulid` extension.

### Audit fields

Every domain table has `id`, `created_at timestamptz DEFAULT now()`, and (where a mutation timestamp is meaningful) `updated_at timestamptz DEFAULT now()`. A shared `set_updated_at()` trigger function is attached BEFORE UPDATE on `users`, `credentials`, `oauth_identities`, `tenants`, `tenant_users`. The trigger overrides application-supplied values, closing the "forgot to bump `updated_at`" bug class.

`sessions` and `refresh_tokens` intentionally omit `updated_at`:
- `sessions` has `last_seen_at` (the semantically meaningful mutable timestamp) and `revoked_at`.
- `refresh_tokens` is fundamentally three-state (active / revoked / replaced) with an explicit column per transition.

### Deletion / lifecycle

**Nothing is soft-deleted with a generic `deleted_at`.**

- `users`, `tenants`, `tenant_users`: explicit `status` enum (`ACTIVE`, `SUSPENDED`, `DEACTIVATED` / `REMOVED`). Physical deletion is not part of normal operations.
- `credentials`: no soft-delete column; if a user's local credentials should be removed (e.g. converted to OAuth-only), the row is DELETEd from `credentials`. That row's lifecycle is not the user's lifecycle.
- `sessions`, `refresh_tokens`: `revoked_at` timestamp. Cleanup of expired records is a background sweeper job (out of scope for this sprint) driven by the `expires_at` indexes.

All FKs pointing at `users`, `tenants`, or `sessions` are `ON DELETE RESTRICT` — physical deletion is blocked when history exists, forcing the caller to lifecycle the record explicitly. `refresh_tokens.replaced_by_token_id` is `ON DELETE SET NULL` so a mid-chain purge does not destroy history backwards.

### Email normalization

- `users.email` stores the original casing (for display).
- `users.email_normalized` stores `email.trim().toLowerCase()` and carries the `UNIQUE` constraint.

Only canonical lowercase — no Gmail dot-stripping, no plus-alias handling, no provider-specific rewrites. Provider-specific normalization is (a) surprising, (b) opinionated, and (c) leaks provider assumptions across the codebase.

### Credentials / sessions / tokens

- `credentials.password_hash`: opaque bytes produced by application-layer Argon2id (to be implemented when auth endpoints land). The DB never sees plaintext. `UNIQUE(user_id)` — one active credential per user.
- `sessions.session_token_hash`: HMAC/SHA of the opaque token that lives in the cookie. Raw tokens never persist. `UNIQUE(session_token_hash)`.
- `refresh_tokens.token_hash`: same treatment; `UNIQUE(token_hash)`. `replaced_by_token_id` supports reuse-detection (an app-service responsibility in a later sprint).

### OAuth identities

`(provider, provider_account_id)` is unique and authoritative. `email_at_provider` is stored for bookkeeping but is NEVER the lookup key — provider emails change and would silently orphan accounts otherwise. Initial providers: `google`, `apple`.

### Tenants + memberships

- `tenants.slug` is globally unique, URL-safe (`[a-z0-9]` with optional single hyphens, no leading/trailing hyphen, no `--`, 3–48 chars). Slug is **not** the security boundary — RLS is.
- `tenant_users`: `UNIQUE(tenant_id, user_id)`. Role changes are UPDATEs on that row, not new INSERTs.
- Initial roles: `OWNER`, `ADMIN`, `MEMBER`. Initial statuses: `ACTIVE`, `INVITED`, `SUSPENDED`, `REMOVED`.
- **"First creator becomes OWNER" is application-layer logic, not a DB constraint.** The database enforces relational integrity, not workflow.

### Row-Level Security

`tenant_users` is the first tenant-scoped table. Its policy:

```sql
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_users_isolation ON tenant_users
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);
```

**Fail-closed rationale.** The policy calls `current_setting('app.tenant_id')` without `missing_ok = true`. Failure modes:

- GUC never set in the session → `current_setting` raises `unrecognized configuration parameter` → query fails.
- GUC recognized but empty (`''` after a LOCAL revert at a previous transaction end) → `''::uuid` raises `invalid input syntax for type uuid` → query fails.
- GUC set to a UUID that does not match the row → row filtered out.
- GUC set to the row's `tenant_id` → row visible.

There is **no code path that returns tenant rows without a valid tenant context bound**. The `WITH CHECK` clause additionally prevents an authenticated caller from INSERTing or UPDATE-ing a row into a different tenant. `FORCE ROW LEVEL SECURITY` makes the policy apply even to the table owner (defensive — superuser still bypasses, but a future non-superuser owner-role would be subject to the policy).

### Global identity tables and RLS

`users`, `credentials`, `oauth_identities`, `sessions`, `refresh_tokens` are **NOT** RLS-scoped:

- A `users` row is a single global identity regardless of how many tenants the human belongs to. Users are created before any tenant relationship exists.
- Local credentials, OAuth linkages, sessions, and refresh tokens are all authentication artifacts that must be readable during the pre-tenant bootstrap of a request.

### Authentication bootstrap RLS resolution (resolved 2026-08-17, migration `0003_auth_bootstrap.sql`)

**Problem.** When a user signs in, the auth service needs to list the tenants they belong to *before* it knows which tenant they are logging into. That is a cross-tenant read of `tenant_users`, which RLS forbids to `fiyatucuz_app`.

**Three viable resolutions were on the table:**

1. **`SECURITY DEFINER` function** owned by a NOLOGIN role with `BYPASSRLS`, granted `EXECUTE` to `fiyatucuz_app`. The function's SQL body is hard-coded to filter by the caller-supplied `user_id`.
2. **Separate limited-privilege login role** with `BYPASSRLS` used only by the auth-bootstrap code path. Requires provisioning a distinct connection pool.
3. **`app.user_id` GUC + policy `OR` clause** that allows a caller to see their own memberships when tenant context is not yet set.

**Chosen: Option 1 — SECURITY DEFINER function.**

Rationale:
- Narrowest possible surface: a single named function with a hard-coded WHERE clause. Every other code path continues to hit RLS.
- No new BYPASSRLS *login* role and no second connection pool (rejects Option 2's operational cost).
- Does not touch the RLS policy itself — the `tenant_users_isolation` USING/WITH CHECK stays as-is (rejects Option 3's weakening of the "no membership access without tenant context" invariant for the general path).
- The bypass is code-reviewable and grep-visible: the SECURITY DEFINER attribute, the owner role, and the function body are all inspectable in one migration file.

**Implementation (see `packages/db/drizzle/0003_auth_bootstrap.sql`).**

Two artifacts land together:

1. A dedicated PostgreSQL role **`fiyatucuz_secdef`**: `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `BYPASSRLS`. It exists solely to own SECURITY DEFINER helper functions. It has `USAGE` on `public` and `SELECT` on `tenant_users`; nothing else. It is not the target of role membership for any application role, so `SET ROLE fiyatucuz_secdef` is reachable only by superuser.

2. A function **`public.auth_bootstrap_memberships(p_user_id uuid)`**:
   - `LANGUAGE sql` — static SQL only. No PL/pgSQL. No `EXECUTE`. No dynamic SQL is expressible.
   - `SECURITY DEFINER` — runs with `fiyatucuz_secdef`'s privileges, which is the ONLY thing that lets it bypass RLS on `tenant_users`.
   - `SET search_path = pg_catalog, pg_temp` — pins the search_path; nothing in the caller's session can shadow any identifier resolved inside the function.
   - `STABLE` — cannot mutate; planner-cacheable; the attribute is asserted by tests.
   - Body is hard-coded to `SELECT … FROM public.tenant_users WHERE user_id = p_user_id` — the fully-qualified table reference is bypass-immune to any temp/user table with the same name; the WHERE is the only filter and is not caller-overridable.
   - `REVOKE EXECUTE FROM PUBLIC; GRANT EXECUTE TO fiyatucuz_app;` — reporting is deliberately NOT granted; it has BYPASSRLS itself.

Threat model note: the caller (`fiyatucuz_app`) is trusted to pass the *authenticated* user's own id. That is the application's authentication responsibility; if the application is compromised the session already is. The function cannot leak across-user data on its own — passing user X returns only X's rows. An `app.user_id` GUC cross-check is a possible defense-in-depth addition for a later sprint.

**What this decision does NOT change:**

- `tenant_users` remains RLS-enabled and `FORCE ROW LEVEL SECURITY` stays on.
- `fiyatucuz_app` does NOT get `BYPASSRLS`.
- The `tenant_users_isolation` policy is unchanged.
- Every non-bootstrap tenant-scoped query continues to run inside `withTenantTransaction` with `app.tenant_id` bound.
- No login role with elevated privilege was introduced.

**Application surface.** The tenants module exposes `listMembershipsForUser(db, userId)` (see `services/api/src/modules/tenants/service.ts`), which is the sanctioned wrapper around the function. Application code — and specifically the auth path in ADIM 10 — must call the wrapper; direct SELECT against `tenant_users` at the pre-tenant stage will still fail closed under RLS.

**Regression coverage.** `packages/db/test/auth-bootstrap.test.ts` asserts (a) function security attributes, (b) owner is `fiyatucuz_secdef`, (c) EXECUTE grants exactly as intended, (d) function returns only rows for the passed user_id, (e) `fiyatucuz_reporting` is denied EXECUTE, and — as regression — (f) `fiyatucuz_app` still has no BYPASSRLS, (g) direct SELECT on `tenant_users` from `fiyatucuz_app` still fails without tenant context, (h) FORCE ROW LEVEL SECURITY is retained, (i) normal per-tenant isolation still filters correctly.

### Privilege model

Explicit per-table grants (no `ALTER DEFAULT PRIVILEGES`):

| Table | `fiyatucuz_app` | `fiyatucuz_reporting` |
|---|---|---|
| `users`, `credentials`, `oauth_identities`, `sessions`, `refresh_tokens`, `tenants`, `tenant_users` | `SELECT, INSERT, UPDATE, DELETE` | `SELECT` only |

No `TRUNCATE`, no `REFERENCES`, no `TRIGGER` on any table for either role.

### Module structure (`services/api/src/modules/*`)

Per ADR-0003 (modular monolith):

```
services/api/src/modules/identity/
  index.ts       # public barrel
  service.ts     # business rules (normalizeEmail, createUser, …), errors
  repository.ts  # persistence primitives; take Tx handles

services/api/src/modules/tenants/
  index.ts
  service.ts     # validateSlug, createTenant, addMember, listMembers, …
  repository.ts
```

Repository functions accept a `Tx` handle. Services take a `Db` and open the appropriate transaction (`transaction` for global tables, `withTenantTransaction` for tenant-scoped tables). Other modules import ONLY from `./index.ts` — the barrel is the enforced boundary.

## Alternatives considered

- **Sharded UUIDv7 with a real library today.** Rejected for this sprint per prompt (no new dependency); revisit when the auth sprint lands.
- **`deleted_at` soft delete on every table.** Rejected: users/tenants need explicit lifecycle status; sessions/tokens have per-purpose timestamps.
- **CASCADE deletes.** Rejected: identity + authentication history must not disappear when a user is deactivated (or accidentally hard-deleted).
- **`SET row_security = off` for reporting bypass.** Rejected — does not bypass RLS (see ADR-0012 correction of ADR-0004). Reporting role has `BYPASSRLS`.
- **One `schema.ts` for everything.** Rejected — per-context file organization (`schema/identity.ts`, `schema/tenants.ts`) tracks the modular monolith's module boundaries.

## Consequences

**Positive**
- Every future tenant-scoped module inherits a proven RLS + `withTenantTransaction` pattern from day one.
- Fail-closed by construction: no configured code path returns tenant rows without a bound context.
- Password / session / token hashing responsibility lives in the app layer where it belongs; the DB stores only opaque hashes.

**Negative**
- Auth bootstrap requires a separately-designed bypass mechanism (documented, deferred).
- All FKs are `RESTRICT`, so cleanup jobs must delete children before parents. This is intentional — makes accidental cascade destruction impossible.

**Neutral**
- The `set_updated_at` trigger is a bit of ceremony per table but removes a whole class of bugs.
- UUIDv4 today, UUIDv7 later: the schema type is identical; the change is a one-line swap in `newId()`.

## Follow-ups

- Auth-endpoints sprint (ADIM 10): implement login, register, OAuth callback, refresh-token endpoint, password-reset endpoint. Wire the auth path through the resolved `auth_bootstrap_memberships` helper (above).
- Optional defense-in-depth: `app.user_id` GUC that the SECURITY DEFINER function cross-checks against `p_user_id` before returning rows. Only worth adding once auth middleware exists to set the GUC reliably.
- Adopt UUIDv7 generator (either a small trusted library or wait for Node native support).
- Reporting-role login credentials in staging/prod (`fiyatucuz_reporting_login` GRANTs into `fiyatucuz_reporting`).
- Session sweeper worker: purges rows past `expires_at + retention window`.
- Reuse-detection logic in the refresh-token service (revoke entire chain if a supposedly-replaced token is presented).
