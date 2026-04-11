import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  coverageDirectory: 'coverage/unit',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/shared/metrics/**',
    '!src/shared/tracing/**',
    '!src/scoreboard/**/index.ts',
    '!src/scoreboard/domain/ports/**',
    '!src/database/**',
    '!src/config/index.ts',
    // Infrastructure adapters that require real DB/Redis — covered by integration tests
    '!src/scoreboard/infrastructure/persistence/**',
    // NATS messaging infrastructure — requires real NATS; covered by integration tests
    '!src/scoreboard/infrastructure/messaging/nats/stream-bootstrap.ts',
    '!src/scoreboard/infrastructure/messaging/nats/nats.client.ts',
    '!src/scoreboard/infrastructure/messaging/nats/leaderboard-updates.emitter.ts',
    '!src/scoreboard/infrastructure/messaging/nats/jetstream.subscriber.ts',
    // Outbox publisher — requires real Postgres + Redis; covered by integration tests
    '!src/scoreboard/infrastructure/outbox/outbox.publisher.service.ts',
    // SSE controller — requires live HTTP + emitter; covered by integration tests
    '!src/scoreboard/interface/http/controllers/leaderboard-stream.controller.ts',
    // NestJS app-bootstrap wiring — cannot be meaningfully unit-tested
    '!src/shared/logger/index.ts',
    '!src/shared/logger/request-id.hook.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 80,
      branches: 80,
      functions: 80,
      statements: 80,
    },
    'src/scoreboard/domain/**/*.ts': {
      lines: 100,
      branches: 100,
      functions: 100,
      statements: 100,
    },
    // Error primitives — single source of truth for HTTP error surface.
    // Branch threshold is 95 (not 100) because a few optional-chain defaults
    // (e.g. `request.headers ?? {}`) are unreachable in practice but still
    // counted as branches by Istanbul.
    'src/scoreboard/shared/errors/**/*.ts': {
      lines: 100,
      branches: 95,
      functions: 100,
      statements: 100,
    },
    // Resilience primitives (singleflight, logWithMetadata) — small, heavily
    // exercised helpers. Branch threshold is 85 because a few optional-chain
    // defaults (e.g. `timer.unref?.()`) and the `logger.fatal` fallback are
    // unreachable in practice but counted as branches by Istanbul.
    'src/scoreboard/shared/resilience/**/*.ts': {
      lines: 100,
      branches: 85,
      functions: 100,
      statements: 100,
    },
  },
};

export default config;
