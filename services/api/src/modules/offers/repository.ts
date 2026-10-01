import { and, asc, eq, inArray, sql, type Tx } from '@fiyatucuz/db';
import { merchantOffers } from '@fiyatucuz/db/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MerchantOfferRow = typeof merchantOffers.$inferSelect;
export type MerchantOfferInsert = typeof merchantOffers.$inferInsert;
export type OfferStatus = MerchantOfferRow['status'];

export interface ExistingOfferState {
  readonly contentHash: string;
  readonly lastSeenClaimToken: string;
}

// ---------------------------------------------------------------------------
// Queries — every call takes tenantId explicitly (ADR-0004) and runs inside
// withTenantTransaction so RLS applies as well.
// ---------------------------------------------------------------------------

/** Current hash + last import for the given identities of one feed. */
export async function findExistingByExternalIds(
  tx: Tx,
  tenantId: string,
  feedId: string,
  externalIds: readonly string[],
): Promise<Map<string, ExistingOfferState>> {
  const out = new Map<string, ExistingOfferState>();
  if (externalIds.length === 0) return out;
  const rows = await tx
    .select({
      externalId: merchantOffers.externalId,
      contentHash: merchantOffers.contentHash,
      lastSeenClaimToken: merchantOffers.lastSeenClaimToken,
    })
    .from(merchantOffers)
    .where(
      and(
        eq(merchantOffers.tenantId, tenantId),
        eq(merchantOffers.feedId, feedId),
        inArray(merchantOffers.externalId, [...externalIds]),
      ),
    );
  for (const r of rows) {
    out.set(r.externalId, { contentHash: r.contentHash, lastSeenClaimToken: r.lastSeenClaimToken });
  }
  return out;
}

/**
 * Idempotent batch upsert keyed by (feed_id, external_id).
 *
 * - New identity → INSERT.
 * - Existing identity → content columns refreshed, status back to ACTIVE,
 *   last_seen_* advanced; content_changed_at moves only when content_hash
 *   actually changed.
 * - `setWhere` skips rows already written by THIS import attempt (same
 *   claim token), so a duplicate external_id later in the same document can
 *   never overwrite the first occurrence (first wins), even across batches.
 *   A lease takeover uses a new token and therefore re-writes normally.
 *
 * Callers must not pass two rows with the same external_id in one call.
 * Returns the number of rows inserted or updated.
 */
export async function upsertOffers(tx: Tx, rows: readonly MerchantOfferInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await tx
    .insert(merchantOffers)
    .values([...rows])
    .onConflictDoUpdate({
      target: [merchantOffers.feedId, merchantOffers.externalId],
      set: {
        sku: sql`excluded.sku`,
        gtin: sql`excluded.gtin`,
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        brand: sql`excluded.brand`,
        merchantCategory: sql`excluded.merchant_category`,
        productUrl: sql`excluded.product_url`,
        imageUrl: sql`excluded.image_url`,
        currency: sql`excluded.currency`,
        priceMinor: sql`excluded.price_minor`,
        listPriceMinor: sql`excluded.list_price_minor`,
        vatRateBp: sql`excluded.vat_rate_bp`,
        vatIncluded: sql`excluded.vat_included`,
        availability: sql`excluded.availability`,
        stockQuantity: sql`excluded.stock_quantity`,
        status: sql`'ACTIVE'::offer_status`,
        contentChangedAt: sql`CASE WHEN ${merchantOffers.contentHash} IS DISTINCT FROM excluded.content_hash THEN excluded.last_seen_at ELSE ${merchantOffers.contentChangedAt} END`,
        contentHash: sql`excluded.content_hash`,
        lastSeenImportId: sql`excluded.last_seen_import_id`,
        lastSeenClaimToken: sql`excluded.last_seen_claim_token`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
      setWhere: sql`${merchantOffers.lastSeenClaimToken} IS DISTINCT FROM excluded.last_seen_claim_token`,
    })
    .returning({ id: merchantOffers.id });
  return result.length;
}

/**
 * Mark ACTIVE offers of a feed that the given import did not see as
 * INACTIVE. Only ever called for a SUCCESS import (ADR-0018 §Deactivation).
 */
export async function deactivateUnseenOffers(
  tx: Tx,
  tenantId: string,
  feedId: string,
  importId: string,
): Promise<number> {
  const rows = await tx
    .update(merchantOffers)
    .set({ status: 'INACTIVE' })
    .where(
      and(
        eq(merchantOffers.tenantId, tenantId),
        eq(merchantOffers.feedId, feedId),
        eq(merchantOffers.status, 'ACTIVE'),
        sql`${merchantOffers.lastSeenImportId} <> ${importId}`,
      ),
    )
    .returning({ id: merchantOffers.id });
  return rows.length;
}

export async function listOffersForFeed(
  tx: Tx,
  tenantId: string,
  feedId: string,
  limit = 100,
): Promise<readonly MerchantOfferRow[]> {
  return tx
    .select()
    .from(merchantOffers)
    .where(and(eq(merchantOffers.tenantId, tenantId), eq(merchantOffers.feedId, feedId)))
    .orderBy(asc(merchantOffers.externalId))
    .limit(Math.max(1, Math.min(1000, limit)));
}

export async function findOfferByExternalId(
  tx: Tx,
  tenantId: string,
  feedId: string,
  externalId: string,
): Promise<MerchantOfferRow | null> {
  const rows = await tx
    .select()
    .from(merchantOffers)
    .where(
      and(
        eq(merchantOffers.tenantId, tenantId),
        eq(merchantOffers.feedId, feedId),
        eq(merchantOffers.externalId, externalId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
