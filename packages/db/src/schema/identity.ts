import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  inet,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// -- Enums --------------------------------------------------------------------

export const userStatus = pgEnum('user_status', ['ACTIVE', 'SUSPENDED', 'DEACTIVATED']);
export const oauthProvider = pgEnum('oauth_provider', ['google', 'apple']);

// -- users --------------------------------------------------------------------
//
// Global identity record. Not tenant-scoped: a single human is one `users`
// row regardless of how many tenants they belong to (see tenant_users).

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull().unique('users_email_normalized_unique'),
  displayName: text('display_name'),
  status: userStatus('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// -- credentials --------------------------------------------------------------
//
// Local (password) authentication. One active row per user — that is why
// user_id is UNIQUE, not merely FK-indexed. The password_hash column is the
// output of an application-layer Argon2id hash (to be implemented in a later
// sprint); the database never sees plaintext.

export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique('credentials_user_id_unique')
    .references(() => users.id, { onDelete: 'restrict' }),
  passwordHash: text('password_hash').notNull(),
  passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// -- oauth_identities ---------------------------------------------------------
//
// Links external identity providers (Google, Apple) to users. The provider's
// stable account id is authoritative — email at the provider is stored for
// bookkeeping only, not for lookup.

export const oauthIdentities = pgTable(
  'oauth_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    provider: oauthProvider('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    emailAtProvider: text('email_at_provider'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    providerAccountUnique: unique('oauth_identities_provider_account_unique').on(
      t.provider,
      t.providerAccountId,
    ),
    userIdIdx: index('oauth_identities_user_id_idx').on(t.userId),
  }),
);

// -- sessions -----------------------------------------------------------------
//
// A login session. session_token_hash stores an HMAC/SHA hash of the opaque
// session token that lives in the client cookie; the raw token never touches
// the database. Sessions are revocable (revoked_at) and time-bounded
// (expires_at). We record user_agent/ip_address for auditability.

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sessionTokenHash: text('session_token_hash').notNull().unique('sessions_token_hash_unique'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    userAgent: text('user_agent'),
    ipAddress: inet('ip_address'),
  },
  (t) => ({
    userIdIdx: index('sessions_user_id_idx').on(t.userId),
    // expires_at is used by the sweeper job that revokes/purges expired
    // sessions; indexed to keep that scan cheap even at scale.
    expiresAtIdx: index('sessions_expires_at_idx').on(t.expiresAt),
  }),
);

// -- refresh_tokens -----------------------------------------------------------
//
// Rotating refresh tokens. token_hash stores an HMAC/SHA hash of the opaque
// token; raw tokens never persist. replaced_by_token_id forms a rotation
// chain used for reuse-detection (if a supposedly-replaced token is presented
// again, we revoke the whole family — that logic lives in the auth service,
// added in a later sprint).
//
// Self-reference uses ON DELETE SET NULL so a mid-chain purge does not
// cascade backwards and destroy history.

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique('refresh_tokens_token_hash_unique'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    replacedByTokenId: uuid('replaced_by_token_id').references(
      (): AnyPgColumn => refreshTokens.id,
      { onDelete: 'set null' },
    ),
  },
  (t) => ({
    sessionIdIdx: index('refresh_tokens_session_id_idx').on(t.sessionId),
    expiresAtIdx: index('refresh_tokens_expires_at_idx').on(t.expiresAt),
  }),
);
