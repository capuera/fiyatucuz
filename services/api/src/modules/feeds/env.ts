import { loadEnv } from '@fiyatucuz/config';
import { z } from 'zod';

/**
 * Feed-fetch environment (ADR-0016 §Fetch limits, §SSRF).
 *
 * FEED_FETCH_ALLOW_PRIVATE_ADDRESSES is a TEST-ONLY override that skips the
 * private-IP / loopback / metadata-endpoint checks so integration tests can
 * spin up an HTTP server on 127.0.0.1. Boot fails when NODE_ENV=production
 * and this is true — enforced by assertProductionFeedFetchSafety() below.
 */
const BooleanishSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const FeedEnvSchema = z.object({
  FEED_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  FEED_FETCH_MAX_BYTES: z.coerce.number().int().min(1024).max(1024 * 1024 * 1024).default(50 * 1024 * 1024),
  FEED_FETCH_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  FEED_FETCH_USER_AGENT: z.string().min(1).max(200).default('FiyatUcuzFeedBot/1.0'),
  FEED_FETCH_ALLOW_PRIVATE_ADDRESSES: BooleanishSchema.default(false),
});

export type FeedEnv = z.infer<typeof FeedEnvSchema>;

export function loadFeedEnv(source: Record<string, string | undefined> = process.env): FeedEnv {
  return loadEnv(FeedEnvSchema, source);
}

export class InsecureProductionFeedFetchError extends Error {
  readonly code = 'INSECURE_PRODUCTION_FEED_FETCH' as const;
  constructor() {
    super(
      'FEED_FETCH_ALLOW_PRIVATE_ADDRESSES must NOT be true when NODE_ENV=production. ' +
        'That flag is for tests only; production must reject private/loopback/metadata targets.',
    );
    this.name = 'InsecureProductionFeedFetchError';
  }
}

export function assertProductionFeedFetchSafety(env: FeedEnv, nodeEnv: string): void {
  if (nodeEnv === 'production' && env.FEED_FETCH_ALLOW_PRIVATE_ADDRESSES === true) {
    throw new InsecureProductionFeedFetchError();
  }
}
