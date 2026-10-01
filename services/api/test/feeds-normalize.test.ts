import { describe, expect, it } from 'vitest';

import {
  FeedItemMappingSchema,
  GOOGLE_MERCHANT_PRESET,
  normalizeAvailability,
  normalizeBoolean,
  normalizeFeedItem,
  normalizeGtin,
  normalizeImageUrl,
  normalizeProductUrl,
  normalizeStock,
  normalizeText,
  normalizeVatRateBp,
  parsePrice,
  resolveFeedMapping,
  truncateCodePoints,
  type FeedItemMapping,
  type RawFeedItem,
} from '../src/modules/feeds/index.js';

// ===========================================================================
// Price (bigint minor units, no float)
// ===========================================================================

describe('feeds normalize: parsePrice', () => {
  const opts = (over: Partial<Parameters<typeof parsePrice>[1]> = {}) => ({
    separator: 'auto' as const,
    currencyField: null,
    defaultCurrency: 'TRY',
    ...over,
  });

  const ok: Array<[string, bigint, string]> = [
    ['1299.90 TRY', 129990n, 'TRY'],
    ['1.299,90 TL', 129990n, 'TRY'],
    ['₺1.299,90', 129990n, 'TRY'],
    ['1299,9', 129990n, 'TRY'],
    ['1 299,90 TRY', 129990n, 'TRY'],
    ['1,299.90 USD', 129990n, 'USD'],
    ['€ 12,50', 1250n, 'EUR'],
    ['12.5', 1250n, 'TRY'],
    ['1299', 129900n, 'TRY'],
    ['1.299.000', 129900000n, 'TRY'],
    ['1299.900 TRY', 129990n, 'TRY'],
    ['0,01', 1n, 'TRY'],
    // No float rounding at the precision edge.
    ['9999999999999.99 TRY', 999999999999999n, 'TRY'],
    ['0.29', 29n, 'TRY'],
  ];
  it.each(ok)('%j → %s minor %s', (raw, amount, currency) => {
    const r = parsePrice(raw, opts());
    expect(r).toEqual({ ok: true, money: { amount, currency } });
    if (r.ok) expect(typeof r.money.amount).toBe('bigint');
  });

  const bad: Array<[string, string, Partial<Parameters<typeof parsePrice>[1]>?]> = [
    ['1.299', 'PRICE_AMBIGUOUS'],
    ['1,299', 'PRICE_AMBIGUOUS'],
    ['abc', 'PRICE_INVALID'],
    ['', 'PRICE_INVALID'],
    ['-5 TRY', 'PRICE_INVALID'],
    ['+5 TRY', 'PRICE_INVALID'],
    ['1.2.3,45', 'PRICE_INVALID'],
    ['1,23,456.00', 'PRICE_INVALID'],
    ['12.', 'PRICE_INVALID'],
    ['1299.905 TRY', 'PRICE_TOO_PRECISE'],
    ['12345678901234 TRY', 'PRICE_OUT_OF_RANGE'],
    ['0', 'PRICE_NOT_POSITIVE'],
    ['0,00 TL', 'PRICE_NOT_POSITIVE'],
    ['100 XYZ', 'CURRENCY_UNSUPPORTED'],
    ['$100 TRY', 'CURRENCY_CONFLICT'],
    ['100 TRY', 'CURRENCY_CONFLICT', { currencyField: 'USD' }],
    ['100', 'CURRENCY_MISSING', { defaultCurrency: null }],
    ['1.299,90', 'PRICE_SEPARATOR_MISMATCH', { separator: '.' }],
    ['1'.repeat(100), 'PRICE_INVALID'],
  ];
  it.each(bad)('%j → %s', (raw, code, over) => {
    expect(parsePrice(raw, opts(over))).toEqual({ ok: false, code });
  });

  it('configured separator resolves the "1.299" ambiguity', () => {
    expect(parsePrice('1.299', opts({ separator: ',' }))).toEqual({
      ok: true,
      money: { amount: 129900n, currency: 'TRY' },
    });
    expect(parsePrice('1.299', opts({ separator: '.' }))).toEqual({ ok: false, code: 'PRICE_TOO_PRECISE' });
  });

  it('explicit currency field is used when the price has no token', () => {
    expect(parsePrice('49,90', opts({ currencyField: 'TL', defaultCurrency: null }))).toEqual({
      ok: true,
      money: { amount: 4990n, currency: 'TRY' },
    });
  });
});

