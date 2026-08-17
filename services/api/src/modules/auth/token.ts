import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque token generation + HMAC hashing.
 *
 * Session and refresh tokens are 256-bit random values encoded as base64url
 * (43 chars). The raw value lives ONLY in the client's cookie. The DB stores
 * the HMAC-SHA256 of the raw value, keyed by AUTH_TOKEN_HMAC_SECRET.
 *
 * Consequences of this design:
 *   - DB dump alone cannot forge or validate cookies (the HMAC key is server-
 *     side).
 *   - Rotating the secret invalidates every session/refresh row at once
 *     (their stored hashes no longer match). Intentional; rotate during
 *     maintenance.
 *   - Verification is constant-time via crypto.timingSafeEqual so a byte-
 *     compare timing side channel cannot narrow the search.
 */

const RAW_TOKEN_BYTES = 32; // 256 bits
const HASH_BYTES = 32; // sha256 output

export function generateRawToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString('base64url');
}

export function hashToken(rawToken: string, secret: string): string {
  return createHmac('sha256', secret).update(rawToken).digest('base64url');
}

/**
 * Constant-time comparison between a raw token supplied by the caller and a
 * stored HMAC hash. Used indirectly by every DB lookup path (we compute the
 * HMAC of the presented raw token and query by hash), but exposed for the
 * rare case where a caller has two hashes to compare defensively.
 */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Sanity checks the module can enforce at import time — misconfigured secret
// length is a boot-time failure surface, not runtime.
export function assertSecretShape(secret: string): void {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('AUTH_TOKEN_HMAC_SECRET must be at least 32 characters');
  }
}

// Convenience: hash bytes are known-size (32 bytes → 43-char base64url).
// Never used for authentication comparison directly; provided so tests can
// assert cryptographic shape.
export const RAW_TOKEN_BYTES_LENGTH = RAW_TOKEN_BYTES;
export const HASH_BYTES_LENGTH = HASH_BYTES;
