# scoreboard-write-path

## Purpose

The application-layer command-handling pipeline that turns an `IncrementScoreCommand` into a persisted score credit. Owns `IncrementScoreCommand`, `IncrementScoreHandler`, the `KyselyUserScoreRepository` adapter, and the `IdempotencyViolationError` mapping rule.

## Requirements

### Requirement: KyselyUserScoreRepository persists credit atomically

The `KyselyUserScoreRepository.credit(aggregate, event)` method SHALL persist the score credit using a single Postgres transaction that inserts the `score_events` row AND upserts the `user_scores` row. If either statement fails, the transaction SHALL roll back so neither table reflects partial state.

#### Scenario: Successful credit writes both tables atomically
- **GIVEN** an existing `user_scores` row with `total_score = 10`
- **WHEN** `repository.credit(aggregate, event)` is called with `event.delta = 5`
- **THEN** within a single `BEGIN…COMMIT`, a row is inserted into `score_events`
- **AND** the `user_scores` row is updated to `total_score = 15`
- **AND** `last_action_id` is set to `event.actionId`
- **AND** `updated_at` is advanced

#### Scenario: New user (no existing row) is created on first credit
- **GIVEN** no row exists for `user_id = u1`
- **WHEN** `repository.credit(aggregate, event)` is called for `u1` with `delta = 7`
- **THEN** a new `user_scores` row is created with `total_score = 7`, `last_action_id = event.actionId`, `updated_at = now()`
- **AND** the corresponding `score_events` row exists

#### Scenario: Transaction rolls back on score_events insert failure
- **GIVEN** a credit attempt that violates a constraint on `score_events` (e.g. duplicate `action_id`)
- **WHEN** the repository runs the transaction
- **THEN** the `user_scores` row is NOT updated
- **AND** no partial state is visible to other transactions

### Requirement: Duplicate action_id surfaces as IdempotencyViolationError

When the Postgres `UNIQUE(action_id)` constraint on `score_events` rejects a duplicate insert, the repository SHALL catch the underlying `pg` error (SQLSTATE `23505`) and throw `IdempotencyViolationError` with the offending `actionId` as a property.

#### Scenario: Duplicate action_id raises IdempotencyViolationError
- **GIVEN** a `score_events` row with `action_id = X` already persisted
- **WHEN** `repository.credit(aggregate, event)` is called with `event.actionId === X`
- **THEN** the repository catches the `pg` error with `code === '23505'`
- **AND** throws `IdempotencyViolationError`
- **AND** the error's `.actionId` property equals `X`

#### Scenario: Other Postgres errors are not converted to IdempotencyViolationError
- **GIVEN** a database error unrelated to the unique constraint (e.g. connection lost, permission denied)
- **WHEN** the repository catches it
- **THEN** the original error is rethrown unchanged
- **AND** is NOT wrapped in `IdempotencyViolationError`

### Requirement: Repository uses SELECT FOR UPDATE for serialized RMW

The repository SHALL serialize concurrent credits to the same `user_id` by acquiring a row-level lock on `user_scores` (via `SELECT ... FOR UPDATE`) before mutating it. Concurrent credits to DIFFERENT users SHALL NOT block each other.

#### Scenario: Concurrent credits to same user serialize correctly
- **GIVEN** two concurrent requests crediting `u1` with `delta = 5` each
- **WHEN** both repositories begin their transactions simultaneously
- **THEN** one acquires the row lock first; the other waits
- **AND** the final `total_score` is the sum of both credits (`+10`), not just one
- **AND** both `score_events` rows exist with distinct `id` and `action_id`

#### Scenario: Concurrent credits to different users do not block
- **GIVEN** two concurrent requests crediting `u1` and `u2` respectively
- **WHEN** both repositories run their transactions
- **THEN** neither blocks the other (no shared row lock)
- **AND** both transactions commit independently

### Requirement: IncrementScoreCommand carries the request payload

The `IncrementScoreCommand` SHALL carry the validated request payload (`userId`, `actionId`, `delta`, `occurredAt`) as typed value objects, not raw primitives.

