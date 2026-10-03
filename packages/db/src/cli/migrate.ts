import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMigrationCli } from './run-migrations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// From src/cli/  and dist/cli/ alike, `../../drizzle` resolves to
// packages/db/drizzle/ — the hand-written migration folder.
const MIGRATIONS_DIR = resolve(HERE, '..', '..', 'drizzle');

// Connection: DATABASE_MIGRATION_URL + DATABASE_MIGRATION_EXPECTED_DB only;
// DATABASE_URL (API runtime credential) is never used. See migration-env.ts.
void runMigrationCli({
  argv: process.argv.slice(2),
  env: process.env,
  migrationsDir: MIGRATIONS_DIR,
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    // runMigrationCli handles its own errors; this only guarantees that an
    // unexpected rejection never reaches Node's default handler, which would
    // print the raw error object (unsanitized).
    process.stderr.write('[db:migrate] failed: unexpected error\n');
    process.exitCode = 1;
  },
);
