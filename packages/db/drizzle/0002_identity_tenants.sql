-- FiyatUcuz — Identity + Tenants (0002_identity_tenants.sql)
--
-- Hand-written migration. Establishes:
--   1. Enum types (user_status, oauth_provider, tenant_status,
--      tenant_member_role, tenant_member_status)
--   2. Global identity tables: users, credentials, oauth_identities,
--      sessions, refresh_tokens
--   3. Tenant registry: tenants
--   4. Tenant membership: tenant_users (tenant-scoped, RLS-enabled)
--   5. Shared updated_at trigger + attachment on all seven tables
--   6. RLS policy on tenant_users bound to app.tenant_id
--   7. Per-table grants for fiyatucuz_app (CRUD) and fiyatucuz_reporting
--      (SELECT only) — no blanket future-table ACLs
--
-- Idempotent: every step uses IF NOT EXISTS or DROP-then-CREATE. Safe under
-- the migrator's per-file transaction wrapping (do NOT add BEGIN / COMMIT).
--
-- See ADR-0013 for the security model and ADR-0012 for the migration
-- mechanism and role model.

-- =========================================================================
-- 1. Enum types
-- =========================================================================

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE oauth_provider AS ENUM ('google', 'apple');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tenant_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tenant_member_role AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tenant_member_status AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================================================================
-- 2. Shared updated_at trigger function
-- =========================================================================
--
-- Every table with an updated_at column attaches this trigger. Application
-- code MAY set updated_at explicitly; the trigger overrides on every UPDATE
-- so a missed application write cannot leave the field stale. Owned by the
-- migrating user (fiyatucuz in dev / a schema-owner role in ops) — EXECUTE
-- is public by default, which is fine for a pure utility.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

-- =========================================================================
-- 3. users (global identity)
-- =========================================================================

CREATE TABLE IF NOT EXISTS users (
  id                 uuid          PRIMARY KEY,
  email              text          NOT NULL,
  email_normalized   text          NOT NULL,
  display_name       text,
  status             user_status   NOT NULL DEFAULT 'ACTIVE',
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized_unique UNIQUE (email_normalized)
);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- 4. credentials (local password authentication)
-- =========================================================================
--
-- One active row per user (user_id UNIQUE). password_hash is the output of
-- application-layer Argon2id — the DB never sees plaintext. ON DELETE
-- RESTRICT because deleting a user with credentials is a red flag we want
-- the caller to handle explicitly.

