import { newId, withTenantTransaction, type Db, type Tx } from '@fiyatucuz/db';
import type { Logger } from 'pino';

import { generateRawToken, hashToken } from '../auth/token.js';

import * as repo from './repository.js';
import {
  InvalidDomainError,
  normalizeDomain,
  type CreateMerchantInput,
  type CreateMerchantSiteInput,
  type CreateVerificationChallengeInput,
  type UpdateMerchantInput,
  type UpdateMerchantSiteInput,
} from './validation.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MerchantSlugAlreadyExistsError extends Error {
  readonly code = 'MERCHANT_SLUG_ALREADY_EXISTS' as const;
  readonly httpStatus = 409;
  constructor(public readonly slug: string) {
    super('merchant slug already exists in this tenant');
    this.name = 'MerchantSlugAlreadyExistsError';
  }
}

export class MerchantNotFoundError extends Error {
  readonly code = 'MERCHANT_NOT_FOUND' as const;
  readonly httpStatus = 404;
  constructor(public readonly merchantId: string) {
    super('merchant not found');
    this.name = 'MerchantNotFoundError';
  }
}

export class MerchantSiteDomainAlreadyExistsError extends Error {
  readonly code = 'SITE_DOMAIN_ALREADY_EXISTS' as const;
  readonly httpStatus = 409;
  constructor(public readonly normalizedDomain: string) {
    super('a site with this domain already exists in this tenant');
    this.name = 'MerchantSiteDomainAlreadyExistsError';
  }
}

export class MerchantSiteDomainAlreadyVerifiedElsewhereError extends Error {
  readonly code = 'SITE_DOMAIN_ALREADY_VERIFIED_ELSEWHERE' as const;
  readonly httpStatus = 409;
  constructor(public readonly normalizedDomain: string) {
    super('this domain is already verified by another owner');
    this.name = 'MerchantSiteDomainAlreadyVerifiedElsewhereError';
  }
}

export class MerchantSiteNotFoundError extends Error {
  readonly code = 'SITE_NOT_FOUND' as const;
  readonly httpStatus = 404;
  constructor(public readonly siteId: string) {
    super('site not found');
    this.name = 'MerchantSiteNotFoundError';
  }
}

export class VerificationTokenMismatchError extends Error {
  readonly code = 'VERIFICATION_TOKEN_MISMATCH' as const;
  readonly httpStatus = 400;
  constructor() {
    super('presented verification token does not match');
    this.name = 'VerificationTokenMismatchError';
  }
}

export class VerificationChallengeMissingError extends Error {
  readonly code = 'VERIFICATION_CHALLENGE_MISSING' as const;
  readonly httpStatus = 400;
  constructor() {
    super('no verification challenge has been created for this site');
    this.name = 'VerificationChallengeMissingError';
  }
}

export { InvalidDomainError };

// ---------------------------------------------------------------------------
// Service surface + types
// ---------------------------------------------------------------------------

export interface VerificationChallenge {
  readonly method: 'DNS_TXT' | 'HTML_FILE' | 'META_TAG';
  readonly rawToken: string;
  readonly instructions: {
    readonly recordName?: string;
    readonly recordValue?: string;
    readonly filePath?: string;
    readonly metaTag?: string;
  };
}

export interface MerchantService {
  createMerchant(tenantId: string, input: CreateMerchantInput): Promise<repo.MerchantRow>;
  listMerchants(tenantId: string): Promise<readonly repo.MerchantRow[]>;
  getMerchant(tenantId: string, merchantId: string): Promise<repo.MerchantRow>;
  updateMerchant(
    tenantId: string,
    merchantId: string,
    patch: UpdateMerchantInput,
  ): Promise<repo.MerchantRow>;

  createMerchantSite(
    tenantId: string,
    merchantId: string,
    input: CreateMerchantSiteInput,
  ): Promise<repo.MerchantSiteRow>;
  listMerchantSites(
    tenantId: string,
    merchantId: string,
  ): Promise<readonly repo.MerchantSiteRow[]>;
  getMerchantSite(
    tenantId: string,
    merchantId: string,
    siteId: string,
  ): Promise<repo.MerchantSiteRow>;
  updateMerchantSite(
    tenantId: string,
    merchantId: string,
    siteId: string,
    patch: UpdateMerchantSiteInput,
  ): Promise<repo.MerchantSiteRow>;

  createSiteVerificationChallenge(
    tenantId: string,
    merchantId: string,
    siteId: string,
    input: CreateVerificationChallengeInput,
  ): Promise<{ site: repo.MerchantSiteRow; challenge: VerificationChallenge }>;

  finalizeSiteVerification(
    tenantId: string,
    merchantId: string,
    siteId: string,
    presentedRawToken: string,
  ): Promise<repo.MerchantSiteRow>;
}

