/**
 * Product identifier normalization (ADR-0018 §Normalization).
 *
 * GTIN (EAN-8, UPC-A/12, EAN-13, GTIN-14): spaces/hyphens stripped, digits
 * only, GS1 mod-10 check digit verified, zero-padded to GTIN-14 so the
 * same product compares equal regardless of the merchant's encoding.
 * GTIN is a future matching signal — NOT identity and NOT unique.
 */

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

export function normalizeGtin(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits) || !GTIN_LENGTHS.has(digits.length)) return null;
  if (/^0+$/.test(digits)) return null;
  if (!hasValidCheckDigit(digits)) return null;
  return digits.padStart(14, '0');
}

function hasValidCheckDigit(digits: string): boolean {
  let sum = 0;
  // Weights 3,1,3,1… from the rightmost non-check digit.
  for (let i = digits.length - 2, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) {
    sum += (digits.charCodeAt(i) - 48) * w;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(digits.length - 1) - 48;
}
