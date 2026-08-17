import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Options } from '@node-rs/argon2';

/**
 * Password hashing wrapper.
 *
 * Argon2id parameters follow OWASP 2023 guidance for interactive login
 * (m=19456, t=2, p=1). @node-rs/argon2 is a pure-Rust binding that avoids
 * the native-C toolchain fragility of the classic `argon2` package while
 * exposing the same primitives.
 *
 * The database stores ONLY the encoded hash string. The application NEVER
 * reads or writes plaintext passwords beyond the millisecond window of the
 * hash/verify call. Callers must not log arguments to hash/verify.
 */

// Password policy: 8..128 chars. Upper bound prevents Argon2id DoS via huge
// inputs (hashing 1MiB of "password" takes non-trivial CPU). Enforced at the
// service boundary; also asserted here defensively so no repository could
// bypass by calling password.ts directly.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

// Argon2id = 2 per RFC 9106. @node-rs/argon2 exports Algorithm as an ambient
// const enum which our verbatimModuleSyntax setup cannot dereference; the
// numeric spec value is stable.
const ARGON2_PARAMS: Options = {
  algorithm: 2 as NonNullable<Options['algorithm']>,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export class WeakPasswordError extends Error {
  readonly code = 'WEAK_PASSWORD' as const;
  constructor(message = 'password fails length policy') {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

function assertLengthPolicy(password: string): void {
  if (typeof password !== 'string') throw new WeakPasswordError('password must be a string');
  if (password.length < PASSWORD_MIN_LENGTH) throw new WeakPasswordError('password too short');
  if (password.length > PASSWORD_MAX_LENGTH) throw new WeakPasswordError('password too long');
}

export async function hashPassword(password: string): Promise<string> {
  assertLengthPolicy(password);
  return argon2Hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  // Length-cap defensively so we don't hash-verify a 1MiB attacker input; a
  // string that fails length policy cannot match any well-formed stored hash
  // anyway.
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    return false;
  }
  try {
    return await argon2Verify(hash, password);
  } catch {
    // A malformed stored hash or verifier error MUST NOT surface as an
    // "unauthorized" that looks different from wrong-password; return false.
    return false;
  }
}

// A pre-computed dummy hash used to normalize login timing when the requested
// account does not exist. Callers on the user-not-found branch should still
// verify against this dummy so the response-time signal cannot be used to
// enumerate registered emails.
//
// Cached at module load; regenerated per process lifetime is fine.
let DUMMY_HASH: string | null = null;
export async function getDummyPasswordHash(): Promise<string> {
  if (DUMMY_HASH) return DUMMY_HASH;
  // The plaintext is discarded immediately. The point is only to produce a
  // hash-shaped string of comparable verify cost.
  DUMMY_HASH = await argon2Hash('__dummy_password_do_not_use__', ARGON2_PARAMS);
  return DUMMY_HASH;
}