export interface MerchantServiceDeps {
  readonly db: Db;
  /** HMAC key used to hash raw verification tokens before storage. Same
   * secret family as auth session/refresh tokens (ADR-0014); rotation
   * invalidates all pending challenges. */
  readonly hmacSecret: string;
  readonly logger?: Logger;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Drop `undefined` values so a Zod-parsed `.optional()` patch is compatible
// with a `Partial<T>` under exactOptionalPropertyTypes. The output type
// excludes `undefined` from each field so downstream signatures accept it.
// Preserves nullable clears (`field: null` — an explicit "unset this column").
type DefinedFields<T> = { [K in keyof T]?: Exclude<T[K], undefined> };
function definedOnly<T extends Record<string, unknown>>(obj: T): DefinedFields<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as DefinedFields<T>;
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  if (typeof e.code !== 'string' || e.code !== '23505') return false;
  if (!constraint) return true;
  // Try structured fields first (varies by driver / drizzle version), then
  // fall back to searching the message + detail text. Postgres always emits
  // the constraint name in the 23505 message; the fallback is reliable.
  const structured = [
    typeof e.constraint === 'string' ? e.constraint : null,
    typeof e.constraint_name === 'string' ? e.constraint_name : null,
  ].filter((v): v is string => v !== null);
  if (structured.includes(constraint)) return true;
  const text = `${String(e.message ?? '')} ${String(e.detail ?? '')}`;
  return text.includes(`"${constraint}"`);
}

