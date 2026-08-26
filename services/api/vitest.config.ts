import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = (relative: string) => resolve(HERE, '../../packages', relative);

// Route workspace imports (`@fiyatucuz/db`, etc.) to their `src/*.ts` sources
// during tests. This preserves the fast dev loop (no `pnpm build` needed to
// run vitest) while the runtime `exports` map correctly points at compiled
// `dist/*` for production `node dist/index.js` in a consumer. We use
// `resolve.alias` here (targeted, one alias per workspace package) rather
// than `resolve.conditions`, because the latter would leak into third-party
// package resolution and break packages like `helmet` whose CJS/ESM entries
// are gated on condition order.
export default defineConfig({
  resolve: {
    alias: {
      '@fiyatucuz/db/schema': PKG('db/src/schema/index.ts'),
      '@fiyatucuz/db': PKG('db/src/index.ts'),
      '@fiyatucuz/config': PKG('config/src/index.ts'),
      '@fiyatucuz/types': PKG('types/src/index.ts'),
      '@fiyatucuz/validation': PKG('validation/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
