import { loadEnv } from '@fiyatucuz/config';
import { z } from 'zod';

/**
 * Authentication environment.
 *
 * AUTH_TOKEN_HMAC_SECRET is required in every environment: it is the HMAC key
 * used to derive the values stored in `sessions.session_token_hash` and
 * `refresh_tokens.token_hash` from the raw opaque tokens that live in cookies.
 * DB compromise alone yields the hashes, not the raw tokens; without the
 * secret, the hashes cannot be recomputed to validate a leaked cookie.
 *
 * Rotate the secret only during a maintenance window: every existing session
 * and refresh token becomes invalid on rotation (their hashes no longer
 * match). That is by design.
 */
const AuthEnvSchema = z.object({
  AUTH_TOKEN_HMAC_SECRET: z
    .string()
    .min(32, 'AUTH_TOKEN_HMAC_SECRET must be at least 32 characters'),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(30 * 24 * 3600).default(24 * 3600),
  AUTH_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(180 * 24 * 3600)
    .default(30 * 24 * 3600),
  // In dev over http we cannot set the Secure attribute; production must always be true.
  AUTH_COOKIE_SECURE: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  AUTH_COOKIE_DOMAIN: z.string().optional(),

  // OAuth foundation — placeholders. Present so the schema documents the
  // contract; providers throw NotImplementedError until a later sprint wires
  // real callback flows.
  AUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  AUTH_APPLE_CLIENT_ID: z.string().optional(),
  AUTH_APPLE_TEAM_ID: z.string().optional(),
  AUTH_APPLE_KEY_ID: z.string().optional(),
  AUTH_APPLE_PRIVATE_KEY: z.string().optional(),
});

export type AuthEnv = z.infer<typeof AuthEnvSchema>;

export function loadAuthEnv(source: Record<string, string | undefined> = process.env): AuthEnv {
  return loadEnv(AuthEnvSchema, source);
}

/**
 * Boot-time assertion (ADIM 10.1 §Production cookie security).
 *
 * If NODE_ENV === 'production' the session/refresh cookies MUST be marked
 * Secure, otherwise a proxy or intermediate can read them. Development and
 * test continue to work with AUTH_COOKIE_SECURE=false.
 *
 * Deliberately throws — never silently overrides — so that a
 * misconfiguration is a hard boot failure rather than a runtime security
 * regression noticed months later.
 */
export class InsecureProductionCookieError extends Error {
  readonly code = 'INSECURE_PRODUCTION_COOKIE' as const;
  constructor() {
    super(
      'AUTH_COOKIE_SECURE must be true when NODE_ENV=production. ' +
        'Set AUTH_COOKIE_SECURE=true (production must serve over HTTPS).',
    );
    this.name = 'InsecureProductionCookieError';
  }
}

export function assertProductionCookieSecurity(
  authEnv: AuthEnv,
  nodeEnv: string,
): void {
  if (nodeEnv === 'production' && authEnv.AUTH_COOKIE_SECURE !== true) {
    throw new InsecureProductionCookieError();
  }
}
