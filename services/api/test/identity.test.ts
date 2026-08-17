import { newId } from '@fiyatucuz/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createUser,
  findUserByEmail,
  findUserById,
  identityRepository,
  normalizeEmail,
  UserAlreadyExistsError,
} from '../src/modules/identity/index.js';

import { isPostgresReachable, makeTestDbHandle, truncateIdentityAndTenants } from './helpers.js';

const reachable = await isPostgresReachable();

describe('identity — normalizeEmail (unit)', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
  });

  it('does not apply Gmail-specific rewrites (no dot removal, no plus alias stripping)', () => {
    // Only canonical lowercase is applied — per ADR-0013 no provider-specific normalization.
    expect(normalizeEmail('First.Last+work@Gmail.com')).toBe('first.last+work@gmail.com');
  });
});

describe.skipIf(!reachable)(
  'identity — repository + service (integration; requires PostgreSQL)',
  () => {
    const handle = makeTestDbHandle();

    beforeAll(async () => {
      await truncateIdentityAndTenants(handle.sql);
    });

    afterEach(async () => {
      await truncateIdentityAndTenants(handle.sql);
    });

    afterAll(async () => {
      await handle.close();
    });

    it('createUser inserts a row and returns it', async () => {
      const created = await createUser(handle.db, {
        email: 'Alice@Example.com',
        displayName: 'Alice',
      });

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.email).toBe('Alice@Example.com');
      expect(created.emailNormalized).toBe('alice@example.com');
      expect(created.status).toBe('ACTIVE');
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
    });

    it('createUser rejects duplicate normalized email (case-insensitive)', async () => {
      await createUser(handle.db, { email: 'dup@example.com' });
      await expect(
        createUser(handle.db, { email: 'DUP@Example.COM' }),
      ).rejects.toBeInstanceOf(UserAlreadyExistsError);
    });

    it('findUserById returns the row', async () => {
      const created = await createUser(handle.db, { email: 'find@example.com' });
      const found = await findUserById(handle.db, created.id);
      expect(found?.id).toBe(created.id);
    });

    it('findUserByEmail is case-insensitive', async () => {
      await createUser(handle.db, { email: 'MixedCase@Example.com' });
      const found = await findUserByEmail(handle.db, 'mixedcase@EXAMPLE.com');
      expect(found?.emailNormalized).toBe('mixedcase@example.com');
    });

    it('inserting credentials stores only the hash (fixture never contains plaintext)', async () => {
      const user = await createUser(handle.db, { email: 'creds@example.com' });
      const opaqueHash = 'argon2id$test$hashvalue'; // fixture — NOT a real password
      const cred = await handle.db.transaction((tx) =>
        identityRepository.insertCredential(tx, {
          id: newId(),
          userId: user.id,
          passwordHash: opaqueHash,
        }),
      );
      expect(cred.passwordHash).toBe(opaqueHash);
      expect(cred.passwordHash).not.toMatch(/password|secret|plaintext/i);
    });

    it('inserting a session stores only session_token_hash (no raw token in the fixture)', async () => {
      const user = await createUser(handle.db, { email: 'sess@example.com' });
      const hash = 'hmac-sha256:test-hash';
      const session = await handle.db.transaction((tx) =>
        identityRepository.insertSession(tx, {
          id: newId(),
          userId: user.id,
          sessionTokenHash: hash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
      );
      expect(session.sessionTokenHash).toBe(hash);
      expect(Object.keys(session)).not.toContain('session_token');
      expect(Object.keys(session)).not.toContain('sessionToken');
    });

    it('user deactivation preserves related credential/session history', async () => {
      const user = await createUser(handle.db, { email: 'deact@example.com' });

      await handle.db.transaction(async (tx) => {
        await identityRepository.insertCredential(tx, {
          id: newId(),
          userId: user.id,
          passwordHash: 'argon2id$fixture$hash',
        });
        await identityRepository.insertSession(tx, {
          id: newId(),
          userId: user.id,
          sessionTokenHash: 'sess-hash',
          expiresAt: new Date(Date.now() + 60_000),
        });
      });

      // Deactivate (status change, NOT DELETE).
      await handle.sql`update users set status = 'DEACTIVATED' where id = ${user.id}`;

      // History remains.
      const cred = await handle.db.transaction((tx) =>
        identityRepository.findCredentialByUserId(tx, user.id),
      );
      expect(cred).not.toBeNull();

      // Physical DELETE is blocked by ON DELETE RESTRICT.
      await expect(
        handle.sql`delete from users where id = ${user.id}`,
      ).rejects.toThrow(/foreign key|violates|restrict/i);
    });
  },
);

if (!reachable) {
  console.warn('[@fiyatucuz/api] identity.test.ts: skipping integration tests — PG unreachable.');
}
