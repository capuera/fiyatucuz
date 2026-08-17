import { newId, transaction, type Db } from '@fiyatucuz/db';

import * as repo from './repository.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UserAlreadyExistsError extends Error {
  readonly code = 'USER_ALREADY_EXISTS' as const;
  constructor(public readonly emailNormalized: string) {
    super(`user already exists for email ${emailNormalized}`);
    this.name = 'UserAlreadyExistsError';
  }
}

export class UserNotFoundError extends Error {
  readonly code = 'USER_NOT_FOUND' as const;
  constructor(public readonly identifier: string) {
    super(`user not found: ${identifier}`);
    this.name = 'UserNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------
//
// Canonical lowercase only — no provider-specific rewrites (e.g. no Gmail
// dot-stripping, no plus-alias handling). Storing a normalized form separate
// from the display form lets us keep the user's original casing while
// enforcing case-insensitive uniqueness at the DB (UNIQUE on
// email_normalized).

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Service operations
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  readonly email: string;
  readonly displayName?: string | null;
}

/**
 * Create a new user. Rejects if the normalized email already exists.
 *
 * Auth flows (login, register, OAuth callback) that create users at
 * scale-up-of-account time are OUT OF SCOPE for this sprint — this exists as
 * the persistence-layer primitive those flows will call.
 */
export async function createUser(db: Db, input: CreateUserInput): Promise<repo.UserRow> {
  const emailNormalized = normalizeEmail(input.email);

  return transaction(db, async (tx) => {
    const existing = await repo.findUserByNormalizedEmail(tx, emailNormalized);
    if (existing) throw new UserAlreadyExistsError(emailNormalized);
    return repo.insertUser(tx, {
      id: newId(),
      email: input.email.trim(),
      emailNormalized,
      displayName: input.displayName ?? null,
      status: 'ACTIVE',
    });
  });
}

export async function findUserById(db: Db, id: string): Promise<repo.UserRow | null> {
  return transaction(db, (tx) => repo.findUserById(tx, id));
}

export async function findUserByEmail(db: Db, email: string): Promise<repo.UserRow | null> {
  const emailNormalized = normalizeEmail(email);
  return transaction(db, (tx) => repo.findUserByNormalizedEmail(tx, emailNormalized));
}
