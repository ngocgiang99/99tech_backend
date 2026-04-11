import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/unit'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  collectCoverageFrom: [
    'src/scoreboard/domain/**/*.ts',
    'src/scoreboard/application/**/*.ts',
    '!src/scoreboard/**/index.ts',
    '!src/scoreboard/domain/ports/**',
  ],
  forceCoverageMatch: [
    'src/scoreboard/domain/**/*.ts',
    'src/scoreboard/application/**/*.ts',
  ],
};

export default config;
