import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