function buildInstructions(
  method: VerificationChallenge['method'],
  rawToken: string,
  normalizedDomain: string,
): VerificationChallenge['instructions'] {
  switch (method) {
    case 'DNS_TXT':
      return {
        recordName: `_fiyatucuz-challenge.${normalizedDomain}`,
        recordValue: `fiyatucuz-site-verification=${rawToken}`,
      };
    case 'HTML_FILE':
      return {
        filePath: `/.well-known/fiyatucuz-challenge/${rawToken}.txt`,
        recordValue: rawToken,
      };
    case 'META_TAG':
      return {
        metaTag: `<meta name="fiyatucuz-site-verification" content="${rawToken}">`,
      };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMerchantService(deps: MerchantServiceDeps): MerchantService {
  const { db, hmacSecret, logger } = deps;

  const hash = (raw: string): string => hashToken(raw, hmacSecret);

  async function requireMerchant(
    tx: Tx,
    tenantId: string,
    merchantId: string,
  ): Promise<repo.MerchantRow> {
    const row = await repo.findMerchantById(tx, tenantId, merchantId);
    if (!row) throw new MerchantNotFoundError(merchantId);
    return row;
  }

  async function requireMerchantSite(
    tx: Tx,
    tenantId: string,
    merchantId: string,
    siteId: string,
  ): Promise<repo.MerchantSiteRow> {
    const row = await repo.findMerchantSiteById(tx, tenantId, merchantId, siteId);
    if (!row) throw new MerchantSiteNotFoundError(siteId);
    return row;
  }

  return {
    async createMerchant(tenantId, input) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        // Fast-path duplicate check; DB UNIQUE(tenant_id, slug) is authoritative
        // and closes the race between SELECT and INSERT (23505 → mapped below).
        const existing = await repo.findMerchantBySlug(tx, tenantId, input.slug);
        if (existing) throw new MerchantSlugAlreadyExistsError(input.slug);
        try {
          return await repo.insertMerchant(tx, {
            id: newId(),
            tenantId,
            name: input.name,
            slug: input.slug,
            legalName: input.legalName ?? null,
            taxNumber: input.taxNumber ?? null,
            taxOffice: input.taxOffice ?? null,
            countryCode: input.countryCode ?? null,
            city: input.city ?? null,
            website: input.website ?? null,
            logoUrl: input.logoUrl ?? null,
            status: 'ACTIVE',
          });
        } catch (err) {
          if (isUniqueViolation(err, 'merchants_tenant_slug_unique')) {
            throw new MerchantSlugAlreadyExistsError(input.slug);
          }
          throw err;
        }
      });
    },

    async listMerchants(tenantId) {
      return withTenantTransaction(db, tenantId, (tx) =>
        repo.listMerchantsForTenant(tx, tenantId),
      );
    },

    async getMerchant(tenantId, merchantId) {
      return withTenantTransaction(db, tenantId, (tx) => requireMerchant(tx, tenantId, merchantId));
    },

    async updateMerchant(tenantId, merchantId, patch) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        // Confirm existence up-front so a missing row surfaces as 404 rather
        // than as an "affected 0 rows" ambiguous silence.
        await requireMerchant(tx, tenantId, merchantId);
        const updated = await repo.updateMerchant(
          tx,
          tenantId,
          merchantId,
          definedOnly(patch),
        );
        if (!updated) throw new MerchantNotFoundError(merchantId);
        return updated;
      });
    },

    async createMerchantSite(tenantId, merchantId, input) {
      // Domain normalization runs BEFORE we enter the transaction so a
      // malformed domain never opens a DB tx.
      const normalized = normalizeDomain(input.domain);

      return withTenantTransaction(db, tenantId, async (tx) => {
        // Confirm the merchant exists in THIS tenant. The composite FK will
        // reject a cross-tenant merchant_id independently, but a clean 404
        // for the caller is better UX than a raw FK violation.
        await requireMerchant(tx, tenantId, merchantId);
        try {
          return await repo.insertMerchantSite(tx, {
            id: newId(),
            tenantId,
            merchantId,
            name: input.name,
            domain: input.domain.trim(),
            normalizedDomain: normalized,
            status: 'ACTIVE',
            verificationStatus: 'UNVERIFIED',
            logoUrl: input.logoUrl ?? null,
          });
        } catch (err) {
          if (isUniqueViolation(err, 'merchant_sites_tenant_domain_unique')) {
            throw new MerchantSiteDomainAlreadyExistsError(normalized);
          }
          throw err;
        }
      });
    },

    async listMerchantSites(tenantId, merchantId) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        await requireMerchant(tx, tenantId, merchantId);
        return repo.listMerchantSitesForMerchant(tx, tenantId, merchantId);
      });
    },

    async getMerchantSite(tenantId, merchantId, siteId) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        await requireMerchant(tx, tenantId, merchantId);
        return requireMerchantSite(tx, tenantId, merchantId, siteId);
      });
    },

    async updateMerchantSite(tenantId, merchantId, siteId, patch) {
      return withTenantTransaction(db, tenantId, async (tx) => {
        await requireMerchantSite(tx, tenantId, merchantId, siteId);
        const updated = await repo.updateMerchantSite(
          tx,
          tenantId,
          merchantId,
          siteId,
          definedOnly(patch),
        );
        if (!updated) throw new MerchantSiteNotFoundError(siteId);
        return updated;
      });
    },

    async createSiteVerificationChallenge(tenantId, merchantId, siteId, input) {
      const rawToken = generateRawToken();
      const tokenHash = hash(rawToken);

      const site = await withTenantTransaction(db, tenantId, async (tx) => {
        const existing = await requireMerchantSite(tx, tenantId, merchantId, siteId);
        // Overwrite any prior challenge — the caller is establishing a NEW
        // one. If the site is already VERIFIED, allow re-challenge (moves
        // status to PENDING) so the caller can prove ownership again after
        // ops action; keep the previous verified_at only if we transition
        // back to VERIFIED — for now we clear it on re-challenge to keep
        // semantics explicit.
        const updated = await repo.updateMerchantSite(tx, tenantId, merchantId, siteId, {
          verificationStatus: 'PENDING',
          verificationMethod: input.method,
          verificationTokenHash: tokenHash,
          verifiedAt: null,
        });
        if (!updated) throw new MerchantSiteNotFoundError(siteId);
        return { existing, updated };
      });

      // Never log the raw token or the hash. Log only status transition.
      logger?.info(
        { siteId: site.updated.id, method: input.method, priorStatus: site.existing.verificationStatus },
        'site verification challenge created',
      );

      return {
        site: site.updated,
        challenge: {
          method: input.method,
          rawToken,
          instructions: buildInstructions(
            input.method,
            rawToken,
            site.updated.normalizedDomain,
          ),
        },
      };
    },

    async finalizeSiteVerification(tenantId, merchantId, siteId, presentedRawToken) {
      if (typeof presentedRawToken !== 'string' || presentedRawToken.length === 0) {
        throw new VerificationTokenMismatchError();
      }
      const presentedHash = hash(presentedRawToken);

      // Discriminated-union return so the FAILED-marker write commits before
      // we throw. The partial-unique constraint violation may surface at the
      // COMMIT step (escaping any per-statement try/catch); we therefore
      // catch it at the OUTER await, where drizzle/postgres.js has finished
      // finalising the transaction. Store the normalized_domain in a closure
      // so the outer scope has it available for the translated error.
      type Outcome =
        | { readonly kind: 'no_challenge' }
        | { readonly kind: 'mismatch' }
        | { readonly kind: 'ok'; readonly row: repo.MerchantSiteRow };

      let normalizedDomainForConflict: string | null = null;

      try {
        const outcome = await withTenantTransaction<Outcome>(db, tenantId, async (tx) => {
          const site = await requireMerchantSite(tx, tenantId, merchantId, siteId);
          normalizedDomainForConflict = site.normalizedDomain;

          if (!site.verificationTokenHash) return { kind: 'no_challenge' };
          if (site.verificationTokenHash !== presentedHash) {
            await repo.updateMerchantSite(tx, tenantId, merchantId, siteId, {
              verificationStatus: 'FAILED',
            });
            return { kind: 'mismatch' };
          }
          const updated = await repo.updateMerchantSite(tx, tenantId, merchantId, siteId, {
            verificationStatus: 'VERIFIED',
            verifiedAt: new Date(),
          });
          if (!updated) throw new MerchantSiteNotFoundError(siteId);
          return { kind: 'ok', row: updated };
        });

        if (outcome.kind === 'no_challenge') throw new VerificationChallengeMissingError();
        if (outcome.kind === 'mismatch') throw new VerificationTokenMismatchError();
        return outcome.row;
      } catch (err) {
        if (
          normalizedDomainForConflict !== null &&
          isUniqueViolation(err, 'merchant_sites_verified_domain_unique')
        ) {
          throw new MerchantSiteDomainAlreadyVerifiedElsewhereError(
            normalizedDomainForConflict,
          );
        }
        throw err;
      }
    },
  };
}
