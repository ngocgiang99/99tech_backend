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

### Requirement: POST /v1/scores:increment is the HTTP entry point for score crediting

The system SHALL expose `POST /v1/scores:increment` as the only HTTP endpoint for crediting scores. The endpoint SHALL be protected by the guard chain `JwtGuard → ActionTokenGuard → RateLimitGuard` in that exact order, and SHALL invoke `IncrementScoreHandler.execute()` on success.

#### Scenario: Happy path returns the handler's DTO
- **GIVEN** a request with a valid JWT, valid action token, and a body `{ actionId, delta }` where the user is within rate-limit budget
- **WHEN** the request hits `POST /v1/scores:increment`
- **THEN** all three guards return true in order
- **AND** the handler runs and persists the credit
- **AND** the response is `200` with body `{ userId, newScore, rank: null, topChanged: null }`

#### Scenario: Body schema validation rejects malformed input
- **GIVEN** a request with an authenticated body `{ actionId: "not-a-uuid", delta: -5 }`
- **WHEN** the controller's body parser runs
- **THEN** the response is `400 INVALID_REQUEST`
- **AND** the error envelope's `message` names the offending fields (`actionId`, `delta`)
- **AND** the handler is NOT invoked

#### Scenario: Guard order is enforced — JWT failure short-circuits everything
- **GIVEN** a request with no `Authorization` header
- **WHEN** it hits the controller
- **THEN** `JwtGuard` rejects with 401
- **AND** `ActionTokenGuard` and `RateLimitGuard` and the handler all do NOT run
- **AND** no Redis or Postgres calls are made

### Requirement: Idempotent replay returns the prior outcome with HTTP 200

When `IncrementScoreHandler` raises `IdempotencyViolationError`, the controller SHALL catch the error, look up the prior `score_events` row by `actionId`, reconstruct the original response DTO, and return it with HTTP 200 (not 409, not 403).

#### Scenario: Retry with same actionId returns the same response
- **GIVEN** a previous successful credit with `actionId = X` and resulting `newScore = 110`
- **WHEN** a retry with the same JWT, same action token, and same body is sent
- **THEN** layer-1 (Redis SETNX) hits, layer-2 (Postgres unique) is bypassed, the controller obtains the prior outcome from the SETNX value or from `repository.findScoreEventByActionId(X)`
- **AND** the response is `200` with body `{ userId, newScore: 110, rank: null, topChanged: null }`
- **AND** no new `score_events` row is created

#### Scenario: Retry after Redis eviction still returns the same response
- **GIVEN** a previous successful credit, then Redis evicts the SETNX entry
- **WHEN** a retry arrives
- **THEN** layer-1 SETNX succeeds (Redis has no record)
- **AND** the handler attempts the INSERT, which fails with the unique-constraint violation
- **AND** the controller catches `IdempotencyViolationError`
- **AND** calls `repository.findScoreEventByActionId(X)` to read the historical row
- **AND** returns `200` with the historical DTO

### Requirement: Repository exposes findScoreEventByActionId for replay path

The `UserScoreRepository` port SHALL expose `findScoreEventByActionId(actionId: ActionId): Promise<ScoreEventReadModel | null>` so the controller can read historical credit outcomes for the replay path. The `KyselyUserScoreRepository` SHALL implement this with `db.selectFrom('score_events').where('action_id', '=', actionId.value).executeTakeFirst()`.

#### Scenario: Lookup returns the historical row when present
- **GIVEN** a `score_events` row with `action_id = X`
- **WHEN** `repository.findScoreEventByActionId(X)` is called
- **THEN** the result is the row with all columns: `id, user_id, action_id, delta, created_at`

#### Scenario: Lookup returns null when no historical row exists
- **GIVEN** no `score_events` row with `action_id = Y`
- **WHEN** `repository.findScoreEventByActionId(Y)` is called
- **THEN** the result is `null`

### Requirement: Controller maps domain errors to HTTP codes pre-global-filter

Until `step-04` lands the global exception filter, the controller SHALL contain a local error mapping: `IdempotencyViolationError → 200 (replay)`, `InvalidArgumentError → 400`, `UnauthorizedError → 401`, `ForbiddenError → 403`, default → 500. The mapping SHALL be deleted when the global filter lands.

#### Scenario: InvalidArgumentError becomes 400
- **GIVEN** a handler that throws `InvalidArgumentError("delta out of range")`
- **WHEN** the controller catches it
- **THEN** the response is `400` with body `{ "error": { "code": "INVALID_ARGUMENT", "message": "delta out of range", "requestId": "...", "hint": "..." } }`

#### Scenario: Unexpected error becomes 500 with no stack leak
- **GIVEN** a handler that throws `new Error("oops")`
- **WHEN** the controller catches it
- **THEN** the response is `500` with body `{ "error": { "code": "INTERNAL_ERROR", "message": "<generic>", "requestId": "..." } }`
- **AND** the response body does NOT contain a stack trace

### Requirement: Controllers no longer contain local error-mapping try/catch (replaced by global filter)

The `ScoreboardController.incrementScore()` and `ActionsController.issueActionToken()` methods SHALL NOT contain local try/catch blocks for general error mapping. Errors propagate to the global exception filter (`scoreboard-observability` capability). The ONLY remaining try/catch in `ScoreboardController.incrementScore()` is for `IdempotencyViolationError`, because the replay path is a SUCCESS (200 with prior outcome), not an error.

#### Scenario: Controllers do not import error-mapping helpers
- **WHEN** `grep -E "catch \\(.*\\)" src/scoreboard/interface/http/controllers/` is run
- **THEN** the only matches are the `IdempotencyViolationError` replay catch in `scoreboard.controller.ts`
- **AND** there are NO other catch blocks mapping domain errors to HTTP codes

#### Scenario: Domain errors flow through the global filter
- **GIVEN** a controller method that calls `await this.handler.execute(cmd)` and the handler throws `InvalidArgumentError`
- **WHEN** the request is processed
- **THEN** the controller does NOT catch the error
- **AND** the global filter catches it
- **AND** the response is `400` with the standard envelope

#### Scenario: IdempotencyViolationError replay catch survives
- **GIVEN** a duplicate credit request that triggers `IdempotencyViolationError` from the handler
- **WHEN** the controller's local catch fires
- **THEN** the catch reads the prior outcome via `repository.findScoreEventByActionId()`
- **AND** returns 200 with the historical DTO
- **AND** the global filter is NOT consulted (the response is built locally)
