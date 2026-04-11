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
  },
};

export default config;
