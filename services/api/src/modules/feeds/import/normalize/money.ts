/**
 * Price parsing (ADR-0018 §Price representation).
 *
 * Project standard (ADR-0012): money is `bigint` minor units + ISO-4217
 * currency. Parsing goes string → digits → bigint; JavaScript `number` is
 * never used for an amount, so no float rounding can occur.
 *
 * Separator rules:
 *   - both "." and "," present  → the LAST one is the decimal separator;
 *     the other must form valid 3-digit thousands groups.
 *   - one kind, repeated        → thousands separator, no fraction.
 *   - one kind, once            → configured separator decides; in `auto`
 *     mode 1–3 leading + exactly 3 trailing digits ("1.299") is AMBIGUOUS
 *     and rejected, otherwise it is the decimal separator.
 *   - spaces / NBSP / apostrophe are accepted as thousands grouping only.
 * Extra fraction digits beyond the currency exponent are accepted only if
 * they are zeros ("1299.900"); otherwise the price is rejected — never
 * rounded.
 */

import type { Money } from '@fiyatucuz/types';
import { CurrencyCodeSchema } from '@fiyatucuz/validation';

import type { DecimalSeparator } from '../mapping.js';

/** Supported ISO-4217 codes and their minor-unit exponents. */
export const SUPPORTED_CURRENCIES: Readonly<Record<string, number>> = Object.freeze({
  TRY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
});

const CURRENCY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  TRY: 'TRY',
  TL: 'TRY',
  '₺': 'TRY',
  USD: 'USD',
  US$: 'USD',
  $: 'USD',
  EUR: 'EUR',
  '€': 'EUR',
  GBP: 'GBP',
  '£': 'GBP',
});

/** Integer digits allowed before the decimal point (< 10^13 major units). */
const MAX_INTEGER_DIGITS = 13;
const MAX_PRICE_INPUT_CHARS = 64;

export type PriceErrorCode =
  | 'PRICE_INVALID'
  | 'PRICE_AMBIGUOUS'
  | 'PRICE_SEPARATOR_MISMATCH'
  | 'PRICE_TOO_PRECISE'
  | 'PRICE_OUT_OF_RANGE'
  | 'PRICE_NOT_POSITIVE'
  | 'CURRENCY_UNSUPPORTED'
  | 'CURRENCY_CONFLICT';

export type CurrencyResult =
  | { readonly ok: true; readonly currency: string }
  | { readonly ok: false; readonly code: 'CURRENCY_UNSUPPORTED' };

/** Map an alias ("TL", "₺", "try") to a supported ISO-4217 code. */
export function resolveCurrency(token: string): CurrencyResult {
  const key = token.trim().toUpperCase();
  const code = CURRENCY_ALIASES[key] ?? CURRENCY_ALIASES[token.trim()];
  if (code === undefined || !CurrencyCodeSchema.safeParse(code).success) {
    return { ok: false, code: 'CURRENCY_UNSUPPORTED' };
  }
  return { ok: true, currency: code };
}

export interface SplitPrice {
  /** Numeric part, e.g. "1.299,90". */
  readonly numberText: string;
  /** Currency resolved from a prefix/suffix token, or null when absent. */
  readonly currency: string | null;
}

