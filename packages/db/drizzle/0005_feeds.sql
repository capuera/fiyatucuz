-- FiyatUcuz — Feeds + Feed Fetches (0005_feeds.sql)
--
-- Hand-written migration for ADIM 12. Establishes:
--   1. Enums (feed_format, feed_status, feed_fetch_status)
--   2. feeds (tenant-scoped, RLS + FORCE, composite FK to merchant_sites)
--   3. feed_fetches (tenant-scoped, RLS + FORCE, composite FK to feeds;
--      append-only application semantics — controlled state transitions
--      within the service, no arbitrary UPDATE/DELETE surface)
--   4. Indexes for tenant / site / status filtering, scheduler lookahead,
--      and history queries (feed_id, started_at DESC)
--   5. set_updated_at trigger on feeds (feed_fetches has no updated_at;
--      its lifecycle is expressed by status + finished_at + specific columns)
--   6. Per-role grants: fiyatucuz_app CRUD, fiyatucuz_reporting SELECT
--
-- Does NOT touch 0001–0004. Safe under the migrator's per-file tx wrapper.
-- See ADR-0016 for the design rationale.

-- =========================================================================
-- 1. Enums
-- =========================================================================

DO $$ BEGIN
  CREATE TYPE feed_format AS ENUM ('GOOGLE_MERCHANT_XML', 'CUSTOM_XML', 'CSV');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE feed_status AS ENUM ('ACTIVE', 'PAUSED', 'ERROR', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE feed_fetch_status AS ENUM (
    'QUEUED', 'FETCHING', 'SUCCESS', 'NOT_MODIFIED', 'FAILED', 'REJECTED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================================================================
-- 2. Pre-req: merchant_sites needs UNIQUE(id, tenant_id) so the composite FK
--    from feeds (merchant_site_id, tenant_id) → merchant_sites (id, tenant_id)
--    can be created. 0004 established the same pattern on `merchants` for
--    `merchant_sites` to reference; here we extend it one hop down the chain.
--    Does not alter 0004 — this is a forward ALTER TABLE added in 0005.
-- =========================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'merchant_sites_id_tenant_unique'
      AND conrelid = 'public.merchant_sites'::regclass
  ) THEN
    ALTER TABLE merchant_sites
      ADD CONSTRAINT merchant_sites_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
END $$;

-- =========================================================================
-- 3. feeds
-- =========================================================================

CREATE TABLE IF NOT EXISTS feeds (
  id                          uuid          PRIMARY KEY,
  tenant_id                   uuid          NOT NULL,
  merchant_site_id            uuid          NOT NULL,
  name                        text          NOT NULL,
  url                         text          NOT NULL,
  format                      feed_format   NOT NULL,
  status                      feed_status   NOT NULL DEFAULT 'ACTIVE',
  fetch_schedule              text,
  last_fetch_at               timestamptz,
  next_fetch_at               timestamptz,
  last_successful_fetch_at    timestamptz,
  etag                        text,
  last_modified               text,
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  updated_at                  timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT feeds_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  -- Composite FK: enforces feed.tenant_id = merchant_site.tenant_id.
  CONSTRAINT feeds_site_tenant_fk
    FOREIGN KEY (merchant_site_id, tenant_id)
    REFERENCES merchant_sites (id, tenant_id)
    ON DELETE RESTRICT,
  -- Enables the composite FK from feed_fetches (feed_id, tenant_id).
  CONSTRAINT feeds_id_tenant_unique UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS feeds_tenant_id_idx        ON feeds (tenant_id);
CREATE INDEX IF NOT EXISTS feeds_merchant_site_id_idx ON feeds (merchant_site_id);
-- Composite for a future scheduler lookahead:
--   WHERE status = 'ACTIVE' AND next_fetch_at <= now()
-- ORDER BY next_fetch_at
CREATE INDEX IF NOT EXISTS feeds_status_next_fetch_at_idx
  ON feeds (status, next_fetch_at);

DROP TRIGGER IF EXISTS feeds_set_updated_at ON feeds;
CREATE TRIGGER feeds_set_updated_at
  BEFORE UPDATE ON feeds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS
ALTER TABLE feeds ENABLE  ROW LEVEL SECURITY;
ALTER TABLE feeds FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feeds_tenant_isolation ON feeds;
CREATE POLICY feeds_tenant_isolation ON feeds
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);

-- =========================================================================
-- 3. feed_fetches
-- =========================================================================

CREATE TABLE IF NOT EXISTS feed_fetches (
  id                uuid                PRIMARY KEY,
  tenant_id         uuid                NOT NULL,
  feed_id           uuid                NOT NULL,
  started_at        timestamptz,
  finished_at       timestamptz,
  status            feed_fetch_status   NOT NULL DEFAULT 'QUEUED',
  http_status       integer,
  byte_count        bigint,
  content_type      text,
  content_hash      text,
  etag              text,
  last_modified     text,
  raw_archive_ref   text,
  error_code        text,
  error_message     text,
  created_at        timestamptz         NOT NULL DEFAULT now(),

  CONSTRAINT feed_fetches_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT feed_fetches_feed_tenant_fk
    FOREIGN KEY (feed_id, tenant_id)
    REFERENCES feeds (id, tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS feed_fetches_tenant_id_idx
  ON feed_fetches (tenant_id);
-- History view: SELECT * WHERE feed_id = ? ORDER BY started_at DESC LIMIT ?
CREATE INDEX IF NOT EXISTS feed_fetches_feed_started_at_idx
  ON feed_fetches (feed_id, started_at);
CREATE INDEX IF NOT EXISTS feed_fetches_status_idx
  ON feed_fetches (status);

-- feed_fetches deliberately has NO updated_at trigger. The row lifecycle is
-- expressed by (status, started_at, finished_at, http_status, error_*), each
-- transition set explicitly by the fetcher service.

-- RLS
ALTER TABLE feed_fetches ENABLE  ROW LEVEL SECURITY;
ALTER TABLE feed_fetches FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feed_fetches_tenant_isolation ON feed_fetches;
CREATE POLICY feed_fetches_tenant_isolation ON feed_fetches
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);

-- =========================================================================
-- 4. Grants
-- =========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON feeds         TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON feed_fetches  TO fiyatucuz_app;

GRANT SELECT ON feeds        TO fiyatucuz_reporting;
GRANT SELECT ON feed_fetches TO fiyatucuz_reporting;