CREATE TABLE IF NOT EXISTS credentials (
  id                    uuid         PRIMARY KEY,
  user_id               uuid         NOT NULL,
  password_hash         text         NOT NULL,
  password_updated_at   timestamptz  NOT NULL DEFAULT now(),
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT credentials_user_id_unique UNIQUE (user_id),
  CONSTRAINT credentials_user_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

DROP TRIGGER IF EXISTS credentials_set_updated_at ON credentials;
CREATE TRIGGER credentials_set_updated_at
  BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- 5. oauth_identities (external identity linkage)
-- =========================================================================
--
-- (provider, provider_account_id) is authoritative — provider email is
-- stored for bookkeeping but is NOT the lookup key (email changes at
-- provider must not silently orphan accounts).

CREATE TABLE IF NOT EXISTS oauth_identities (
  id                    uuid            PRIMARY KEY,
  user_id               uuid            NOT NULL,
  provider              oauth_provider  NOT NULL,
  provider_account_id   text            NOT NULL,
  email_at_provider     text,
  created_at            timestamptz     NOT NULL DEFAULT now(),
  updated_at            timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT oauth_identities_provider_account_unique
    UNIQUE (provider, provider_account_id),
  CONSTRAINT oauth_identities_user_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS oauth_identities_user_id_idx
  ON oauth_identities (user_id);

DROP TRIGGER IF EXISTS oauth_identities_set_updated_at ON oauth_identities;
CREATE TRIGGER oauth_identities_set_updated_at
  BEFORE UPDATE ON oauth_identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- 6. sessions
-- =========================================================================
--
-- session_token_hash is the HMAC/SHA of the opaque token that ships in the
-- session cookie. Raw tokens never reach the database.

CREATE TABLE IF NOT EXISTS sessions (
  id                   uuid         PRIMARY KEY,
  user_id              uuid         NOT NULL,
  session_token_hash   text         NOT NULL,
  expires_at           timestamptz  NOT NULL,
  revoked_at           timestamptz,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  last_seen_at         timestamptz  NOT NULL DEFAULT now(),
  user_agent           text,
  ip_address           inet,
  CONSTRAINT sessions_token_hash_unique UNIQUE (session_token_hash),
  CONSTRAINT sessions_user_id_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx    ON sessions (user_id);
-- Used by the (future) sweeper job that revokes/purges expired sessions.
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

DROP TRIGGER IF EXISTS sessions_set_updated_at ON sessions;
-- sessions has no updated_at (last_seen_at is the mutable timestamp);
-- deliberately not attaching set_updated_at.

-- =========================================================================
-- 7. refresh_tokens
-- =========================================================================
--
-- token_hash is the HMAC/SHA of the opaque refresh token. Raw tokens never
-- persist. replaced_by_token_id links to the token that supersedes this one
-- in a rotation chain; reuse-detection (presenting a supposedly-replaced
-- token) is an app-service responsibility in a later sprint.
--
-- Self-reference uses ON DELETE SET NULL so a mid-chain purge does not
-- destroy history backwards.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                       uuid         PRIMARY KEY,
  session_id               uuid         NOT NULL,
  token_hash               text         NOT NULL,
  expires_at               timestamptz  NOT NULL,
  revoked_at               timestamptz,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  replaced_by_token_id     uuid,
  CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_session_fk
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  CONSTRAINT refresh_tokens_replaced_by_fk
    FOREIGN KEY (replaced_by_token_id) REFERENCES refresh_tokens(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS refresh_tokens_session_id_idx ON refresh_tokens (session_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

-- refresh_tokens has no updated_at either — the row is either active, is
-- revoked (revoked_at set), or is replaced (replaced_by_token_id set).

-- =========================================================================
-- 8. tenants (global registry — NOT RLS-scoped)
-- =========================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id           uuid           PRIMARY KEY,
  name         text           NOT NULL,
  slug         text           NOT NULL,
  status       tenant_status  NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz    NOT NULL DEFAULT now(),
  updated_at   timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_unique UNIQUE (slug)
);

DROP TRIGGER IF EXISTS tenants_set_updated_at ON tenants;
CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- 9. tenant_users (tenant-scoped membership)
-- =========================================================================
--
-- First tenant-scoped table. RLS is enabled and the policy binds tenant_id
-- to the transaction-local app.tenant_id GUC established by
-- withTenantTransaction. FORCE ROW LEVEL SECURITY makes the policy apply
-- even to the table owner (defensive; superuser still bypasses).

CREATE TABLE IF NOT EXISTS tenant_users (
  id           uuid                 PRIMARY KEY,
  tenant_id    uuid                 NOT NULL,
  user_id      uuid                 NOT NULL,
  role         tenant_member_role   NOT NULL,
  status       tenant_member_status NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz          NOT NULL DEFAULT now(),
  updated_at   timestamptz          NOT NULL DEFAULT now(),
  CONSTRAINT tenant_users_tenant_user_unique UNIQUE (tenant_id, user_id),
  CONSTRAINT tenant_users_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT tenant_users_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS tenant_users_tenant_id_idx ON tenant_users (tenant_id);
CREATE INDEX IF NOT EXISTS tenant_users_user_id_idx   ON tenant_users (user_id);

DROP TRIGGER IF EXISTS tenant_users_set_updated_at ON tenant_users;
CREATE TRIGGER tenant_users_set_updated_at
  BEFORE UPDATE ON tenant_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---- RLS ----
--
-- The policy uses current_setting('app.tenant_id') WITHOUT missing_ok=true
-- so that:
--   (a) an unrecognized GUC (fresh session, never set) raises immediately
--   (b) an empty GUC ('' after a LOCAL revert) fails the ::uuid cast
--       immediately
-- Both paths are FAIL-CLOSED. There is no route that returns rows without a
-- valid tenant context bound.

ALTER TABLE tenant_users ENABLE  ROW LEVEL SECURITY;
ALTER TABLE tenant_users FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_users_isolation ON tenant_users;
CREATE POLICY tenant_users_isolation ON tenant_users
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);

-- =========================================================================
-- 10. Grants
-- =========================================================================
--
-- Explicit per-table grants only. No ALTER DEFAULT PRIVILEGES; every future
-- table receives its own grants in its own migration.

-- fiyatucuz_app — CRUD on everything it needs to serve auth + tenant
-- membership operations. No TRUNCATE, no REFERENCES, no TRIGGER.
GRANT SELECT, INSERT, UPDATE, DELETE ON users            TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON credentials      TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_identities TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions         TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens   TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants          TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_users     TO fiyatucuz_app;

-- fiyatucuz_reporting — SELECT only. BYPASSRLS is a role attribute so the
-- reporting role sees every tenant_users row across all tenants.
GRANT SELECT ON users            TO fiyatucuz_reporting;
GRANT SELECT ON credentials      TO fiyatucuz_reporting;
GRANT SELECT ON oauth_identities TO fiyatucuz_reporting;
GRANT SELECT ON sessions         TO fiyatucuz_reporting;
GRANT SELECT ON refresh_tokens   TO fiyatucuz_reporting;
GRANT SELECT ON tenants          TO fiyatucuz_reporting;
GRANT SELECT ON tenant_users     TO fiyatucuz_reporting;
