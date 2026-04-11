import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ['tests/integration/fixtures/containers.ts'],
    // Integration tests share a single Postgres + Redis pair per run and
    // rely on TRUNCATE between tests — running files in parallel would
    // interleave data and break isolation.
    fileParallelism: false,
    reporters: ['default'],
  },
});
