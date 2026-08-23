import { and, desc, eq, type Tx } from '@fiyatucuz/db';
import { feeds, feedFetches } from '@fiyatucuz/db/schema';

// ---------------------------------------------------------------------------
// Row / insert types derived from the Drizzle schema.
// ---------------------------------------------------------------------------

export type FeedRow = typeof feeds.$inferSelect;
export type FeedInsert = typeof feeds.$inferInsert;
export type FeedFormat = FeedRow['format'];
export type FeedStatus = FeedRow['status'];

export type FeedFetchRow = typeof feedFetches.$inferSelect;
export type FeedFetchInsert = typeof feedFetches.$inferInsert;
export type FeedFetchStatus = FeedFetchRow['status'];

// ---------------------------------------------------------------------------
// feeds
// ---------------------------------------------------------------------------
//
// All queries include an explicit `tenantId` WHERE clause — RLS is the
// security boundary but the explicit predicate keeps queries correct under
// legitimate BYPASSRLS connections (superuser in tests, reporting role
// under `withReportingTransaction`).

export async function insertFeed(tx: Tx, input: FeedInsert): Promise<FeedRow> {
  const rows = await tx.insert(feeds).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertFeed: RETURNING produced no row');
  return row;
}

export async function findFeedById(
  tx: Tx,
  tenantId: string,
  siteId: string,
  feedId: string,
): Promise<FeedRow | null> {
  const rows = await tx
    .select()
    .from(feeds)
    .where(
      and(
        eq(feeds.tenantId, tenantId),
        eq(feeds.merchantSiteId, siteId),
        eq(feeds.id, feedId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findFeedByIdForTenant(
  tx: Tx,
  tenantId: string,
  feedId: string,
): Promise<FeedRow | null> {
  // Fetch-job handler doesn't have the merchant/site context — only the
  // feedId. Site containment is still enforced by RLS + tenant scoping.
  const rows = await tx
    .select()
    .from(feeds)
    .where(and(eq(feeds.tenantId, tenantId), eq(feeds.id, feedId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listFeedsForSite(
  tx: Tx,
  tenantId: string,
  siteId: string,
): Promise<readonly FeedRow[]> {
  return tx
    .select()
    .from(feeds)
    .where(and(eq(feeds.tenantId, tenantId), eq(feeds.merchantSiteId, siteId)));
}

export async function updateFeed(
  tx: Tx,
  tenantId: string,
  siteId: string,
  feedId: string,
  patch: Partial<FeedInsert>,
): Promise<FeedRow | null> {
  const rows = await tx
    .update(feeds)
    .set(patch)
    .where(
      and(
        eq(feeds.tenantId, tenantId),
        eq(feeds.merchantSiteId, siteId),
        eq(feeds.id, feedId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Post-fetch bookkeeping. Called by the fetch job after each attempt. */
export async function updateFeedFetchCursor(
  tx: Tx,
  tenantId: string,
  feedId: string,
  patch: {
    lastFetchAt: Date;
    lastSuccessfulFetchAt?: Date;
    etag?: string | null;
    lastModified?: string | null;
    status?: FeedStatus;
  },
): Promise<void> {
  await tx
    .update(feeds)
    .set(patch)
    .where(and(eq(feeds.tenantId, tenantId), eq(feeds.id, feedId)));
}

// ---------------------------------------------------------------------------
// feed_fetches
// ---------------------------------------------------------------------------
//
// Append-only application semantics. Row insertion at QUEUED, controlled
// state transitions from the fetcher (QUEUED → FETCHING → SUCCESS |
// NOT_MODIFIED | FAILED | REJECTED). No arbitrary update surface exposed
// beyond the two functions below.

export async function insertFetch(tx: Tx, input: FeedFetchInsert): Promise<FeedFetchRow> {
  const rows = await tx.insert(feedFetches).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertFetch: RETURNING produced no row');
  return row;
}

export async function findFetchById(
  tx: Tx,
  tenantId: string,
  feedId: string,
  fetchId: string,
): Promise<FeedFetchRow | null> {
  const rows = await tx
    .select()
    .from(feedFetches)
    .where(
      and(
        eq(feedFetches.tenantId, tenantId),
        eq(feedFetches.feedId, feedId),
        eq(feedFetches.id, fetchId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findFetchByIdAcrossFeeds(
  tx: Tx,
  tenantId: string,
  fetchId: string,
): Promise<FeedFetchRow | null> {
  // Used by the job handler which only has the fetch id.
  const rows = await tx
    .select()
    .from(feedFetches)
    .where(and(eq(feedFetches.tenantId, tenantId), eq(feedFetches.id, fetchId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listFetchesForFeed(
  tx: Tx,
  tenantId: string,
  feedId: string,
  limit = 50,
): Promise<readonly FeedFetchRow[]> {
  return tx
    .select()
    .from(feedFetches)
    .where(and(eq(feedFetches.tenantId, tenantId), eq(feedFetches.feedId, feedId)))
    .orderBy(desc(feedFetches.startedAt))
    .limit(Math.max(1, Math.min(200, limit)));
}

export async function markFetchState(
  tx: Tx,
  tenantId: string,
  fetchId: string,
  patch: Partial<FeedFetchInsert>,
): Promise<FeedFetchRow | null> {
  const rows = await tx
    .update(feedFetches)
    .set(patch)
    .where(and(eq(feedFetches.tenantId, tenantId), eq(feedFetches.id, fetchId)))
    .returning();
  return rows[0] ?? null;
}
