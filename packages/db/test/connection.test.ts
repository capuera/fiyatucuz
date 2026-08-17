import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../src/index.js';

import { isPostgresReachable, makeTestDbHandle } from './helpers.js';

const reachable = await isPostgresReachable();

describe.skipIf(!reachable)('connection (integration — requires local PostgreSQL)', () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = makeTestDbHandle();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('SELECT 1 returns 1', async () => {
    const rows = await handle.db.execute(sql`select 1 as one`);
    // postgres-js returns an array-like of row objects.
    const first = rows[0] as { one: number } | undefined;
    expect(first?.one).toBe(1);
  });

  it('reports the PostgreSQL server version', async () => {
    const rows = await handle.db.execute(sql`select current_setting('server_version') as v`);
    const first = rows[0] as { v: string } | undefined;
    expect(first?.v).toMatch(/^\d+/);
  });
});

if (!reachable) {
  console.warn(
    '[@fiyatucuz/db] connection.test.ts: skipping integration tests — PostgreSQL not reachable.',
  );
}
