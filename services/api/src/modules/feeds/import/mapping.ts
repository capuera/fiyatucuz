/**
 * Feed item mapping (ADR-0018 §Mapping).
 *
 * A mapping tells the streaming extractor which element is "one item" and
 * where each offer field lives inside it. Paths are a deliberately tiny
 * grammar — NOT XPath:
 *
 *   path     := segment ( "/" segment ){0,3}
 *   segment  := name | "@" name          ("@name" only as the last segment)
 *   name     := NCName ( ":" NCName )?   (literal prefix, e.g. "g:price")
 *
 * Paths are relative to the item element ("@id" = attribute on the item
 * itself). They are only ever compared as strings against parser events;
 * no mapping value is used as an SQL identifier, a filesystem path, or an
 * executable expression.
 */

import { CurrencyCodeSchema } from '@fiyatucuz/validation';
import { z } from 'zod';

import type { FeedFormat } from '../repository.js';

const NAME_SRC = '[A-Za-z_][A-Za-z0-9_.-]{0,63}(?::[A-Za-z_][A-Za-z0-9_.-]{0,63})?';
const NAME_RE = new RegExp(`^${NAME_SRC}$`);
const PATH_RE = new RegExp(`^(?:${NAME_SRC}/){0,3}@?${NAME_SRC}$`);
const MAX_PATH_SEGMENTS = 4;
/** Serialized size cap; the DB CHECK (16 KiB) is a looser backstop. */
const MAX_MAPPING_JSON_CHARS = 8192;

export const MappingNameSchema = z.string().max(129).regex(NAME_RE, 'invalid element name');

export const MappingPathSchema = z
  .string()
  .max(520)
  .regex(PATH_RE, 'invalid mapping path')
  .refine((p) => p.split('/').length <= MAX_PATH_SEGMENTS, 'mapping path too deep');

/** One path, or an ordered list whose first non-empty value wins. */
const PathListSchema = z
  .union([MappingPathSchema, z.array(MappingPathSchema).min(1).max(4)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const OFFER_AVAILABILITY_VALUES = [
  'IN_STOCK',
  'OUT_OF_STOCK',
  'PREORDER',
  'BACKORDER',
  'UNKNOWN',
] as const;
export type OfferAvailability = (typeof OFFER_AVAILABILITY_VALUES)[number];

export const DECIMAL_SEPARATORS = ['.', ',', 'auto'] as const;
export type DecimalSeparator = (typeof DECIMAL_SEPARATORS)[number];

export const FeedItemMappingSchema = z
  .object({
    itemElement: MappingNameSchema,
    fields: z
      .object({
        // Identity: exactly ONE path. No fallback list — an item whose
        // identity path is empty is rejected (ADR-0018 §Identity).
        externalId: MappingPathSchema,
        title: PathListSchema,
        price: PathListSchema,
        url: PathListSchema,
        salePrice: PathListSchema.optional(),
        listPrice: PathListSchema.optional(),
        currency: PathListSchema.optional(),
        sku: PathListSchema.optional(),
        gtin: PathListSchema.optional(),
        brand: PathListSchema.optional(),
        category: PathListSchema.optional(),
        description: PathListSchema.optional(),
        image: PathListSchema.optional(),
        availability: PathListSchema.optional(),
        stock: PathListSchema.optional(),
        vatRate: PathListSchema.optional(),
        vatIncluded: PathListSchema.optional(),
      })
      .strict(),
    defaultCurrency: CurrencyCodeSchema.optional(),
    decimalSeparator: z.enum(DECIMAL_SEPARATORS).default('auto'),
    vatIncludedDefault: z.boolean().optional(),
    availabilityValues: z
      .record(z.string().trim().min(1).max(64), z.enum(OFFER_AVAILABILITY_VALUES))
      .refine((r) => Object.keys(r).length <= 50, 'too many availability values')
      .optional(),
  })
  .strict()
  .refine(
    (m) => JSON.stringify(m).length <= MAX_MAPPING_JSON_CHARS,
    `item mapping exceeds ${MAX_MAPPING_JSON_CHARS} characters`,
  );

/** Wire/storage shape (before defaults are applied). */
export type FeedItemMappingInput = z.input<typeof FeedItemMappingSchema>;
/** Validated shape used by the extractor and normalizer. */
export type FeedItemMapping = z.output<typeof FeedItemMappingSchema>;
export type MappedField = keyof FeedItemMapping['fields'];

/**
 * GOOGLE_MERCHANT_XML preset (RSS 2.0 + `g:` namespace prefix).
 * `decimalSeparator: 'auto'` accepts both "1299.90 TRY" (spec) and the
 * "1.299,90 TRY" form common in Turkish feeds; an ambiguous "1.299" is
 * rejected rather than guessed.
 */
export const GOOGLE_MERCHANT_PRESET: FeedItemMapping = FeedItemMappingSchema.parse({
  itemElement: 'item',
  fields: {
    externalId: 'g:id',
    title: ['g:title', 'title'],
    description: ['g:description', 'description'],
    url: ['g:link', 'link'],
    image: 'g:image_link',
    price: 'g:price',
    salePrice: 'g:sale_price',
    gtin: 'g:gtin',
    brand: 'g:brand',
    category: ['g:product_type', 'g:google_product_category'],
    availability: 'g:availability',
  },
  decimalSeparator: 'auto',
} satisfies FeedItemMappingInput);

export type MappingResolution =
  | { readonly ok: true; readonly mapping: FeedItemMapping }
  | { readonly ok: false; readonly code: 'MAPPING_REQUIRED' | 'MAPPING_INVALID' | 'FORMAT_NOT_SUPPORTED'; readonly message: string };

/**
 * Resolve the effective mapping for a feed. CUSTOM_XML requires a stored
 * mapping, re-validated here (defense in depth: the column could predate a
 * schema tightening). CSV is out of scope for ADIM 14.
 */
export function resolveFeedMapping(format: FeedFormat, stored: unknown): MappingResolution {
  if (format === 'GOOGLE_MERCHANT_XML') return { ok: true, mapping: GOOGLE_MERCHANT_PRESET };
  if (format === 'CUSTOM_XML') {
    if (stored === null || stored === undefined) {
      return { ok: false, code: 'MAPPING_REQUIRED', message: 'CUSTOM_XML feed has no item mapping' };
    }
    const parsed = FeedItemMappingSchema.safeParse(stored);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'MAPPING_INVALID',
        message: parsed.error.issues[0]?.message ?? 'invalid item mapping',
      };
    }
    return { ok: true, mapping: parsed.data };
  }
  return { ok: false, code: 'FORMAT_NOT_SUPPORTED', message: `${format} import is not supported yet` };
}

/** Every distinct path referenced by the mapping — the extractor captures only these. */
export function mappingPaths(mapping: FeedItemMapping): ReadonlySet<string> {
  const out = new Set<string>();
  for (const value of Object.values(mapping.fields)) {
    if (value === undefined) continue;
    for (const p of Array.isArray(value) ? value : [value]) out.add(p);
  }
  return out;
}
