import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDbHandle } from '../client.js';
import { loadDbEnv } from '../env.js';
import { applyMigrations } from '../migrator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// From src/cli/  and dist/cli/ alike, `../../drizzle` resolves to
// packages/db/drizzle/ — the hand-written migration folder.
const MIGRATIONS_DIR = resolve(HERE, '..', '..', 'drizzle');

async function main(): Promise<void> {
  const env = loadDbEnv();
  const handle = createDbHandle(env);
  try {
    const result = await applyMigrations(handle.sql, MIGRATIONS_DIR);
    if (result.applied.length === 0) {
      console.warn(
        `[db:migrate] Nothing to apply. ${result.skipped.length} migration(s) already recorded.`,
      );
    } else {
      for (const id of result.applied) {
        console.warn(`[db:migrate] Applied ${id}`);
      }
      console.warn(
        `[db:migrate] Done: ${result.applied.length} applied, ${result.skipped.length} skipped.`,
      );
    }
  } finally {
    await handle.close();
  }
}

void main().catch((err) => {
  console.error('[db:migrate] failed:', err);
  process.exit(1);
});
