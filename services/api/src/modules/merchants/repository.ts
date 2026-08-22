import { and, eq, type Tx } from '@fiyatucuz/db';
import { merchants, merchantSites } from '@fiyatucuz/db/schema';

// ---------------------------------------------------------------------------
// Types (derived from the Drizzle schema)
// ---------------------------------------------------------------------------

export type MerchantRow = typeof merchants.$inferSelect;
export type MerchantInsert = typeof merchants.$inferInsert;

export type MerchantSiteRow = typeof merchantSites.$inferSelect;
export type MerchantSiteInsert = typeof merchantSites.$inferInsert;

// ---------------------------------------------------------------------------
// merchants
// ---------------------------------------------------------------------------
//
// All operations require the tx to have been opened inside
// withTenantTransaction (app.tenant_id bound). RLS is the security boundary;
// the explicit WHERE tenant_id = ? is the query semantic (and keeps the
// function correct under connections that legitimately bypass RLS, e.g.
// superuser in tests).

export async function insertMerchant(tx: Tx, input: MerchantInsert): Promise<MerchantRow> {
  const rows = await tx.insert(merchants).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertMerchant: RETURNING produced no row');
  return row;
}

export async function findMerchantById(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<MerchantRow | null> {
  const rows = await tx
    .select()
    .from(merchants)
    .where(and(eq(merchants.tenantId, tenantId), eq(merchants.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findMerchantBySlug(
  tx: Tx,
  tenantId: string,
  slug: string,
): Promise<MerchantRow | null> {
  const rows = await tx
    .select()
    .from(merchants)
    .where(and(eq(merchants.tenantId, tenantId), eq(merchants.slug, slug)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMerchantsForTenant(
  tx: Tx,
  tenantId: string,
): Promise<readonly MerchantRow[]> {
  return tx.select().from(merchants).where(eq(merchants.tenantId, tenantId));
}

export async function updateMerchant(
  tx: Tx,
  tenantId: string,
  id: string,
  patch: Partial<MerchantInsert>,
): Promise<MerchantRow | null> {
  const rows = await tx
    .update(merchants)
    .set(patch)
    .where(and(eq(merchants.tenantId, tenantId), eq(merchants.id, id)))
    .returning();
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// merchant_sites
// ---------------------------------------------------------------------------

export async function insertMerchantSite(
  tx: Tx,
  input: MerchantSiteInsert,
): Promise<MerchantSiteRow> {
  const rows = await tx.insert(merchantSites).values(input).returning();
  const row = rows[0];
  if (!row) throw new Error('insertMerchantSite: RETURNING produced no row');
  return row;
}

export async function findMerchantSiteById(
  tx: Tx,
  tenantId: string,
  merchantId: string,
  siteId: string,
): Promise<MerchantSiteRow | null> {
  const rows = await tx
    .select()
    .from(merchantSites)
    .where(
      and(
        eq(merchantSites.tenantId, tenantId),
        eq(merchantSites.merchantId, merchantId),
        eq(merchantSites.id, siteId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listMerchantSitesForMerchant(
  tx: Tx,
  tenantId: string,
  merchantId: string,
): Promise<readonly MerchantSiteRow[]> {
  return tx
    .select()
    .from(merchantSites)
    .where(and(eq(merchantSites.tenantId, tenantId), eq(merchantSites.merchantId, merchantId)));
}

export async function updateMerchantSite(
  tx: Tx,
  tenantId: string,
  merchantId: string,
  siteId: string,
  patch: Partial<MerchantSiteInsert>,
): Promise<MerchantSiteRow | null> {
  const rows = await tx
    .update(merchantSites)
    .set(patch)
    .where(
      and(
        eq(merchantSites.tenantId, tenantId),
        eq(merchantSites.merchantId, merchantId),
        eq(merchantSites.id, siteId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
