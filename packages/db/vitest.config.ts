import { defineConfig } from 'vitest/config';

export default defineConfig({
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