// [prefix token] number [suffix token]. Tokens: 1–3 non-digit, non-space,
// non-separator chars ("TL", "TRY", "₺", "US$"). No sign is accepted.
const PRICE_RE =
  /^(?:([^\d\s.,'\-+]{1,3})\s*)?(\d[\d.,'\u00A0\u202F ]*?)(?:\s*([^\d\s.,'\-+]{1,3}))?$/u;

export function splitPrice(
  raw: string,
): { readonly ok: true; readonly value: SplitPrice } | { readonly ok: false; readonly code: PriceErrorCode } {
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_PRICE_INPUT_CHARS) return { ok: false, code: 'PRICE_INVALID' };
  const m = PRICE_RE.exec(s);
  if (!m) return { ok: false, code: 'PRICE_INVALID' };
  const [, pre, num = '', post] = m;
  let currency: string | null = null;
  for (const token of [pre, post]) {
    if (token === undefined) continue;
    const r = resolveCurrency(token);
    if (!r.ok) return { ok: false, code: 'CURRENCY_UNSUPPORTED' };
    if (currency !== null && currency !== r.currency) return { ok: false, code: 'CURRENCY_CONFLICT' };
    currency = r.currency;
  }
  return { ok: true, value: { numberText: num.trim(), currency } };
}

const GROUP_CHARS = "'\u00A0\u202F ";

function isGroupedInteger(intPart: string, thousands: string | null): boolean {
  if (/^\d+$/.test(intPart)) return true;
  const sepClass = `[${escapeClass(GROUP_CHARS + (thousands ?? ''))}]`;
  return new RegExp(`^\\d{1,3}(?:${sepClass}\\d{3})+$`).test(intPart);
}

function escapeClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, '\\$&');
}

/**
 * Convert a numeric text to minor units for a currency exponent.
 * Pure string/bigint arithmetic.
 */
export function parseAmountMinor(
  numberText: string,
  exponent: number,
  separator: DecimalSeparator,
): { readonly ok: true; readonly amount: bigint } | { readonly ok: false; readonly code: PriceErrorCode } {
  const dots = numberText.split('.').length - 1;
  const commas = numberText.split(',').length - 1;

  let decimal: '.' | ',' | null = null;
  let thousands: '.' | ',' | null = null;
  if (dots > 0 && commas > 0) {
    decimal = numberText.lastIndexOf('.') > numberText.lastIndexOf(',') ? '.' : ',';
    thousands = decimal === '.' ? ',' : '.';
    if (separator !== 'auto' && separator !== decimal) {
      return { ok: false, code: 'PRICE_SEPARATOR_MISMATCH' };
    }
  } else if (dots + commas > 1) {
    thousands = dots > 0 ? '.' : ',';
  } else if (dots + commas === 1) {
    const sep: '.' | ',' = dots === 1 ? '.' : ',';
    const at = numberText.indexOf(sep);
    const after = numberText.length - at - 1;
    // "1.299" could be 1299 or 1.299; "1299.900" cannot be a thousands
    // grouping (4 leading digits), so only 1–3 leading digits are ambiguous.
    const before = numberText.slice(0, at).replace(/[^\d]/g, '').length;
    if (separator === 'auto') {
      if (after === 3 && before <= 3) return { ok: false, code: 'PRICE_AMBIGUOUS' };
      decimal = sep;
    } else if (separator === sep) {
      decimal = sep;
    } else {
      thousands = sep;
    }
  }

  let intPart = numberText;
  let fracPart = '';
  if (decimal !== null) {
    const at = numberText.lastIndexOf(decimal);
    intPart = numberText.slice(0, at);
    fracPart = numberText.slice(at + 1);
    if (!/^\d+$/.test(fracPart)) return { ok: false, code: 'PRICE_INVALID' };
  }
  if (intPart.length === 0 || !isGroupedInteger(intPart, thousands)) {
    return { ok: false, code: 'PRICE_INVALID' };
  }

  const intDigits = intPart.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  if (intDigits.length > MAX_INTEGER_DIGITS) return { ok: false, code: 'PRICE_OUT_OF_RANGE' };

  if (fracPart.length > exponent) {
    if (!/^0+$/.test(fracPart.slice(exponent))) return { ok: false, code: 'PRICE_TOO_PRECISE' };
    fracPart = fracPart.slice(0, exponent);
  }

  const scale = 10n ** BigInt(exponent);
  const amount = BigInt(intDigits) * scale + BigInt(fracPart.padEnd(exponent, '0') || '0');
  if (amount <= 0n) return { ok: false, code: 'PRICE_NOT_POSITIVE' };
  return { ok: true, amount };
}

/**
 * Full price parse: split token + number, resolve the currency (embedded
 * token → explicit currency field → mapping default), convert to minor units.
 */
export function parsePrice(
  raw: string,
  opts: {
    readonly separator: DecimalSeparator;
    readonly currencyField: string | null;
    readonly defaultCurrency: string | null;
  },
): { readonly ok: true; readonly money: Money } | { readonly ok: false; readonly code: PriceErrorCode | 'CURRENCY_MISSING' } {
  const split = splitPrice(raw);
  if (!split.ok) return split;

  let currency = split.value.currency;
  if (opts.currencyField !== null) {
    const r = resolveCurrency(opts.currencyField);
    if (!r.ok) return { ok: false, code: 'CURRENCY_UNSUPPORTED' };
    if (currency !== null && currency !== r.currency) return { ok: false, code: 'CURRENCY_CONFLICT' };
    currency = r.currency;
  }
  currency ??= opts.defaultCurrency;
  if (currency === null) return { ok: false, code: 'CURRENCY_MISSING' };
  const exponent = SUPPORTED_CURRENCIES[currency];
  if (exponent === undefined) return { ok: false, code: 'CURRENCY_UNSUPPORTED' };

  const amount = parseAmountMinor(split.value.numberText, exponent, opts.separator);
  if (!amount.ok) return amount;
  return { ok: true, money: { amount: amount.amount, currency } };
}
