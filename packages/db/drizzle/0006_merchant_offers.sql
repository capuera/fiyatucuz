-- FiyatUcuz — Feed Imports + Merchant Offers (0006_merchant_offers.sql)
--
-- Hand-written migration for ADIM 14. Establishes:
--   1. Enums (feed_import_status, offer_availability, offer_status)
--   2. Pre-req composite UNIQUE constraints on feeds / feed_fetches so the new
--      tables can carry composite ownership FKs
--   3. feeds.item_mapping (jsonb NULL) — per-feed CUSTOM_XML item mapping
--   4. feed_imports (tenant-scoped, RLS + FORCE, composite FKs to feeds and
--      feed_fetches; UNIQUE(fetch_id); one PROCESSING import per feed)
--   5. merchant_offers (tenant-scoped, RLS + FORCE, composite FKs to
--      merchant_sites / feeds / feed_imports; identity UNIQUE(feed_id,
--      external_id); bigint minor-unit money + ISO-4217 currency)
--   6. set_updated_at triggers on both new tables
--   7. Per-role grants: fiyatucuz_app CRUD, fiyatucuz_reporting SELECT
--
-- Does NOT touch 0001–0005. Safe under the migrator's per-file tx wrapper.
-- See ADR-0018 for the design rationale.

-- =========================================================================
-- 1. Enums
-- =========================================================================

DO $$ BEGIN
  CREATE TYPE feed_import_status AS ENUM (
    'QUEUED', 'PROCESSING', 'SUCCESS', 'PARTIAL', 'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE offer_availability AS ENUM (
    'IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'BACKORDER', 'UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE offer_status AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =========================================================================
-- 2. Pre-req composite UNIQUE constraints (forward ALTERs; 0005 untouched)
--
--    feeds (id, merchant_site_id, tenant_id)
--      → target of merchant_offers (feed_id, merchant_site_id, tenant_id):
--        an offer's site always equals its feed's site.
--    feed_fetches (id, feed_id, tenant_id)
--      → target of feed_imports (fetch_id, feed_id, tenant_id):
--        an import can only reference a fetch of its own feed.
-- =========================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'feeds_id_site_tenant_unique'
      AND conrelid = 'public.feeds'::regclass
  ) THEN
    ALTER TABLE feeds
      ADD CONSTRAINT feeds_id_site_tenant_unique UNIQUE (id, merchant_site_id, tenant_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'feed_fetches_id_feed_tenant_unique'
      AND conrelid = 'public.feed_fetches'::regclass
  ) THEN
    ALTER TABLE feed_fetches
      ADD CONSTRAINT feed_fetches_id_feed_tenant_unique UNIQUE (id, feed_id, tenant_id);
  END IF;
END $$;

-- =========================================================================
-- 3. feeds.item_mapping
--    Validated by the API before storage; interpreted only as element /
--    attribute names. Bounded size as a DB-level backstop.
-- =========================================================================

ALTER TABLE feeds ADD COLUMN IF NOT EXISTS item_mapping jsonb;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'feeds_item_mapping_shape_chk'
      AND conrelid = 'public.feeds'::regclass
  ) THEN
    ALTER TABLE feeds
      ADD CONSTRAINT feeds_item_mapping_shape_chk CHECK (
        item_mapping IS NULL
        OR (jsonb_typeof(item_mapping) = 'object'
            AND octet_length(item_mapping::text) <= 16384)
      );
  END IF;
END $$;

-- =========================================================================
-- 4. feed_imports
-- =========================================================================

