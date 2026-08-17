// Foundation types shared across backend, web, and mobile.
// Domain-specific types belong to their bounded context, not this package.

/**
 * ULID as a canonical 26-character Crockford-Base32 string.
 * Convention across FiyatUcuz per docs/domain/ubiquitous-language.md.
 */
export type Ulid = string & { readonly __brand: 'Ulid' };

/** Every tenant-scoped operation carries one of these. See ADR-0004. */
export type TenantId = Ulid & { readonly __tenantBrand: 'TenantId' };

/** Amount in minor units (e.g. TRY kuruş) with an ISO 4217 currency code. Never use `number`. */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

/** ISO-8601 timestamp string (UTC). Stored as `timestamptz` at the DB layer. */
export type IsoDateTime = string & { readonly __brand: 'IsoDateTime' };

/** Standard pagination request. */
export interface PageRequest {
  readonly cursor?: string;
  readonly limit: number;
}

/** Standard paginated response. */
export interface PageResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Machine-readable API error envelope. Wire shape kept stable across API versions. */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
}