// ===========================================================================
// Text
// ===========================================================================

describe('feeds normalize: text', () => {
  it('keeps Turkish characters and composes to NFC', () => {
    expect(normalizeText('  Çağrı   Şimşek\tİĞÜÖ ığüşöç ')).toBe('Çağrı Şimşek İĞÜÖ ığüşöç');
    // "s" + COMBINING CEDILLA → "ş"
    expect(normalizeText('ş')).toBe('ş');
  });

  it('removes control / zero-width characters and empties to null', () => {
    expect(normalizeText('a\u0000b​c d')).toBe('a b c d');
    expect(normalizeText('   \n\t ')).toBeNull();
    expect(normalizeText(undefined)).toBeNull();
  });

  it('replaces lone surrogates', () => {
    expect(normalizeText('a\uD800b')).toBe('a�b');
  });

  it('truncates by code points without splitting surrogate pairs', () => {
    expect(truncateCodePoints('😀😀😀', 2)).toBe('😀😀');
    expect(truncateCodePoints('ğğğ', 5)).toBe('ğğğ');
  });
});

// ===========================================================================
// Identifiers / URLs / attributes
// ===========================================================================

describe('feeds normalize: GTIN', () => {
  it.each([
    ['4006381333931', '04006381333931'],
    ['400-6381 333931', '04006381333931'],
    ['96385074', '00000096385074'],
    ['036000291452', '00036000291452'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeGtin(raw)).toBe(expected);
  });

  it.each(['4006381333932', 'ABC4006381333', '12345', '00000000', ''])('%j → null', (raw) => {
    expect(normalizeGtin(raw)).toBeNull();
  });
});

describe('feeds normalize: URL policies', () => {
  const domain = 'shop.example.com';

  it('product URL: same domain and subdomains accepted', () => {
    expect(normalizeProductUrl('https://shop.example.com/p/1', domain)).toEqual({
      ok: true,
      href: 'https://shop.example.com/p/1',
    });
    expect(normalizeProductUrl('https://www.shop.example.com/p/1', domain).ok).toBe(true);
    expect(normalizeProductUrl('http://m.shop.example.com/p?id=1', domain).ok).toBe(true);
  });

  it.each([
    ['https://evil.com/p/1', 'URL_DOMAIN_MISMATCH'],
    ['https://evilshop.example.com/p/1', 'URL_DOMAIN_MISMATCH'],
    ['https://shop.example.com.evil.com/p', 'URL_DOMAIN_MISMATCH'],
    ['https://cdn.example.net/p/1', 'URL_DOMAIN_MISMATCH'],
    ['javascript:alert(1)', 'URL_SCHEME_NOT_ALLOWED'],
    ['data:text/html,<b>x</b>', 'URL_SCHEME_NOT_ALLOWED'],
    ['ftp://shop.example.com/p', 'URL_SCHEME_NOT_ALLOWED'],
    ['https://user:pw@shop.example.com/p', 'URL_CREDENTIALS_NOT_ALLOWED'],
    ['not a url', 'URL_INVALID'],
    [`https://shop.example.com/${'a'.repeat(2100)}`, 'URL_TOO_LONG'],
  ])('product URL %j → %s', (raw, code) => {
    expect(normalizeProductUrl(raw, domain)).toEqual({ ok: false, code });
  });

  it('image URL: external CDN host accepted (no merchant-domain requirement)', () => {
    expect(normalizeImageUrl('https://cdn.images-provider.net/a/b.jpg')).toEqual({
      ok: true,
      href: 'https://cdn.images-provider.net/a/b.jpg',
    });
  });

  it.each([
    ['javascript:alert(1)', 'URL_SCHEME_NOT_ALLOWED'],
    ['data:image/png;base64,AAAA', 'URL_SCHEME_NOT_ALLOWED'],
    ['https://u:p@cdn.example.net/x.jpg', 'URL_CREDENTIALS_NOT_ALLOWED'],
    [`https://cdn.example.net/${'a'.repeat(2100)}`, 'URL_TOO_LONG'],
  ])('image URL %j → %s', (raw, code) => {
    expect(normalizeImageUrl(raw)).toEqual({ ok: false, code });
  });
});

