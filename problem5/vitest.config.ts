import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      // Measure every source file the unit suite touches. Wiring, routers,
      // controllers, repositories, and bootstrap code are exercised by the
      // integration layer (`pnpm test:integration`) instead — they are
      // listed below so the unit report does not penalise them with 0%.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        // Bootstrap / process entry — integration-only.
        'src/app.ts',
        'src/index.ts',
        // Express wiring — integration-only.
        'src/http/app.ts',
        'src/http/routes/**',
        // Driver clients and health probes — integration-only.
        'src/infrastructure/db/client.ts',
        'src/infrastructure/db/health.ts',
        'src/infrastructure/cache/client.ts',
        'src/infrastructure/cache/health.ts',
        // Trivial Express middleware (request-id, x-cache header stamp)
        // and the module factory — integration-only.
        'src/middleware/request-id.ts',
        'src/middleware/x-cache.ts',
        'src/modules/resources/index.ts',
        // Presentation + repository layers — integration-only.
        'src/modules/resources/presentation/**',
        'src/modules/resources/infrastructure/repository.ts',
        'src/modules/resources/infrastructure/cached-repository.ts',
        'src/modules/resources/application/service.ts',
        'src/modules/resources/application/request-context.ts',
        // Bootstrap primitives.
        'src/shared/health.ts',
        'src/shared/shutdown.ts',
        'src/shared/logger.ts',
        'src/shared/log-with-metadata.ts',
        // Observability collectors that need a real pool / DB.
        'src/observability/db-metrics.ts',
        'src/observability/db-pool-gauge.ts',
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
      reportsDirectory: './coverage',
    },
  },
});
