/**
 * Raw feed item → normalized merchant offer (ADR-0018 §Normalization).
 *
 * Item-level outcome is binary:
 *   - rejected: a required field is missing/invalid (identity, title, price,
 *     product URL) or the item is structurally defective. One rejection
 *     code is reported; the import continues with the next item.
 *   - accepted: optional fields that fail validation become null (or are
 *     truncated) and are reported as warnings.
 *
 * Identity is the mapping's single `externalId` path — there is NO fallback
 * to SKU, GTIN, URL or a content fingerprint (ADR-0018 §Identity).
 */

import { createHash } from 'node:crypto';

import type { Money } from '@fiyatucuz/types';

import type { FeedItemMapping, MappedField, OfferAvailability } from '../mapping.js';
import type { RawFeedItem } from '../xml-items.js';

import {
  normalizeAvailability,
  normalizeBoolean,
  normalizeStock,
  normalizeVatRateBp,
} from './attributes.js';
import { normalizeGtin } from './identifiers.js';
import { parsePrice } from './money.js';
import { codePointLength, normalizeText, truncateCodePoints } from './text.js';
import { normalizeImageUrl, normalizeProductUrl } from './url.js';

/** Code-point bounds; mirrored by CHECK constraints in 0006. */
export const OFFER_FIELD_LIMITS = Object.freeze({
  externalId: 256,
  title: 500,
  sku: 128,
  description: 5000,
  brand: 200,
  category: 500,
});

export interface NormalizedOffer {
  readonly externalId: string;
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly brand: string | null;
  readonly merchantCategory: string | null;
  readonly productUrl: string;
  readonly imageUrl: string | null;
  readonly price: Money;
  /** Original/list price; same currency, strictly greater than `price`. */
  readonly listPrice: Money | null;
  readonly vatRateBp: number | null;
  readonly vatIncluded: boolean | null;
  readonly availability: OfferAvailability;
  readonly stockQuantity: number | null;
  /** SHA-256 over the canonical content — change detection, NOT identity. */
  readonly contentHash: string;
}

export interface ItemIssue {
  readonly field: MappedField | 'item';
  readonly code: string;
}

export type NormalizeResult =
  | { readonly kind: 'accepted'; readonly offer: NormalizedOffer; readonly warnings: readonly ItemIssue[] }
  | { readonly kind: 'rejected'; readonly externalId: string | null; readonly issue: ItemIssue };

export interface NormalizeContext {
  /** merchant_sites.normalized_domain of the feed's site. */
  readonly siteDomain: string;
}

