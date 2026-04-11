## Why

The previous change (`step-01`) shipped the typed config gateway and a Postgres data layer with the v1 schema (`score_events`, `user_scores`) — but no business logic exists yet. To move from "tables exist" to "the application can credit a score", three pieces must land together: a **pure domain aggregate** (`UserScore` with value objects enforcing all invariants), a **transactional repository adapter** (`KyselyUserScoreRepository` writing both tables in one `BEGIN…COMMIT`), and an **application-layer command handler** (`IncrementScoreHandler` orchestrating load → mutate → persist). Together they form the complete write path at the application layer, ready for the HTTP/auth layer in `step-03`.

Splitting these across three changes would create orphans (a domain aggregate with no repository can't be tested end-to-end; a repository without a handler has no caller). Bundling them keeps the unit small enough for one review and large enough to be useful.

## What Changes

- Add `src/scoreboard/domain/` with the `UserScore` aggregate, value objects (`UserId`, `ActionId`, `Score`, `ScoreDelta`), and the `ScoreCredited` domain event. Domain code SHALL import zero framework symbols (no `@nestjs/*`, no `kysely`, no `pg`).
- Define the `UserScoreRepository` port in `src/scoreboard/domain/ports/` (interface only, no implementation).
- Define the `IdempotencyViolationError` and `DomainError` taxonomy in `src/scoreboard/domain/errors/`.
- Implement `KyselyUserScoreRepository` in `src/scoreboard/infrastructure/persistence/kysely/` that consumes the `Database` token from `step-01` and persists a credit atomically: insert into `score_events` AND update `user_scores.total_score` inside one transaction. Catch `pg` unique-violation errors (SQLSTATE `23505`) and translate them into `IdempotencyViolationError`.
- Add the `IncrementScoreCommand` and `IncrementScoreHandler` in `src/scoreboard/application/commands/`. The handler loads (or creates) the `UserScore` aggregate, calls `.credit()`, persists via the repository, and returns `{ userId, newScore, rank: null, topChanged: null }`. `rank` and `topChanged` stay null in this change; `step-05` populates them.
- Wire `ScoreboardModule` to register `KyselyUserScoreRepository` as the implementation of `UserScoreRepository` and to expose `IncrementScoreHandler` as a provider.
- Add unit tests for the domain (100% line coverage of `domain/`) and an in-memory fake repository for handler unit tests. Integration tests against real Postgres are deferred to `step-04` (jest + Testcontainers infrastructure).

## Capabilities

### New Capabilities

- `scoreboard-domain`: The pure domain layer for the scoreboard module. Owns the `UserScore` aggregate, all value objects (`UserId`, `ActionId`, `Score`, `ScoreDelta`), the `ScoreCredited` domain event, the `UserScoreRepository` port (interface only), and the `DomainError` taxonomy. Imports nothing framework-y (no NestJS, no Kysely, no pg).
- `scoreboard-write-path`: The application-layer command-handling pipeline that turns an `IncrementScoreCommand` into a persisted score credit. Owns `IncrementScoreCommand`, `IncrementScoreHandler`, the `KyselyUserScoreRepository` adapter, and the `IdempotencyViolationError` mapping rule.

### Modified Capabilities

- `scoreboard-database`: Adds the dependency that `KyselyUserScoreRepository` consumes the `Database` token via DI. No schema changes (the schema landed in `step-01`'s migration `0001_*`).

## Impact

**New code**:
- `src/scoreboard/domain/{user-score.aggregate.ts, value-objects/*.ts, events/score-credited.event.ts, errors/{domain-error.ts, idempotency-violation.error.ts, invalid-argument.error.ts}, ports/user-score.repository.ts, index.ts}` (~250 LOC)
- `src/scoreboard/application/commands/{increment-score.command.ts, increment-score.handler.ts, index.ts}` (~120 LOC)
- `src/scoreboard/infrastructure/persistence/kysely/{user-score.repository.impl.ts, index.ts}` (~150 LOC)
- `src/scoreboard/scoreboard.module.ts` — populated with providers (was an empty placeholder from `step-00`)
- Unit tests: `test/unit/domain/*.test.ts`, `test/unit/application/increment-score.handler.test.ts`, plus an in-memory `FakeUserScoreRepository` test double (~300 LOC of tests)

**Modified code**:
- `src/scoreboard/scoreboard.module.ts` — populates `providers` and `exports` arrays

**New dependencies**: none (Kysely + pg from `step-01`, no new packages)

**Runtime contracts established for downstream changes**:
- `IncrementScoreHandler` is the entry point that `step-03`'s controller will inject
- The handler signature is `execute(cmd: IncrementScoreCommand): Promise<{ userId, newScore, rank: null, topChanged: null }>` — `step-04` (post-commit ZADD) will mutate the return type to populate `rank` and `topChanged`
- `IdempotencyViolationError` is the marker exception that `step-03`'s idempotency layer will catch and translate into a 200 response with the prior outcome
- The `UserScoreRepository` port is the seam that `step-04`'s Testcontainers integration tests will hit with a real Postgres

**Out of scope** (deferred):
- The HTTP controller and guard chain — `step-03`
- JWT/action-token/rate-limit/idempotency guards — `step-03`
- The `outbox_events` write-through — `step-05` (it's the first task in that change because Story 2.2 amends the handler)
- ZSET cache update on success — `step-05`
- Pino logger and error envelope — `step-04`
- Integration tests against real Postgres via Testcontainers — `step-04`
