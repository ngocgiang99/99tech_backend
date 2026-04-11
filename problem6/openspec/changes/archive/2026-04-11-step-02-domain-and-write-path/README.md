# step-02-domain-and-write-path

Stories 1.5 + 1.6 + 1.14: UserScore aggregate + value objects, KyselyUserScoreRepository, IncrementScoreHandler

## File List

### New — Domain (pure, zero framework imports)
- `src/scoreboard/domain/value-objects/user-id.ts`
- `src/scoreboard/domain/value-objects/action-id.ts`
- `src/scoreboard/domain/value-objects/score.ts`
- `src/scoreboard/domain/value-objects/score-delta.ts` (exports `MAX_DELTA = 10000`)
- `src/scoreboard/domain/value-objects/index.ts`
- `src/scoreboard/domain/errors/domain-error.ts` (abstract base)
- `src/scoreboard/domain/errors/invalid-argument.error.ts`
- `src/scoreboard/domain/errors/idempotency-violation.error.ts`
- `src/scoreboard/domain/errors/index.ts`
- `src/scoreboard/domain/events/score-credited.event.ts`
- `src/scoreboard/domain/events/index.ts`
- `src/scoreboard/domain/user-score.aggregate.ts`
- `src/scoreboard/domain/ports/user-score.repository.ts`
- `src/scoreboard/domain/index.ts`

### New — Application layer
- `src/scoreboard/application/commands/increment-score.command.ts`
- `src/scoreboard/application/commands/increment-score.handler.ts` (exports `USER_SCORE_REPOSITORY` DI token constant)
- `src/scoreboard/application/commands/index.ts`

### New — Infrastructure (Kysely adapter)
- `src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts`
- `src/scoreboard/infrastructure/persistence/kysely/index.ts`

### New — Tests
- `test/unit/domain/value-objects/user-id.test.ts`
- `test/unit/domain/value-objects/action-id.test.ts`
- `test/unit/domain/value-objects/score.test.ts`
- `test/unit/domain/value-objects/score-delta.test.ts`
- `test/unit/domain/errors/idempotency-violation.error.test.ts`
- `test/unit/domain/user-score.aggregate.test.ts`
- `test/unit/application/fakes/fake-user-score.repository.ts`
- `test/unit/application/increment-score.handler.test.ts`

### New — Test infra (scaffold until step-04's jest config)
- `jest.config.ts` (temporary — step-04 will replace with unit/integration/e2e split)
- `tsconfig.test.json` (CommonJS tsconfig for ts-jest; base tsconfig uses nodenext)

### Modified
- `src/scoreboard/scoreboard.module.ts` — registers `KyselyUserScoreRepository` against `USER_SCORE_REPOSITORY` token and exports `IncrementScoreHandler`
- `tsconfig.build.json` — adds `jest.config.ts`, `tsconfig.test.json`, `**/*.test.ts` to `exclude` to keep build rootDir anchored at `src/`

## Validation Summary

- **Typecheck**: `pnpm tsc --noEmit` → exit 0
- **Build**: `pnpm nest build` → exit 0, `dist/main.js` exists
- **Unit tests**: 39/39 pass across 7 suites
  - Domain coverage: 100% lines / 100% branches / 100% functions (7 source files)
  - Application handler: happy path, new user, idempotent replay, invariant violation, response shape
- **Grep guard** `grep -rE "from '@nestjs|from '(kysely|pg|ioredis|nats|jose)'" src/scoreboard/domain/` → zero matches
- **DI boot**: `PORT=3098 node dist/main.js` with `.env` → all modules init, no DI errors, `curl /` → 404 (expected, no controllers yet)
- **Smoke test** (against real Postgres `problem6-postgres`):
  - First run: `{userId, newScore: 5, rank: null, topChanged: null}` — both tables atomically written
  - Second run (same actionId): `IdempotencyViolationError` raised with `actionId = 11111111-1111-1111-1111-111111111111`; no DB mutation
  - Script cleaned up post-verification (`scripts/smoke-credit.ts` removed)
- **OpenSpec**: `openspec validate step-02-domain-and-write-path` passes, `isComplete: true`

## Deferred to later changes

- **step-03**: HTTP controller, JWT/action-token guards, rate-limit, idempotency layer 1 (Redis SETNX), error filter, DTO validation
- **step-04**: Pino logger, Testcontainers integration tests, proper jest config split (unit/integration/e2e), coverage thresholds in CI
- **step-05**: Leaderboard cache (Redis ZSET), outbox_events table + publisher, post-commit ZADD to populate `rank` and `topChanged`
- **step-06**: JetStream fan-out + SSE
