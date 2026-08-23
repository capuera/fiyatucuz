import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';
import { merchantSites } from './merchants.js';

// -- Enums --------------------------------------------------------------------

export const feedFormat = pgEnum('feed_format', [
  'GOOGLE_MERCHANT_XML',
  'CUSTOM_XML',
  'CSV',
]);

export const feedStatus = pgEnum('feed_status', [
  'ACTIVE',
  'PAUSED',
  'ERROR',
  'DISABLED',
]);

export const feedFetchStatus = pgEnum('feed_fetch_status', [
  'QUEUED',
  'FETCHING',
  'SUCCESS',
  'NOT_MODIFIED',
  'FAILED',
  'REJECTED',
]);

// -- feeds --------------------------------------------------------------------
//
// Tenant-scoped feed definition attached to a merchant_site. RLS + FORCE RLS
// (see 0005_feeds.sql). Composite FK on (merchant_site_id, tenant_id) to
// prevent the "feed in a different tenant than its site" mismatch at the DB
// level — same pattern as merchant_sites (see ADR-0015 §Ownership consistency)
// and ADR-0016 §Ownership.
//
// The URL is merchant-controlled and therefore untrusted; every fetch runs
// through the SafeFeedUrl validator (ADR-0016 §SSRF).

export const feeds = pgTable(
  'feeds',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    merchantSiteId: uuid('merchant_site_id').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    format: feedFormat('format').notNull(),
    status: feedStatus('status').notNull().default('ACTIVE'),
    // Free-form schedule string (cron-ish or null). Interpretation deferred
    // to a future scheduler sprint; keeping this loose so the schema does
    // not lock in a cadence semantics prematurely (see ADR-0016 §Scheduling).
    fetchSchedule: text('fetch_schedule'),
    lastFetchAt: timestamp('last_fetch_at', { withTimezone: true, mode: 'date' }),
    nextFetchAt: timestamp('next_fetch_at', { withTimezone: true, mode: 'date' }),
    lastSuccessfulFetchAt: timestamp('last_successful_fetch_at', {
      withTimezone: true,
      mode: 'date',
    }),
    etag: text('etag'),
    lastModified: text('last_modified'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Composite FK: sites.tenant_id must equal feed.tenant_id.
    siteTenantFk: foreignKey({
      name: 'feeds_site_tenant_fk',
      columns: [t.merchantSiteId, t.tenantId],
      foreignColumns: [merchantSites.id, merchantSites.tenantId],
    }).onDelete('restrict'),
    // Enables the composite FK from feed_fetches → feeds (id, tenant_id).
    idTenantUnique: unique('feeds_id_tenant_unique').on(t.id, t.tenantId),
    tenantIdIdx: index('feeds_tenant_id_idx').on(t.tenantId),
    merchantSiteIdIdx: index('feeds_merchant_site_id_idx').on(t.merchantSiteId),
    // Composite index tuned for the future scheduler (WHERE status='ACTIVE'
    // AND next_fetch_at <= now() ORDER BY next_fetch_at).
    statusNextFetchIdx: index('feeds_status_next_fetch_at_idx').on(t.status, t.nextFetchAt),
  }),
);

// -- feed_fetches -------------------------------------------------------------
//
// Append-only fetch history. Application semantics: rows are INSERTed once
// with status=QUEUED, then UPDATEd through a bounded state transition
// (QUEUED → FETCHING → SUCCESS | NOT_MODIFIED | FAILED | REJECTED). The
// controlled mutation is documented in ADR-0016 §Append-only semantics; no
// arbitrary UPDATE/DELETE surface is exposed to callers.
//
// raw_archive_ref is a nullable opaque pointer to future object storage.
// This sprint stores metadata only — the raw feed body is never persisted
// to the database (see ADR-0016 §Raw feed storage).

export const feedFetches = pgTable(
  'feed_fetches',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    feedId: uuid('feed_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    status: feedFetchStatus('status').notNull().default('QUEUED'),
    httpStatus: integer('http_status'),
    // Stored as bigint (int8) — feed bodies can exceed 2 GiB in theory.
    // Drizzle exposes bigint as `bigint | number`; we use mode:'number' since
    // MAX_BYTES is bounded far below Number.MAX_SAFE_INTEGER.
    byteCount: bigint('byte_count', { mode: 'number' }),
    contentType: text('content_type'),
    contentHash: text('content_hash'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    rawArchiveRef: text('raw_archive_ref'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Composite FK ensures a fetch record cannot outlive a valid feed and
    // its tenant_id always matches its feed's tenant_id.
    feedTenantFk: foreignKey({
      name: 'feed_fetches_feed_tenant_fk',
      columns: [t.feedId, t.tenantId],
      foreignColumns: [feeds.id, feeds.tenantId],
    }).onDelete('restrict'),
    tenantIdIdx: index('feed_fetches_tenant_id_idx').on(t.tenantId),
    // Fetch-history query: WHERE feed_id = ? ORDER BY started_at DESC.
    feedStartedIdx: index('feed_fetches_feed_started_at_idx').on(t.feedId, t.startedAt),
    statusIdx: index('feed_fetches_status_idx').on(t.status),
  }),
);
