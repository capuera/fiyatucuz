import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = (relative: string) => resolve(HERE, '..', relative);

// See services/api/vitest.config.ts for the rationale — targeted aliases so
// workspace imports resolve to `src/*.ts` in tests without disturbing
// third-party package resolution conditions.
export default defineConfig({
  resolve: {
    alias: {
      '@fiyatucuz/config': PKG('config/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration tests hit real PostgreSQL — serialize them so a shared local
    // container is not overwhelmed and so that transaction assertions are not
    // interleaved with unrelated queries.
    fileParallelism: false,
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
