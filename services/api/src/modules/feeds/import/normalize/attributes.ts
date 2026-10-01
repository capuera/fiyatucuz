/**
 * Availability / stock / VAT normalization (ADR-0018 §Normalization).
 * All parsers are pure and string-based; unparseable optional values become
 * null and are reported as item warnings by the caller.
 */

import type { OfferAvailability } from '../mapping.js';

import { foldForMatch } from './text.js';

// Keys are folded with foldForMatch at load time (locale-independent).
const DEFAULT_AVAILABILITY: ReadonlyMap<string, OfferAvailability> = foldKeys([
  ['in stock', 'IN_STOCK'],
  ['instock', 'IN_STOCK'],
  ['available', 'IN_STOCK'],
  ['var', 'IN_STOCK'],
  ['stokta', 'IN_STOCK'],
  ['stokta var', 'IN_STOCK'],
  ['mevcut', 'IN_STOCK'],
  ['satışta', 'IN_STOCK'],
  ['out of stock', 'OUT_OF_STOCK'],
  ['outofstock', 'OUT_OF_STOCK'],
  ['sold out', 'OUT_OF_STOCK'],
  ['yok', 'OUT_OF_STOCK'],
  ['stokta yok', 'OUT_OF_STOCK'],
  ['tükendi', 'OUT_OF_STOCK'],
  ['tukendi', 'OUT_OF_STOCK'],
  ['preorder', 'PREORDER'],
  ['pre order', 'PREORDER'],
  ['ön sipariş', 'PREORDER'],
  ['on siparis', 'PREORDER'],
  ['backorder', 'BACKORDER'],
  ['back order', 'BACKORDER'],
]);

function foldKeys<V>(entries: ReadonlyArray<readonly [string, V]>): ReadonlyMap<string, V> {
  return new Map(entries.map(([k, v]) => [foldForMatch(k), v] as const));
}

/**
 * Map a merchant availability string to the enum. Mapping-specific values
 * (`availabilityValues`) take precedence over the built-in table. Returns
 * null for an unrecognized value.
 */
export function normalizeAvailability(
  raw: string,
  overrides: Readonly<Record<string, OfferAvailability>> | undefined,
): OfferAvailability | null {
  const key = foldForMatch(raw);
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (foldForMatch(k) === key) return v;
    }
  }
  return DEFAULT_AVAILABILITY.get(key) ?? null;
}

/** Non-negative integer stock quantity (≤ 9 digits), else null. */
export function normalizeStock(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

/**
 * VAT rate as basis points: "20" / "%20" / "20%" / "18,5" / "18.50" → bp.
 * Values above 100% are rejected. Integer arithmetic only.
 */
export function normalizeVatRateBp(raw: string): number | null {
  const m = /^%?\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*%?$/.exec(raw.trim());
  if (!m) return null;
  const whole = Number.parseInt(m[1] ?? '0', 10);
  const frac = Number.parseInt((m[2] ?? '').padEnd(2, '0') || '0', 10);
  const bp = whole * 100 + frac;
  return bp <= 10_000 ? bp : null;
}

const TRUE_WORDS = new Set(
  ['true', '1', 'yes', 'evet', 'dahil', 'kdv dahil', 'included'].map(foldForMatch),
);
const FALSE_WORDS = new Set(
  ['false', '0', 'no', 'hayır', 'hariç', 'kdv hariç', 'excluded'].map(foldForMatch),
);

export function normalizeBoolean(raw: string): boolean | null {
  const key = foldForMatch(raw);
  if (TRUE_WORDS.has(key)) return true;
  if (FALSE_WORDS.has(key)) return false;
  return null;
}
