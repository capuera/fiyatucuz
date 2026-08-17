import { z } from 'zod';

// Foundation Zod schemas. Domain schemas belong to their bounded context.

/** Canonical 26-char Crockford-Base32 ULID. */
export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ULID');

export const EmailSchema = z.string().email().max(320);

/** ISO 4217 3-letter currency code (uppercase). */
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

/** Money in minor units. `amount` is a bigint so JSON boundaries must serialize as string. */
export const MoneySchema = z.object({
  amount: z.bigint(),
  currency: CurrencyCodeSchema,
});

/** Standard pagination request. */
export const PageRequestSchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/** Standard API error envelope on the wire. */
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  requestId: z.string().optional(),
});

export type UlidInput = z.infer<typeof UlidSchema>;
export type MoneyInput = z.infer<typeof MoneySchema>;
export type PageRequestInput = z.infer<typeof PageRequestSchema>;
export type ApiErrorInput = z.infer<typeof ApiErrorSchema>;
