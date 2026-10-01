/**
 * feed_imports persistence (ADR-0018 §Import state).
 *
 *   QUEUED ──claim──▶ PROCESSING ──finalize──▶ SUCCESS | PARTIAL | FAILED
 *      │                  │ lease expired → re-claim (new claim_token)
 *      └──supersede/precondition──▶ FAILED
 *
 * Every transition is a single conditional UPDATE; heartbeats and
 * finalization additionally require the caller's claim_token, so a worker
 * whose lease was taken over can never write a terminal state.
 */

import { and, desc, eq, sql, type Tx } from '@fiyatucuz/db';
import { feedImports } from '@fiyatucuz/db/schema';

export type FeedImportRow = typeof feedImports.$inferSelect;
export type FeedImportInsert = typeof feedImports.$inferInsert;
export type FeedImportStatus = FeedImportRow['status'];

export interface ImportCounters {
  readonly itemsSeen: number;
  readonly itemsCreated: number;
  readonly itemsUpdated: number;
  readonly itemsUnchanged: number;
  readonly itemsRejected: number;
  readonly itemsWarned: number;
}

export interface ImportErrorSample {
  readonly index: number;
  readonly externalId: string | null;
  readonly field: string;
  readonly code: string;
  readonly severity: 'rejected' | 'warning';
}

/**
 * Create the QUEUED import for a fetch. UNIQUE(fetch_id) makes this
 * idempotent: returns null when an import for the fetch already exists.
 */
export async function insertImportIfAbsent(
  tx: Tx,
  input: { id: string; tenantId: string; feedId: string; fetchId: string },
): Promise<FeedImportRow | null> {
  const rows = await tx
    .insert(feedImports)
    .values({ ...input, status: 'QUEUED' })
    .onConflictDoNothing({ target: feedImports.fetchId })
    .returning();
  return rows[0] ?? null;
}

