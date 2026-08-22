-- FiyatUcuz — Merchants + Merchant Sites + Site Verification (0004)
--
-- Hand-written migration. Establishes:
--   1. Enums (merchant_status, merchant_site_status,
--      merchant_site_verification_status, merchant_site_verification_method)
--   2. merchants (tenant-scoped, RLS + FORCE, per-tenant slug uniqueness,
--      composite key material for the site FK below)
--   3. merchant_sites (tenant-scoped, RLS + FORCE, composite FK on
--      (merchant_id, tenant_id) so a site cannot live in a tenant different
--      from its merchant, per-tenant normalized-domain uniqueness, and a
--      partial unique index enforcing "at most one VERIFIED row per domain
--      globally")
--   4. set_updated_at triggers on both tables
--   5. Per-role grants (fiyatucuz_app CRUD, fiyatucuz_reporting SELECT-only)
--
-- Does NOT touch previous migrations. Safe under the migrator's per-file
-- transaction wrapper — do not add BEGIN/COMMIT.
--
-- See ADR-0015 (merchants + sites) for the design rationale.

-- =========================================================================
-- 1. Enums
-- =========================================================================

DO $$ BEGIN
  CREATE TYPE merchant_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE merchant_site_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE merchant_site_verification_status
    AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE merchant_site_verification_method
    AS ENUM ('DNS_TXT', 'HTML_FILE', 'META_TAG');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================================================================
-- 2. merchants
-- =========================================================================

CREATE TABLE IF NOT EXISTS merchants (
  id             uuid            PRIMARY KEY,
  tenant_id      uuid            NOT NULL,
  name           text            NOT NULL,
  legal_name     text,
  slug           text            NOT NULL,
  status         merchant_status NOT NULL DEFAULT 'ACTIVE',
  tax_number     text,
  tax_office     text,
  country_code   char(2),
  city           text,
  website        text,
  logo_url       text,
  created_at     timestamptz     NOT NULL DEFAULT now(),
  updated_at     timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT merchants_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Slug uniqueness is PER TENANT (not global) so two tenants can each own
  -- a merchant with the same slug.
  CONSTRAINT merchants_tenant_slug_unique UNIQUE (tenant_id, slug),
  -- This UNIQUE(id, tenant_id) is what allows the composite FK on
  -- merchant_sites(merchant_id, tenant_id) to reference (id, tenant_id) and
  -- thereby forbid the "site tenant ≠ merchant tenant" mismatch at the DB
  -- level. See ADR-0015 §Ownership consistency.
  CONSTRAINT merchants_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS merchants_tenant_id_idx ON merchants (tenant_id);

DROP TRIGGER IF EXISTS merchants_set_updated_at ON merchants;
CREATE TRIGGER merchants_set_updated_at
  BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS
ALTER TABLE merchants ENABLE  ROW LEVEL SECURITY;
ALTER TABLE merchants FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchants_tenant_isolation ON merchants;
CREATE POLICY merchants_tenant_isolation ON merchants
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);

-- =========================================================================
-- 3. merchant_sites
-- =========================================================================

CREATE TABLE IF NOT EXISTS merchant_sites (
  id                          uuid                                PRIMARY KEY,
  tenant_id                   uuid                                NOT NULL,
  merchant_id                 uuid                                NOT NULL,
  name                        text                                NOT NULL,
  domain                      text                                NOT NULL,
  normalized_domain           text                                NOT NULL,
  status                      merchant_site_status                NOT NULL DEFAULT 'ACTIVE',
  logo_url                    text,
  verification_status         merchant_site_verification_status   NOT NULL DEFAULT 'UNVERIFIED',
  verification_method         merchant_site_verification_method,
  verification_token_hash     text,
  verified_at                 timestamptz,
  created_at                  timestamptz                         NOT NULL DEFAULT now(),
  updated_at                  timestamptz                         NOT NULL DEFAULT now(),
  -- Composite FK: enforces sites.tenant_id = merchants.tenant_id.
  CONSTRAINT merchant_sites_merchant_tenant_fk
    FOREIGN KEY (merchant_id, tenant_id)
    REFERENCES merchants (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT merchant_sites_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Per-tenant, no two sites can share the same normalized domain (even
  -- unverified — a tenant should not be able to register the same domain
  -- twice under two different merchants).
  CONSTRAINT merchant_sites_tenant_domain_unique UNIQUE (tenant_id, normalized_domain)
);

CREATE INDEX IF NOT EXISTS merchant_sites_tenant_id_idx   ON merchant_sites (tenant_id);
CREATE INDEX IF NOT EXISTS merchant_sites_merchant_id_idx ON merchant_sites (merchant_id);

-- Partial unique index: enforces "at most ONE row across ALL tenants can be
-- VERIFIED for a given normalized_domain". UNVERIFIED / PENDING / FAILED
-- rows can share the same domain across tenants (e.g. two tenants may both
-- be attempting to prove ownership); only one can win. See ADR-0015
-- §Verified domain uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_sites_verified_domain_unique
  ON merchant_sites (normalized_domain)
  WHERE verification_status = 'VERIFIED';

DROP TRIGGER IF EXISTS merchant_sites_set_updated_at ON merchant_sites;
CREATE TRIGGER merchant_sites_set_updated_at
  BEFORE UPDATE ON merchant_sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS
ALTER TABLE merchant_sites ENABLE  ROW LEVEL SECURITY;
ALTER TABLE merchant_sites FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchant_sites_tenant_isolation ON merchant_sites;
CREATE POLICY merchant_sites_tenant_isolation ON merchant_sites
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);

-- =========================================================================
-- 4. Grants
-- =========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON merchants       TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON merchant_sites  TO fiyatucuz_app;

GRANT SELECT ON merchants      TO fiyatucuz_reporting;
GRANT SELECT ON merchant_sites TO fiyatucuz_reporting;
