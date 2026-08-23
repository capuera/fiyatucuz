import { loadEnv } from '@fiyatucuz/config';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Coercions used across the schema
// ---------------------------------------------------------------------------

const BooleanishSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/**
 * Fastify `trustProxy` accepts boolean | number | string | string[] | function.
 * We support the boolean, hop-count, and comma-separated IP/CIDR list forms
 * from env. See ADIM 10.1 §Trust proxy for the deployment expectations
 * (Windows Server 2022 + IIS/ARR).
 */
const TrustProxySchema = z
  .string()
  .optional()
  .transform((raw): boolean | number | string[] => {
    if (raw === undefined || raw === '') return false;
    const s = raw.trim();
    if (s === 'false' || s === '0') return false;
    if (s === 'true') return true;
    // Numeric hop count (e.g. "1" for one reverse proxy in front of the app).
    if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
    // Comma-separated IP / CIDR allowlist.
    return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  });

/**
 * Comma-separated list of origins allowed by CORS. Production must supply an
 * explicit non-empty list; the server bootstrap enforces that separately so
 * an empty list here is not silently a wildcard.
 */
const CorsOriginsSchema = z
  .string()
  .optional()
  .transform((raw): string[] => {
    if (!raw) return [];
    return raw.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ApiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // DATABASE_URL (and its pool-tuning variables) is owned by @fiyatucuz/db via
  // loadDbEnv(). REDIS_URL is not consumed at foundation phase; a future
  // infrastructure package will own it. Kept optional here so a value in .env
  // does not fail boot.
  REDIS_URL: z.string().url().optional(),

  // -- HTTP hardening (ADIM 10.1) ----------------------------------------

  /**
   * Fastify trustProxy. Defaults to `false` (no forwarded-header trust);
   * set to `true`, a hop count (e.g. `1`), or a comma-separated IP/CIDR
   * allowlist when deploying behind a reverse proxy. See ADIM 10.1 docs for
   * Windows Server 2022 + IIS/ARR expectations.
   */
  API_TRUST_PROXY: TrustProxySchema,

  /**
   * Comma-separated CORS origin allowlist. Never a wildcard.
   * In production the server bootstrap requires this to be non-empty.
   */
  CORS_ALLOWED_ORIGINS: CorsOriginsSchema,

  /** Toggle rate-limiting entirely. Default on. */
  RATE_LIMIT_ENABLED: BooleanishSchema.default(true),

  /** Requests-per-window per client on the sensitive auth endpoints. */
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).max(1000).default(10),

  /**
   * Time window for RATE_LIMIT_AUTH_MAX. Accepts ms-friendly strings (e.g.
   * "1 minute", "10 seconds") — passed through to @fastify/rate-limit.
   */
  RATE_LIMIT_AUTH_TIMEWINDOW: z.string().min(1).default('1 minute'),

  /**
   * Rate limit for POST /v1/…/feeds/:feedId/fetch (ADIM 12.1). Manual feed
   * fetches enqueue a background job that touches an untrusted external URL;
   * we cap per-client to protect our own outbound bandwidth + prevent a
   * caller from spamming the JobQueue. Read endpoints are UNRESTRICTED.
   */
  RATE_LIMIT_FEED_FETCH_MAX: z.coerce.number().int().min(1).max(1000).default(5),
  RATE_LIMIT_FEED_FETCH_TIMEWINDOW: z.string().min(1).default('1 minute'),
});

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return loadEnv(ApiEnvSchema, source);
}