export async function findImportById(
  tx: Tx,
  tenantId: string,
  importId: string,
): Promise<FeedImportRow | null> {
  const rows = await tx
    .select()
    .from(feedImports)
    .where(and(eq(feedImports.tenantId, tenantId), eq(feedImports.id, importId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findImportByFetchId(
  tx: Tx,
  tenantId: string,
  fetchId: string,
): Promise<FeedImportRow | null> {
  const rows = await tx
    .select()
    .from(feedImports)
    .where(and(eq(feedImports.tenantId, tenantId), eq(feedImports.fetchId, fetchId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listImportsForFeed(
  tx: Tx,
  tenantId: string,
  feedId: string,
  limit = 50,
): Promise<readonly FeedImportRow[]> {
  return tx
    .select()
    .from(feedImports)
    .where(and(eq(feedImports.tenantId, tenantId), eq(feedImports.feedId, feedId)))
    .orderBy(desc(feedImports.createdAt))
    .limit(Math.max(1, Math.min(200, limit)));
}

/**
 * True when a NEWER import of the same feed has already started or
 * completed (not FAILED) — this one must not apply stale data.
 */
export async function hasNewerActiveImport(
  tx: Tx,
  tenantId: string,
  feedId: string,
  importRow: Pick<FeedImportRow, 'id' | 'createdAt'>,
): Promise<boolean> {
  const rows = await tx
    .select({ id: feedImports.id })
    .from(feedImports)
    .where(
      and(
        eq(feedImports.tenantId, tenantId),
        eq(feedImports.feedId, feedId),
        sql`${feedImports.id} <> ${importRow.id}`,
        // Compared in SQL against the stored value (µs precision); a JS Date
        // would truncate to ms and is not serialized inside raw sql`` anyway.
        sql`${feedImports.createdAt} > (SELECT fi.created_at FROM feed_imports fi WHERE fi.id = ${importRow.id})`,
        sql`${feedImports.status} IN ('PROCESSING', 'SUCCESS', 'PARTIAL')`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Claim an import for a worker: QUEUED → PROCESSING, or take over a
 * PROCESSING row whose lease has expired. Returns null when another worker
 * holds a live claim or the row is terminal. May throw a unique violation
 * on `feed_imports_one_processing_per_feed` when a different import of the
 * same feed is PROCESSING — the caller treats that as "busy".
 */
export async function claimImport(
  tx: Tx,
  tenantId: string,
  importId: string,
  claim: { token: string; now: Date; leaseExpiresAt: Date },
): Promise<FeedImportRow | null> {
  const rows = await tx
    .update(feedImports)
    .set({
      status: 'PROCESSING',
      claimToken: claim.token,
      leaseExpiresAt: claim.leaseExpiresAt,
      // Raw sql`` params bypass Drizzle's Date mapping: pass ISO + explicit cast.
      startedAt: sql`COALESCE(${feedImports.startedAt}, ${claim.now.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(feedImports.tenantId, tenantId),
        eq(feedImports.id, importId),
        sql`(${feedImports.status} = 'QUEUED' OR (${feedImports.status} = 'PROCESSING' AND ${feedImports.leaseExpiresAt} < ${claim.now.toISOString()}::timestamptz))`,
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Close OTHER imports of the same feed whose worker lease has expired:
 * PROCESSING → FAILED / LEASE_EXPIRED (ADR-0018 §Import state). Runs in the
 * claiming transaction just before `claimImport`, so a crashed worker can no
 * longer block the feed's later imports through the one-PROCESSING-per-feed
 * index.
 *
 * Safety:
 *   - only this tenant + feed, only PROCESSING, only `lease_expires_at < now`
 *     — a live lease is never touched; the UPDATE re-checks the predicate on
 *     the locked row, so a heartbeat that extended the lease first wins;
 *   - the expired owner keeps its claim_token but the row is no longer
 *     PROCESSING, so its heartbeat / finalize (status + token guarded) fail
 *     and it can never finalize or deactivate;
 *   - `excludeImportId` (the import being claimed) keeps same-import lease
 *     takeover semantics unchanged.
 *   - FAILED never deactivates; batches the dead worker committed stay
 *     (idempotent upserts).
 */
export async function expireStaleProcessingImports(
  tx: Tx,
  tenantId: string,
  feedId: string,
  excludeImportId: string,
  now: Date,
): Promise<number> {
  const rows = await tx
    .update(feedImports)
    .set({
      status: 'FAILED',
      errorCode: 'LEASE_EXPIRED',
      errorMessage: 'worker lease expired before the import finished',
      finishedAt: now,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(feedImports.tenantId, tenantId),
        eq(feedImports.feedId, feedId),
        eq(feedImports.status, 'PROCESSING'),
        sql`${feedImports.id} <> ${excludeImportId}`,
        // Raw sql`` params bypass Drizzle's Date mapping: pass ISO + explicit cast.
        sql`${feedImports.leaseExpiresAt} < ${now.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: feedImports.id });
  return rows.length;
}

/** Extend the lease and publish progress; false when the claim was lost. */
export async function heartbeatImport(
  tx: Tx,
  tenantId: string,
  importId: string,
  token: string,
  leaseExpiresAt: Date,
  counters: ImportCounters,
): Promise<boolean> {
  const rows = await tx
    .update(feedImports)
    .set({ leaseExpiresAt, ...counters })
    .where(
      and(
        eq(feedImports.tenantId, tenantId),
        eq(feedImports.id, importId),
        eq(feedImports.status, 'PROCESSING'),
        eq(feedImports.claimToken, token),
      ),
    )
    .returning({ id: feedImports.id });
  return rows.length > 0;
}

/** PROCESSING → terminal, only for the current claim owner. */
export async function finalizeImport(
  tx: Tx,
  tenantId: string,
  importId: string,
  token: string,
  patch: {
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
    finishedAt: Date;
    counters: ImportCounters;
    itemsDeactivated: number;
    errorCode: string | null;
    errorMessage: string | null;
    errorSamples: readonly ImportErrorSample[];
  },
): Promise<FeedImportRow | null> {
  const rows = await tx
    .update(feedImports)
    .set({
      status: patch.status,
      finishedAt: patch.finishedAt,
      ...patch.counters,
      itemsDeactivated: patch.itemsDeactivated,
      errorCode: patch.errorCode,
      errorMessage: patch.errorMessage,
      errorSamples: [...patch.errorSamples],
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(feedImports.tenantId, tenantId),
        eq(feedImports.id, importId),
        eq(feedImports.status, 'PROCESSING'),
        eq(feedImports.claimToken, token),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** QUEUED → FAILED for imports that can never run (superseded, bad fetch). */
export async function failQueuedImport(
  tx: Tx,
  tenantId: string,
  importId: string,
  errorCode: string,
  errorMessage: string,
  finishedAt: Date,
): Promise<FeedImportRow | null> {
  const rows = await tx
    .update(feedImports)
    .set({ status: 'FAILED', errorCode, errorMessage, finishedAt })
    .where(
      and(
        eq(feedImports.tenantId, tenantId),
        eq(feedImports.id, importId),
        eq(feedImports.status, 'QUEUED'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
