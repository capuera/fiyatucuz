import { sql } from 'drizzle-orm';
import {
  char,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

// -- Enums --------------------------------------------------------------------

export const merchantStatus = pgEnum('merchant_status', [
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
]);

export const merchantSiteStatus = pgEnum('merchant_site_status', [
  'ACTIVE',
  'SUSPENDED',
  'DEACTIVATED',
]);

export const merchantSiteVerificationStatus = pgEnum('merchant_site_verification_status', [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'FAILED',
]);

export const merchantSiteVerificationMethod = pgEnum('merchant_site_verification_method', [
  'DNS_TXT',
  'HTML_FILE',
  'META_TAG',
]);

// -- merchants ----------------------------------------------------------------
//
// A merchant is a merchant-facing business owned by a tenant. Tenant-scoped;
// RLS is enabled and forced in 0004_merchants_sites.sql.
//
// Note the `UNIQUE(id, tenant_id)`: this is what allows the composite FK on
// merchant_sites(merchant_id, tenant_id) to reference (id, tenant_id) and
// thereby forbid the "site belongs to merchant A which belongs to tenant X
// but site.tenant_id is Y" mismatch at the DB level. See ADR-0015.

export const merchants = pgTable(
  'merchants',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    slug: text('slug').notNull(),
    status: merchantStatus('status').notNull().default('ACTIVE'),
    taxNumber: text('tax_number'),
    taxOffice: text('tax_office'),
    countryCode: char('country_code', { length: 2 }),
    city: text('city'),
    website: text('website'),
    logoUrl: text('logo_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // Slugs are unique per tenant (NOT globally) so two tenants can each own
    // a merchant with slug 'flagship-store'.
    tenantSlugUnique: unique('merchants_tenant_slug_unique').on(t.tenantId, t.slug),
    // Enables the composite FK from merchant_sites — see ADR-0015.
    idTenantUnique: unique('merchants_id_tenant_unique').on(t.id, t.tenantId),
    tenantIdIdx: index('merchants_tenant_id_idx').on(t.tenantId),
  }),
);

// -- merchant_sites -----------------------------------------------------------
//
// A public web presence owned by a merchant. Tenant-scoped, RLS + FORCE RLS.
//
// verification_status transitions:
//   UNVERIFIED  → PENDING  (challenge created)
//   PENDING     → VERIFIED (raw token presented matched stored hash)
//   PENDING     → FAILED   (mismatch)
//   FAILED      → PENDING  (new challenge issued after retry)
//
// verification_token_hash stores HMAC-SHA256 of the raw challenge token; the
// raw value is returned to the caller ONCE at challenge creation and never
// persisted. See ADR-0015.
//
// The composite FK (merchant_id, tenant_id) → merchants (id, tenant_id)
// makes it impossible to attach a site to a merchant that lives in a
// different tenant.

export const merchantSites = pgTable(
  'merchant_sites',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    merchantId: uuid('merchant_id').notNull(),
    name: text('name').notNull(),
    // domain: user-supplied display form; normalized_domain is authoritative
    // for uniqueness and lookups.
    domain: text('domain').notNull(),
    normalizedDomain: text('normalized_domain').notNull(),
    status: merchantSiteStatus('status').notNull().default('ACTIVE'),
    logoUrl: text('logo_url'),
    verificationStatus: merchantSiteVerificationStatus('verification_status')
      .notNull()
      .default('UNVERIFIED'),
    verificationMethod: merchantSiteVerificationMethod('verification_method'),
    verificationTokenHash: text('verification_token_hash'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    merchantTenantFk: foreignKey({
      name: 'merchant_sites_merchant_tenant_fk',
      columns: [t.merchantId, t.tenantId],
      foreignColumns: [merchants.id, merchants.tenantId],
    }).onDelete('restrict'),
    tenantDomainUnique: unique('merchant_sites_tenant_domain_unique').on(
      t.tenantId,
      t.normalizedDomain,
    ),
    tenantIdIdx: index('merchant_sites_tenant_id_idx').on(t.tenantId),
    merchantIdIdx: index('merchant_sites_merchant_id_idx').on(t.merchantId),
    // Partial unique: at most one row across ALL tenants can be VERIFIED for
    // a given normalized_domain. Race-safe by the DB. See ADR-0015 §Verified
    // domain uniqueness.
    verifiedDomainUnique: uniqueIndex('merchant_sites_verified_domain_unique')
      .on(t.normalizedDomain)
      .where(sql`verification_status = 'VERIFIED'`),
  }),
);