CREATE TABLE IF NOT EXISTS feed_imports (
  id                  uuid                 PRIMARY KEY,
  tenant_id           uuid                 NOT NULL,
  feed_id             uuid                 NOT NULL,
  fetch_id            uuid                 NOT NULL,
  status              feed_import_status   NOT NULL DEFAULT 'QUEUED',
  claim_token         uuid,
  lease_expires_at    timestamptz,
  started_at          timestamptz,
  finished_at         timestamptz,
  items_seen          integer              NOT NULL DEFAULT 0,
  items_created       integer              NOT NULL DEFAULT 0,
  items_updated       integer              NOT NULL DEFAULT 0,
  items_unchanged     integer              NOT NULL DEFAULT 0,
  items_rejected      integer              NOT NULL DEFAULT 0,
  items_warned        integer              NOT NULL DEFAULT 0,
  items_deactivated   integer              NOT NULL DEFAULT 0,
  error_code          text,
  error_message       text,
  error_samples       jsonb                NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz          NOT NULL DEFAULT now(),
  updated_at          timestamptz          NOT NULL DEFAULT now(),

  CONSTRAINT feed_imports_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT feed_imports_feed_tenant_fk
    FOREIGN KEY (feed_id, tenant_id)
    REFERENCES feeds (id, tenant_id)
    ON DELETE RESTRICT,
  -- The fetch must belong to the same feed AND tenant.
  CONSTRAINT feed_imports_fetch_feed_tenant_fk
    FOREIGN KEY (fetch_id, feed_id, tenant_id)
    REFERENCES feed_fetches (id, feed_id, tenant_id)
    ON DELETE RESTRICT,
  -- A fetch is imported at most once (idempotency + concurrent-claim guard).
  CONSTRAINT feed_imports_fetch_unique UNIQUE (fetch_id),
  -- Enables merchant_offers (last_seen_import_id, feed_id, tenant_id) FK.
  CONSTRAINT feed_imports_id_feed_tenant_unique UNIQUE (id, feed_id, tenant_id),

  CONSTRAINT feed_imports_counters_chk CHECK (
    items_seen >= 0 AND items_created >= 0 AND items_updated >= 0
    AND items_unchanged >= 0 AND items_rejected >= 0 AND items_warned >= 0
    AND items_deactivated >= 0
  ),
  -- A PROCESSING row always has an owner and a lease.
  CONSTRAINT feed_imports_processing_owner_chk CHECK (
    status <> 'PROCESSING' OR (claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  -- Terminal rows always carry finished_at.
  CONSTRAINT feed_imports_terminal_finished_chk CHECK (
    status NOT IN ('SUCCESS', 'PARTIAL', 'FAILED') OR finished_at IS NOT NULL
  ),
  CONSTRAINT feed_imports_error_samples_chk CHECK (
    jsonb_typeof(error_samples) = 'array'
  )
);

CREATE INDEX IF NOT EXISTS feed_imports_tenant_id_idx
  ON feed_imports (tenant_id);
-- History view: WHERE feed_id = ? ORDER BY created_at DESC LIMIT ?
CREATE INDEX IF NOT EXISTS feed_imports_feed_created_at_idx
  ON feed_imports (feed_id, created_at);
-- Serializes imports per feed: at most one PROCESSING import at a time.
CREATE UNIQUE INDEX IF NOT EXISTS feed_imports_one_processing_per_feed
  ON feed_imports (feed_id)
  WHERE status = 'PROCESSING';

DROP TRIGGER IF EXISTS feed_imports_set_updated_at ON feed_imports;
CREATE TRIGGER feed_imports_set_updated_at
  BEFORE UPDATE ON feed_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS
ALTER TABLE feed_imports ENABLE  ROW LEVEL SECURITY;
ALTER TABLE feed_imports FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feed_imports_tenant_isolation ON feed_imports;
CREATE POLICY feed_imports_tenant_isolation ON feed_imports
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);

-- =========================================================================
-- 5. merchant_offers
-- =========================================================================

CREATE TABLE IF NOT EXISTS merchant_offers (
  id                    uuid                 PRIMARY KEY,
  tenant_id             uuid                 NOT NULL,
  merchant_site_id      uuid                 NOT NULL,
  feed_id               uuid                 NOT NULL,
  external_id           text                 NOT NULL,
  sku                   text,
  gtin                  text,
  title                 text                 NOT NULL,
  description           text,
  brand                 text,
  merchant_category     text,
  product_url           text                 NOT NULL,
  image_url             text,
  currency              char(3)              NOT NULL,
  price_minor           bigint               NOT NULL,
  list_price_minor      bigint,
  vat_rate_bp           integer,
  vat_included          boolean,
  availability          offer_availability   NOT NULL DEFAULT 'UNKNOWN',
  stock_quantity        integer,
  status                offer_status         NOT NULL DEFAULT 'ACTIVE',
  content_hash          text                 NOT NULL,
  content_changed_at    timestamptz          NOT NULL DEFAULT now(),
  last_seen_import_id   uuid                 NOT NULL,
  -- claim_token of the import ATTEMPT that last wrote the row. In-document
  -- duplicate detection keys on this (not the import id) so a worker that
  -- takes over an expired lease re-processes cleanly.
  last_seen_claim_token uuid                 NOT NULL,
  first_seen_at         timestamptz          NOT NULL DEFAULT now(),
  last_seen_at          timestamptz          NOT NULL DEFAULT now(),
  created_at            timestamptz          NOT NULL DEFAULT now(),
  updated_at            timestamptz          NOT NULL DEFAULT now(),

  CONSTRAINT merchant_offers_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT merchant_offers_site_tenant_fk
    FOREIGN KEY (merchant_site_id, tenant_id)
    REFERENCES merchant_sites (id, tenant_id)
    ON DELETE RESTRICT,
  -- Offer's site must equal its feed's site, within the same tenant.
  CONSTRAINT merchant_offers_feed_site_tenant_fk
    FOREIGN KEY (feed_id, merchant_site_id, tenant_id)
    REFERENCES feeds (id, merchant_site_id, tenant_id)
    ON DELETE RESTRICT,
  -- last_seen_import_id must be an import of the same feed + tenant.
  CONSTRAINT merchant_offers_last_seen_import_fk
    FOREIGN KEY (last_seen_import_id, feed_id, tenant_id)
    REFERENCES feed_imports (id, feed_id, tenant_id)
    ON DELETE RESTRICT,
  -- Identity (ADR-0018 §Identity). SKU / GTIN / content_hash are NOT identity.
  CONSTRAINT merchant_offers_feed_external_unique UNIQUE (feed_id, external_id),

  -- DB-level backstops mirroring the normalizer's bounds.
  CONSTRAINT merchant_offers_external_id_len_chk
    CHECK (char_length(external_id) BETWEEN 1 AND 256),
  CONSTRAINT merchant_offers_title_len_chk
    CHECK (char_length(title) BETWEEN 1 AND 500),
  CONSTRAINT merchant_offers_sku_len_chk
    CHECK (sku IS NULL OR char_length(sku) BETWEEN 1 AND 128),
  CONSTRAINT merchant_offers_gtin_chk
    CHECK (gtin IS NULL OR gtin ~ '^[0-9]{14}$'),
  CONSTRAINT merchant_offers_description_len_chk
    CHECK (description IS NULL OR char_length(description) <= 5000),
  CONSTRAINT merchant_offers_brand_len_chk
    CHECK (brand IS NULL OR char_length(brand) <= 200),
  CONSTRAINT merchant_offers_category_len_chk
    CHECK (merchant_category IS NULL OR char_length(merchant_category) <= 500),
  CONSTRAINT merchant_offers_product_url_chk
    CHECK (char_length(product_url) <= 2048 AND product_url ~ '^https?://'),
  CONSTRAINT merchant_offers_image_url_chk
    CHECK (image_url IS NULL OR (char_length(image_url) <= 2048 AND image_url ~ '^https?://')),
  CONSTRAINT merchant_offers_currency_chk
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT merchant_offers_price_chk
    CHECK (price_minor > 0),
  CONSTRAINT merchant_offers_list_price_chk
    CHECK (list_price_minor IS NULL OR list_price_minor > price_minor),
  CONSTRAINT merchant_offers_vat_rate_chk
    CHECK (vat_rate_bp IS NULL OR vat_rate_bp BETWEEN 0 AND 10000),
  CONSTRAINT merchant_offers_stock_chk
    CHECK (stock_quantity IS NULL OR stock_quantity >= 0),
  CONSTRAINT merchant_offers_content_hash_chk
    CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS merchant_offers_tenant_id_idx
  ON merchant_offers (tenant_id);
CREATE INDEX IF NOT EXISTS merchant_offers_merchant_site_id_idx
  ON merchant_offers (merchant_site_id);
-- Deactivation sweep: WHERE feed_id = ? AND status = 'ACTIVE' AND
-- last_seen_import_id <> ?
CREATE INDEX IF NOT EXISTS merchant_offers_feed_status_idx
  ON merchant_offers (feed_id, status);
-- Future matching signal; GTIN is deliberately NOT unique.
CREATE INDEX IF NOT EXISTS merchant_offers_gtin_idx
  ON merchant_offers (gtin)
  WHERE gtin IS NOT NULL;

DROP TRIGGER IF EXISTS merchant_offers_set_updated_at ON merchant_offers;
CREATE TRIGGER merchant_offers_set_updated_at
  BEFORE UPDATE ON merchant_offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS
ALTER TABLE merchant_offers ENABLE  ROW LEVEL SECURITY;
ALTER TABLE merchant_offers FORCE   ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchant_offers_tenant_isolation ON merchant_offers;
CREATE POLICY merchant_offers_tenant_isolation ON merchant_offers
  FOR ALL
  TO fiyatucuz_app
  USING       (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);

-- =========================================================================
-- 6. Grants
-- =========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON feed_imports     TO fiyatucuz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON merchant_offers  TO fiyatucuz_app;

GRANT SELECT ON feed_imports     TO fiyatucuz_reporting;
GRANT SELECT ON merchant_offers  TO fiyatucuz_reporting;
