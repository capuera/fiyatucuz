/**
 * Text normalization (ADR-0018 §Normalization).
 *
 * NFC, lone surrogates → U+FFFD, control / zero-width / line-separator
 * characters → space, whitespace runs collapsed, trimmed. Empty → null.
 * Lengths are measured in Unicode code points, never UTF-16 units, so a
 * Turkish or emoji-heavy title is never cut in half.
 */

// C0/C1 controls, zero-width space/joiners, LS/PS, BOM. Matching control
// characters is the whole point of this pattern.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\uFEFF]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const WS_RE = /\s+/g;

export function normalizeText(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const s = raw
    .replace(LONE_SURROGATE_RE, '\uFFFD')
    .normalize('NFC')
    .replace(CONTROL_RE, ' ')
    .replace(WS_RE, ' ')
    .trim();
  return s.length > 0 ? s : null;
}

export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Truncate to at most `max` code points (never splits a surrogate pair). */
export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s; // UTF-16 length is an upper bound on code points
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n === max) break;
    out += ch;
    n += 1;
  }
  return out;
}

const TR_ASCII_FOLD: Readonly<Record<string, string>> = Object.freeze({
  ş: 's',
  ğ: 'g',
  ü: 'u',
  ö: 'o',
  ç: 'c',
});

/**
 * Deterministic keyword-matching key, independent of the system locale.
 *
 * Merchant values mix English and Turkish casing: Turkish lower-casing turns
 * "In Stock" into "ın stock", while locale-free lower-casing turns "TÜKENDİ"
 * into "tükendi̇" (combining dot). So the four i-forms (İ I ı i) collapse to
 * "i", the remaining Turkish letters fold to ASCII, and the locale-free
 * String#toLowerCase is used. Lookup tables are keyed through this same
 * function, so "In Stock", "IN_STOCK", "Stokta", "TÜKENDİ" and "Tükendi" all
 * match.
 */
export function foldForMatch(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .replace(/[şğüöç]/g, (ch) => TR_ASCII_FOLD[ch] ?? ch)
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}
