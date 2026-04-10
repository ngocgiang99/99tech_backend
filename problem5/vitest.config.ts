import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Coverage gate applies only to files that have (or should have) a
      // unit-level test. Wiring, repositories, routers, HTTP handlers, and
      // bootstrap code are exercised end-to-end by the integration layer
      // (`pnpm test:integration`) and do not need duplicate unit tests.
      // Keep this list focused on pure-logic modules.
      include: [
        'src/lib/errors.ts',
        'src/middleware/error-handler.ts',
        'src/cache/singleflight.ts',
        'src/modules/resources/schema.ts',
        'src/modules/resources/cursor.ts',
        'src/modules/resources/cache-keys.ts',
      ],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 80,
      },
      reportsDirectory: './coverage',
    },
  },
});