export function normalizeFeedItem(
  raw: RawFeedItem,
  mapping: FeedItemMapping,
  ctx: NormalizeContext,
): NormalizeResult {
  const f = mapping.fields;
  const warnings: ItemIssue[] = [];

  /** First non-empty normalized value among the field's paths. */
  const pick = (field: MappedField): { value: string; oversize: boolean } | null => {
    const spec = f[field];
    if (spec === undefined) return null;
    for (const path of Array.isArray(spec) ? spec : [spec]) {
      const value = normalizeText(raw.values.get(path));
      if (value !== null) return { value, oversize: raw.oversize.has(path) };
    }
    return null;
  };
  const reject = (field: ItemIssue['field'], code: string, externalId: string | null = null): NormalizeResult => ({
    kind: 'rejected',
    externalId,
    issue: { field, code },
  });

  // -- identity (no fallback) ---------------------------------------------
  const id = pick('externalId');
  if (id === null) return reject('externalId', 'EXTERNAL_ID_MISSING');
  if (id.oversize || codePointLength(id.value) > OFFER_FIELD_LIMITS.externalId) {
    return reject('externalId', 'FIELD_TOO_LONG');
  }
  const externalId = id.value;

  if (raw.defect !== null) return reject('item', raw.defect, externalId);

  // -- required -----------------------------------------------------------
  const title = pick('title');
  if (title === null) return reject('title', 'TITLE_MISSING', externalId);
  if (title.oversize || codePointLength(title.value) > OFFER_FIELD_LIMITS.title) {
    return reject('title', 'FIELD_TOO_LONG', externalId);
  }

  const url = pick('url');
  if (url === null) return reject('url', 'URL_MISSING', externalId);
  if (url.oversize) return reject('url', 'URL_TOO_LONG', externalId);
  const productUrl = normalizeProductUrl(url.value, ctx.siteDomain);
  if (!productUrl.ok) return reject('url', productUrl.code, externalId);

  const priceText = pick('price');
  if (priceText === null) return reject('price', 'PRICE_MISSING', externalId);
  const currencyField = pick('currency')?.value ?? null;
  const priceOpts = {
    separator: mapping.decimalSeparator,
    currencyField,
    defaultCurrency: mapping.defaultCurrency ?? null,
  };
  const base = parsePrice(priceText.value, priceOpts);
  if (!base.ok) return reject('price', base.code, externalId);

  // -- price / list price ---------------------------------------------------
  let price: Money = base.money;
  let listPrice: Money | null = null;

  const saleText = pick('salePrice');
  if (saleText !== null) {
    const sale = parsePrice(saleText.value, priceOpts);
    if (!sale.ok || sale.money.currency !== price.currency) {
      warnings.push({ field: 'salePrice', code: sale.ok ? 'CURRENCY_CONFLICT' : sale.code });
    } else if (sale.money.amount < price.amount) {
      listPrice = price;
      price = sale.money;
    } else if (sale.money.amount > price.amount) {
      warnings.push({ field: 'salePrice', code: 'SALE_PRICE_NOT_LOWER' });
    }
  }

  const listText = pick('listPrice');
  if (listText !== null && listPrice === null) {
    const list = parsePrice(listText.value, priceOpts);
    if (!list.ok || list.money.currency !== price.currency) {
      warnings.push({ field: 'listPrice', code: list.ok ? 'CURRENCY_CONFLICT' : list.code });
    } else if (list.money.amount > price.amount) {
      listPrice = list.money;
    } else if (list.money.amount < price.amount) {
      warnings.push({ field: 'listPrice', code: 'LIST_PRICE_NOT_HIGHER' });
    }
  }

  // -- optional text --------------------------------------------------------
  const optionalText = (field: MappedField, max: number): string | null => {
    const v = pick(field);
    if (v === null) return null;
    if (v.oversize || codePointLength(v.value) > max) {
      warnings.push({ field, code: 'FIELD_TRUNCATED' });
      return truncateCodePoints(v.value, max);
    }
    return v.value;
  };
  const description = optionalText('description', OFFER_FIELD_LIMITS.description);
  const brand = optionalText('brand', OFFER_FIELD_LIMITS.brand);
  const merchantCategory = optionalText('category', OFFER_FIELD_LIMITS.category);

  let sku: string | null = null;
  const skuText = pick('sku');
  if (skuText !== null) {
    if (skuText.oversize || codePointLength(skuText.value) > OFFER_FIELD_LIMITS.sku) {
      warnings.push({ field: 'sku', code: 'FIELD_TOO_LONG' });
    } else {
      sku = skuText.value;
    }
  }

  let gtin: string | null = null;
  const gtinText = pick('gtin');
  if (gtinText !== null) {
    gtin = gtinText.oversize ? null : normalizeGtin(gtinText.value);
    if (gtin === null) warnings.push({ field: 'gtin', code: 'GTIN_INVALID' });
  }

  let imageUrl: string | null = null;
  const imageText = pick('image');
  if (imageText !== null) {
    const r = imageText.oversize ? ({ ok: false, code: 'URL_TOO_LONG' } as const) : normalizeImageUrl(imageText.value);
    if (r.ok) imageUrl = r.href;
    else warnings.push({ field: 'image', code: r.code });
  }

  // -- stock / availability / VAT -------------------------------------------
  let stockQuantity: number | null = null;
  const stockText = pick('stock');
  if (stockText !== null) {
    stockQuantity = normalizeStock(stockText.value);
    if (stockQuantity === null) warnings.push({ field: 'stock', code: 'STOCK_INVALID' });
  }

  let availability: OfferAvailability = 'UNKNOWN';
  const availText = pick('availability');
  if (availText !== null) {
    const a = normalizeAvailability(availText.value, mapping.availabilityValues);
    if (a === null) warnings.push({ field: 'availability', code: 'AVAILABILITY_UNKNOWN' });
    else availability = a;
  } else if (stockQuantity !== null) {
    availability = stockQuantity > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK';
  }

  let vatRateBp: number | null = null;
  const vatText = pick('vatRate');
  if (vatText !== null) {
    vatRateBp = normalizeVatRateBp(vatText.value);
    if (vatRateBp === null) warnings.push({ field: 'vatRate', code: 'VAT_RATE_INVALID' });
  }

  let vatIncluded: boolean | null = mapping.vatIncludedDefault ?? null;
  const vatIncText = pick('vatIncluded');
  if (vatIncText !== null) {
    const b = normalizeBoolean(vatIncText.value);
    if (b === null) warnings.push({ field: 'vatIncluded', code: 'VAT_INCLUDED_INVALID' });
    else vatIncluded = b;
  }

  const content = {
    externalId,
    sku,
    gtin,
    title: title.value,
    description,
    brand,
    merchantCategory,
    productUrl: productUrl.href,
    imageUrl,
    price,
    listPrice,
    vatRateBp,
    vatIncluded,
    availability,
    stockQuantity,
  };
  return { kind: 'accepted', offer: { ...content, contentHash: contentHashOf(content) }, warnings };
}

/** Deterministic SHA-256 over the content fields in a fixed order. */
export function contentHashOf(o: Omit<NormalizedOffer, 'contentHash'>): string {
  const canonical = JSON.stringify([
    o.externalId,
    o.sku,
    o.gtin,
    o.title,
    o.description,
    o.brand,
    o.merchantCategory,
    o.productUrl,
    o.imageUrl,
    o.price.currency,
    o.price.amount.toString(),
    o.listPrice === null ? null : o.listPrice.amount.toString(),
    o.vatRateBp,
    o.vatIncluded,
    o.availability,
    o.stockQuantity,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
