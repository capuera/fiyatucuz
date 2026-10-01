import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';
import { feedFetches, feeds } from './feeds.js';
import { merchantSites } from './merchants.js';

// -- Enums --------------------------------------------------------------------

export const feedImportStatus = pgEnum('feed_import_status', [
  'QUEUED',
  'PROCESSING',
  'SUCCESS',
  'PARTIAL',
  'FAILED',
]);

export const offerAvailability = pgEnum('offer_availability', [
  'IN_STOCK',
  'OUT_OF_STOCK',
  'PREORDER',
  'BACKORDER',
  'UNKNOWN',
]);

export const offerStatus = pgEnum('offer_status', ['ACTIVE', 'INACTIVE']);

// -- feed_imports -------------------------------------------------------------
//
// One parse/normalize run over a single SUCCESS feed_fetch (ADR-0018 §Import
// state). UNIQUE(fetch_id) guarantees a fetch is imported at most once;
// the partial unique index on (feed_id) WHERE status = 'PROCESSING'
// serializes imports per feed at the DB level.
//
// State machine (all transitions are conditional UPDATEs in the service):
//   QUEUED → PROCESSING → SUCCESS | PARTIAL | FAILED
//   PROCESSING (lease expired) → PROCESSING (new claim_token, takeover)
//   QUEUED → FAILED (superseded by a newer import of the same feed)
//
// claim_token identifies the current owner; heartbeats and finalization are
// conditioned on it so a worker that lost its lease can never finalize.

export const feedImports = pgTable(
  'feed_imports',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    feedId: uuid('feed_id').notNull(),
    fetchId: uuid('fetch_id').notNull(),
    status: feedImportStatus('status').notNull().default('QUEUED'),
    claimToken: uuid('claim_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    itemsSeen: integer('items_seen').notNull().default(0),
    itemsCreated: integer('items_created').notNull().default(0),
    itemsUpdated: integer('items_updated').notNull().default(0),
    itemsUnchanged: integer('items_unchanged').notNull().default(0),
    itemsRejected: integer('items_rejected').notNull().default(0),
    itemsWarned: integer('items_warned').notNull().default(0),
    itemsDeactivated: integer('items_deactivated').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    // Bounded (FEED_IMPORT_MAX_ERROR_SAMPLES) list of
    // { index, externalId, field, code } — never raw item content.
    errorSamples: jsonb('error_samples').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    feedTenantFk: foreignKey({
      name: 'feed_imports_feed_tenant_fk',
      columns: [t.feedId, t.tenantId],
      foreignColumns: [feeds.id, feeds.tenantId],
    }).onDelete('restrict'),
    // The fetch must belong to the same feed AND tenant.
    fetchFeedTenantFk: foreignKey({
      name: 'feed_imports_fetch_feed_tenant_fk',
      columns: [t.fetchId, t.feedId, t.tenantId],
      foreignColumns: [feedFetches.id, feedFetches.feedId, feedFetches.tenantId],
    }).onDelete('restrict'),
    fetchUnique: unique('feed_imports_fetch_unique').on(t.fetchId),
    // Enables the composite FK merchant_offers.last_seen_import_id → here.
    idFeedTenantUnique: unique('feed_imports_id_feed_tenant_unique').on(
      t.id,
      t.feedId,
      t.tenantId,
    ),
    oneProcessingPerFeed: uniqueIndex('feed_imports_one_processing_per_feed')
      .on(t.feedId)
      .where(sql`status = 'PROCESSING'`),
    tenantIdIdx: index('feed_imports_tenant_id_idx').on(t.tenantId),
    feedCreatedIdx: index('feed_imports_feed_created_at_idx').on(t.feedId, t.createdAt),
  }),
);

// -- merchant_offers ----------------------------------------------------------
//
// A Merchant's normalized price/availability record for one item of one feed
// (ADR-0018). Identity is (feed_id, external_id) — SKU, GTIN and content_hash
// are NOT identity. Not linked to a canonical Product yet (matching is a later
// step). Money is bigint minor units + ISO-4217 currency (ADR-0012).
//
// Tenant-scoped with RLS + FORCE RLS (see 0006). Composite FKs pin the
// offer's tenant/site/feed/import to one consistent ownership chain.

export const merchantOffers = pgTable(
  'merchant_offers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    merchantSiteId: uuid('merchant_site_id').notNull(),
    feedId: uuid('feed_id').notNull(),
    externalId: text('external_id').notNull(),
    sku: text('sku'),
    // Normalized GTIN-14 (zero-padded, check digit verified). Not unique.
    gtin: text('gtin'),
    title: text('title').notNull(),
    description: text('description'),
    brand: text('brand'),
    merchantCategory: text('merchant_category'),
    productUrl: text('product_url').notNull(),
    imageUrl: text('image_url'),
    currency: char('currency', { length: 3 }).notNull(),
    priceMinor: bigint('price_minor', { mode: 'bigint' }).notNull(),
    listPriceMinor: bigint('list_price_minor', { mode: 'bigint' }),
    // VAT rate in basis points (20% → 2000); null when the feed omits it.
    vatRateBp: integer('vat_rate_bp'),
    vatIncluded: boolean('vat_included'),
    availability: offerAvailability('availability').notNull().default('UNKNOWN'),
    stockQuantity: integer('stock_quantity'),
    status: offerStatus('status').notNull().default('ACTIVE'),
    // SHA-256 over the canonical normalized content; change detection only.
    contentHash: text('content_hash').notNull(),
    contentChangedAt: timestamp('content_changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    lastSeenImportId: uuid('last_seen_import_id').notNull(),
    // claim_token of the import attempt that last wrote the row; keys
    // in-document duplicate detection so a lease takeover re-processes cleanly.
    lastSeenClaimToken: uuid('last_seen_claim_token').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    siteTenantFk: foreignKey({
      name: 'merchant_offers_site_tenant_fk',
      columns: [t.merchantSiteId, t.tenantId],
      foreignColumns: [merchantSites.id, merchantSites.tenantId],
    }).onDelete('restrict'),
    feedSiteTenantFk: foreignKey({
      name: 'merchant_offers_feed_site_tenant_fk',
      columns: [t.feedId, t.merchantSiteId, t.tenantId],
      foreignColumns: [feeds.id, feeds.merchantSiteId, feeds.tenantId],
    }).onDelete('restrict'),
    lastSeenImportFk: foreignKey({
      name: 'merchant_offers_last_seen_import_fk',
      columns: [t.lastSeenImportId, t.feedId, t.tenantId],
      foreignColumns: [feedImports.id, feedImports.feedId, feedImports.tenantId],
    }).onDelete('restrict'),
    feedExternalUnique: unique('merchant_offers_feed_external_unique').on(
      t.feedId,
      t.externalId,
    ),
    tenantIdIdx: index('merchant_offers_tenant_id_idx').on(t.tenantId),
    siteIdx: index('merchant_offers_merchant_site_id_idx').on(t.merchantSiteId),
    feedStatusIdx: index('merchant_offers_feed_status_idx').on(t.feedId, t.status),
    gtinIdx: index('merchant_offers_gtin_idx')
      .on(t.gtin)
      .where(sql`gtin IS NOT NULL`),
  }),
);