describe('feeds normalize: availability / stock / VAT', () => {
  it.each([
    ['in stock', 'IN_STOCK'],
    ['in_stock', 'IN_STOCK'],
    ['Stokta', 'IN_STOCK'],
    ['TÜKENDİ', 'OUT_OF_STOCK'],
    ['out of stock', 'OUT_OF_STOCK'],
    ['ön sipariş', 'PREORDER'],
    ['backorder', 'BACKORDER'],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeAvailability(raw, undefined)).toBe(expected);
  });

  // Regression (audit M1): Turkish-locale lower-casing turned English "I" into
  // dotless "ı" ("In Stock" → "ın stock"). Matching is locale-independent now.
  it.each([
    ['In Stock', 'IN_STOCK'],
    ['IN_STOCK', 'IN_STOCK'],
    ['IN STOCK', 'IN_STOCK'],
    ['InStock', 'IN_STOCK'],
    ['Out Of Stock', 'OUT_OF_STOCK'],
    ['Tükendi', 'OUT_OF_STOCK'],
    ['tükendi', 'OUT_OF_STOCK'],
    ['STOKTA VAR', 'IN_STOCK'],
    ['SATIŞTA', 'IN_STOCK'],
    ['Satışta', 'IN_STOCK'],
    ['ÖN SİPARİŞ', 'PREORDER'],
    ['Ön Sipariş', 'PREORDER'],
  ])('English + Turkish casing: %j → %s', (raw, expected) => {
    expect(normalizeAvailability(raw, undefined)).toBe(expected);
  });

  it.each([
    ['Included', true],
    ['INCLUDED', true],
    ['YES', true],
    ['EVET', true],
    ['KDV DAHİL', true],
    ['kdv dahil', true],
    ['HAYIR', false],
    ['Hayır', false],
    ['HARİÇ', false],
    ['Hariç', false],
    ['EXCLUDED', false],
  ])('boolean casing: %j → %s', (raw, expected) => {
    expect(normalizeBoolean(raw)).toBe(expected);
  });

  it('mapping override keys match regardless of casing / Turkish letters', () => {
    expect(normalizeAvailability('VAR', { Var: 'IN_STOCK' })).toBe('IN_STOCK');
    expect(normalizeAvailability('İndirimde', { indirimde: 'IN_STOCK' })).toBe('IN_STOCK');
    expect(normalizeAvailability('INDIRIMDE', { 'İndirimde': 'IN_STOCK' })).toBe('IN_STOCK');
  });

  it('mapping overrides win; unknown → null', () => {
    expect(normalizeAvailability('1', { '1': 'IN_STOCK', '0': 'OUT_OF_STOCK' })).toBe('IN_STOCK');
    expect(normalizeAvailability('maybe', undefined)).toBeNull();
  });

  it('stock, VAT and booleans', () => {
    expect(normalizeStock('15')).toBe(15);
    expect(normalizeStock('-1')).toBeNull();
    expect(normalizeStock('15 adet')).toBeNull();
    expect(normalizeVatRateBp('%20')).toBe(2000);
    expect(normalizeVatRateBp('18,5')).toBe(1850);
    expect(normalizeVatRateBp('101')).toBeNull();
    expect(normalizeBoolean('Evet')).toBe(true);
    expect(normalizeBoolean('HARİÇ')).toBe(false);
    expect(normalizeBoolean('belki')).toBeNull();
  });
});