#### Scenario: Command construction validates all fields
- **WHEN** `new IncrementScoreCommand({ userId, actionId, delta, occurredAt })` is called with validated value objects
- **THEN** the command holds the typed instances
- **AND** TypeScript prevents passing a raw string where a `UserId` is expected

### Requirement: IncrementScoreHandler orchestrates load → mutate → persist

The `IncrementScoreHandler.execute(cmd)` method SHALL: (1) load the existing `UserScore` aggregate from the repository (or create an empty one if none exists), (2) call `aggregate.credit(cmd.actionId, cmd.delta, cmd.occurredAt)`, (3) persist via `repository.credit(aggregate, event)`, (4) drain the aggregate's events via `pullEvents()`, and (5) return a DTO with `{ userId, newScore, rank: null, topChanged: null }`.

#### Scenario: Happy path returns the new total
- **GIVEN** a user `u1` with `total_score = 100`
- **WHEN** `handler.execute({ userId: u1, actionId: a1, delta: 10, occurredAt: now })` is called
- **THEN** the repository receives a credit call with the mutated aggregate
- **AND** the response is `{ userId: u1, newScore: 110, rank: null, topChanged: null }`
- **AND** `aggregate.pullEvents()` returned exactly one event before the response was built

#### Scenario: New user is loaded as an empty aggregate
- **GIVEN** no row exists for `u2`
- **WHEN** the handler runs `execute({ userId: u2, ... })`
- **THEN** the handler obtains an `empty` `UserScore` for `u2` (totalScore = 0)
- **AND** the repository persists the credit with the new aggregate state

#### Scenario: Idempotent replay surfaces as IdempotencyViolationError
- **GIVEN** a previous successful credit with `actionId = X`
- **WHEN** the handler is called with the same `actionId = X`
- **THEN** the repository raises `IdempotencyViolationError`
- **AND** the handler propagates the error to its caller (no swallowing — the caller in `step-03` is responsible for translating it into a 200 with the prior outcome)

#### Scenario: Domain invariant violation aborts persistence
- **GIVEN** a request that would cause `aggregate.credit()` to throw (e.g. `delta` exceeds remaining headroom)
- **WHEN** the handler runs
- **THEN** the domain error propagates BEFORE the repository is called
- **AND** no transaction is opened
- **AND** no rows are written

### Requirement: ScoreboardModule registers providers and exports the handler

`src/scoreboard/scoreboard.module.ts` SHALL register `KyselyUserScoreRepository` as the implementation of the `UserScoreRepository` port (via a string token `'UserScoreRepository'`) and SHALL export `IncrementScoreHandler` so other modules (specifically `step-03`'s controller) can inject it.

#### Scenario: ScoreboardModule resolves the handler with all dependencies
- **WHEN** the NestJS DI container resolves `IncrementScoreHandler`
- **THEN** the handler receives a `KyselyUserScoreRepository` injected for the `UserScoreRepository` port
- **AND** the repository receives the `Database` token from `step-01`'s `DatabaseModule`

#### Scenario: ScoreboardModule does NOT register a controller in this change
- **WHEN** `ScoreboardModule.controllers` is inspected
- **THEN** the array is empty (controllers come in `step-03`)

### Requirement: In-memory FakeUserScoreRepository for handler unit tests

The test suite SHALL provide an in-memory `FakeUserScoreRepository` that implements the `UserScoreRepository` port using a `Map<userId, UserScore>` and a `Set<actionId>`. The fake SHALL throw `IdempotencyViolationError` when the same `actionId` is credited twice, mirroring the real adapter's behaviour.

#### Scenario: Fake repository persists and returns aggregates
- **WHEN** `fake.credit(aggregate, event)` is called
- **THEN** the internal map is updated with the new aggregate state
- **AND** a subsequent `fake.findByUserId(userId)` returns the updated instance

#### Scenario: Fake repository raises IdempotencyViolationError on duplicate actionId
- **GIVEN** the fake has previously credited `actionId = X`
- **WHEN** `fake.credit(aggregate, event)` is called with `event.actionId === X`
- **THEN** it throws `IdempotencyViolationError` synchronously
- **AND** no internal state is mutated