// ===========================================================================
// Mapping
// ===========================================================================

describe('feeds normalize: mapping grammar', () => {
  const base = {
    itemElement: 'urun',
    fields: { externalId: 'urunkodu', title: 'urunadi', price: 'fiyat', url: 'link' },
  };

  it('accepts element, nested, attribute and prefixed paths', () => {
    const r = FeedItemMappingSchema.safeParse({
      ...base,
      fields: { ...base.fields, image: 'resimler/resim/@url', gtin: '@barkod', brand: 'g:brand' },
    });
    expect(r.success).toBe(true);
  });

  it.each([
    '//urun',
    'urun[1]',
    '../x',
    'a/@b/c',
    'a/b/c/d/e',
    '$(rm -rf /)',
    'a b',
    "concat('a','b')",
    '',
  ])('rejects non-grammar path %j', (path) => {
    expect(FeedItemMappingSchema.safeParse({ ...base, fields: { ...base.fields, title: path } }).success).toBe(false);
  });

  it('identity must be a single path (no fallback list)', () => {
    const r = FeedItemMappingSchema.safeParse({
      ...base,
      fields: { ...base.fields, externalId: ['urunkodu', 'sku'] },
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown keys and bad currency', () => {
    expect(FeedItemMappingSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(FeedItemMappingSchema.safeParse({ ...base, defaultCurrency: 'tl' }).success).toBe(false);
  });

  it('resolveFeedMapping: presets, required custom mapping, CSV unsupported', () => {
    expect(resolveFeedMapping('GOOGLE_MERCHANT_XML', null)).toEqual({ ok: true, mapping: GOOGLE_MERCHANT_PRESET });
    expect(resolveFeedMapping('CUSTOM_XML', null)).toMatchObject({ ok: false, code: 'MAPPING_REQUIRED' });
    expect(resolveFeedMapping('CUSTOM_XML', { itemElement: '//x' })).toMatchObject({
      ok: false,
      code: 'MAPPING_INVALID',
    });
    expect(resolveFeedMapping('CUSTOM_XML', base)).toMatchObject({ ok: true });
    expect(resolveFeedMapping('CSV', null)).toMatchObject({ ok: false, code: 'FORMAT_NOT_SUPPORTED' });
  });
});

// ===========================================================================
// Item normalization
// ===========================================================================

const CUSTOM: FeedItemMapping = FeedItemMappingSchema.parse({
  itemElement: 'urun',
  fields: {
    externalId: 'urunkodu',
    title: 'urunadi',
    price: 'fiyat',
    listPrice: 'eskifiyat',
    url: 'link',
    image: 'resim',
    sku: 'stokkodu',
    gtin: 'barkod',
    brand: 'marka',
    category: 'kategori',
    description: 'aciklama',
    stock: 'stok',
  },
  defaultCurrency: 'TRY',
  decimalSeparator: ',',
});

function raw(values: Record<string, string>, oversize: string[] = []): RawFeedItem {
  return { index: 0, values: new Map(Object.entries(values)), oversize: new Set(oversize), defect: null };
}

const CTX = { siteDomain: 'shop.example.com' };
const VALID = {
  urunkodu: 'A-1',
  urunadi: 'Çelik Tencere Seti 5 Parça',
  fiyat: '1.299,90',
  link: 'https://shop.example.com/urun/a-1',
};

describe('feeds normalize: normalizeFeedItem', () => {
  it('valid item with Turkish characters', () => {
    const r = normalizeFeedItem(raw({ ...VALID, marka: 'Ağaoğlu', stok: '3' }), CUSTOM, CTX);
    expect(r.kind).toBe('accepted');
    if (r.kind !== 'accepted') return;
    expect(r.offer).toMatchObject({
      externalId: 'A-1',
      title: 'Çelik Tencere Seti 5 Parça',
      brand: 'Ağaoğlu',
      price: { amount: 129990n, currency: 'TRY' },
      listPrice: null,
      availability: 'IN_STOCK',
      stockQuantity: 3,
    });
    expect(r.offer.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.warnings).toEqual([]);
  });

  it('missing optional fields are null, not errors', () => {
    const r = normalizeFeedItem(raw(VALID), CUSTOM, CTX);
    expect(r.kind).toBe('accepted');
    if (r.kind !== 'accepted') return;
    expect(r.offer).toMatchObject({
      sku: null,
      gtin: null,
      brand: null,
      description: null,
      imageUrl: null,
      availability: 'UNKNOWN',
      vatRateBp: null,
    });
  });

  it('external_id missing → rejected; NO fallback to SKU / GTIN', () => {
    const { urunkodu: _id, ...rest } = VALID;
    const r = normalizeFeedItem(raw({ ...rest, stokkodu: 'SKU-1', barkod: '4006381333931' }), CUSTOM, CTX);
    expect(r).toEqual({ kind: 'rejected', externalId: null, issue: { field: 'externalId', code: 'EXTERNAL_ID_MISSING' } });
  });

  it.each([
    ['urunadi', 'title', 'TITLE_MISSING'],
    ['fiyat', 'price', 'PRICE_MISSING'],
    ['link', 'url', 'URL_MISSING'],
  ])('missing required %s → %s rejected', (key, field, code) => {
    const values: Record<string, string> = { ...VALID };
    delete values[key];
    expect(normalizeFeedItem(raw(values), CUSTOM, CTX)).toMatchObject({ kind: 'rejected', issue: { field, code } });
  });

  it('malformed price → rejected', () => {
    expect(normalizeFeedItem(raw({ ...VALID, fiyat: 'bedava' }), CUSTOM, CTX)).toMatchObject({
      kind: 'rejected',
      externalId: 'A-1',
      issue: { field: 'price', code: 'PRICE_INVALID' },
    });
  });

  it('comma decimal price → correct minor units', () => {
    const r = normalizeFeedItem(raw({ ...VALID, fiyat: '49,9' }), CUSTOM, CTX);
    expect(r.kind === 'accepted' && r.offer.price).toEqual({ amount: 4990n, currency: 'TRY' });
  });

  it('list price kept only when higher than the current price', () => {
    const higher = normalizeFeedItem(raw({ ...VALID, eskifiyat: '1.499,90' }), CUSTOM, CTX);
    expect(higher.kind === 'accepted' && higher.offer.listPrice).toEqual({ amount: 149990n, currency: 'TRY' });
    const lower = normalizeFeedItem(raw({ ...VALID, eskifiyat: '999,90' }), CUSTOM, CTX);
    expect(lower.kind === 'accepted' && lower.offer.listPrice).toBeNull();
    expect(lower.kind === 'accepted' && lower.warnings).toContainEqual({ field: 'listPrice', code: 'LIST_PRICE_NOT_HIGHER' });
  });

  it('product URL on a foreign domain → rejected', () => {
    expect(normalizeFeedItem(raw({ ...VALID, link: 'https://other-shop.com/a-1' }), CUSTOM, CTX)).toMatchObject({
      kind: 'rejected',
      issue: { field: 'url', code: 'URL_DOMAIN_MISMATCH' },
    });
  });

  it('image URL on an external CDN → accepted', () => {
    const r = normalizeFeedItem(raw({ ...VALID, resim: 'https://cdn.cdnhost.net/i/a-1.jpg' }), CUSTOM, CTX);
    expect(r.kind === 'accepted' && r.offer.imageUrl).toBe('https://cdn.cdnhost.net/i/a-1.jpg');
  });

  it('invalid image URL → accepted with warning, image null', () => {
    const r = normalizeFeedItem(raw({ ...VALID, resim: 'javascript:alert(1)' }), CUSTOM, CTX);
    expect(r.kind).toBe('accepted');
    if (r.kind !== 'accepted') return;
    expect(r.offer.imageUrl).toBeNull();
    expect(r.warnings).toContainEqual({ field: 'image', code: 'URL_SCHEME_NOT_ALLOWED' });
  });

  it('oversized title → rejected; oversized description → truncated with warning', () => {
    expect(normalizeFeedItem(raw({ ...VALID, urunadi: 'x'.repeat(501) }), CUSTOM, CTX)).toMatchObject({
      kind: 'rejected',
      issue: { field: 'title', code: 'FIELD_TOO_LONG' },
    });
    expect(
      normalizeFeedItem(raw({ ...VALID, urunadi: 'x'.repeat(100) }, ['urunadi']), CUSTOM, CTX),
    ).toMatchObject({ kind: 'rejected', issue: { field: 'title', code: 'FIELD_TOO_LONG' } });

    const r = normalizeFeedItem(raw({ ...VALID, aciklama: 'ğ'.repeat(6000) }), CUSTOM, CTX);
    expect(r.kind).toBe('accepted');
    if (r.kind !== 'accepted') return;
    expect([...(r.offer.description ?? '')].length).toBe(5000);
    expect(r.warnings).toContainEqual({ field: 'description', code: 'FIELD_TRUNCATED' });
  });

  it('oversized external id → rejected', () => {
    expect(normalizeFeedItem(raw({ ...VALID, urunkodu: 'k'.repeat(257) }), CUSTOM, CTX)).toMatchObject({
      kind: 'rejected',
      issue: { field: 'externalId', code: 'FIELD_TOO_LONG' },
    });
  });

  it('invalid GTIN → warning only; valid GTIN normalized to 14 digits', () => {
    const bad = normalizeFeedItem(raw({ ...VALID, barkod: '123' }), CUSTOM, CTX);
    expect(bad.kind === 'accepted' && bad.warnings).toContainEqual({ field: 'gtin', code: 'GTIN_INVALID' });
    const good = normalizeFeedItem(raw({ ...VALID, barkod: '4006381333931' }), CUSTOM, CTX);
    expect(good.kind === 'accepted' && good.offer.gtin).toBe('04006381333931');
  });

  it('structural item defect → rejected with the defect code', () => {
    const item: RawFeedItem = { ...raw(VALID), defect: 'ITEM_TOO_MANY_ELEMENTS' };
    expect(normalizeFeedItem(item, CUSTOM, CTX)).toMatchObject({
      kind: 'rejected',
      externalId: 'A-1',
      issue: { field: 'item', code: 'ITEM_TOO_MANY_ELEMENTS' },
    });
  });

  it('content hash is deterministic and changes with price', () => {
    const a = normalizeFeedItem(raw(VALID), CUSTOM, CTX);
    const b = normalizeFeedItem(raw({ ...VALID, urunadi: `  ${VALID.urunadi}  ` }), CUSTOM, CTX);
    const c = normalizeFeedItem(raw({ ...VALID, fiyat: '1.199,90' }), CUSTOM, CTX);
    if (a.kind !== 'accepted' || b.kind !== 'accepted' || c.kind !== 'accepted') throw new Error('expected accepted');
    expect(b.offer.contentHash).toBe(a.offer.contentHash);
    expect(c.offer.contentHash).not.toBe(a.offer.contentHash);
  });

  it('Google preset: sale price becomes current price, regular price becomes list price', () => {
    const item = raw({
      'g:id': 'G1',
      'g:title': 'Kulaklık',
      'g:link': 'https://shop.example.com/g1',
      'g:price': '1499.90 TRY',
      'g:sale_price': '1299.90 TRY',
      'g:availability': 'in_stock',
      'g:image_link': 'https://cdn.example.net/g1.jpg',
    });
    const r = normalizeFeedItem(item, GOOGLE_MERCHANT_PRESET, CTX);
    expect(r.kind).toBe('accepted');
    if (r.kind !== 'accepted') return;
    expect(r.offer.price).toEqual({ amount: 129990n, currency: 'TRY' });
    expect(r.offer.listPrice).toEqual({ amount: 149990n, currency: 'TRY' });
    expect(r.offer.availability).toBe('IN_STOCK');
  });
});
