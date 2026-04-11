## MODIFIED Requirements

### Requirement: IncrementScoreHandler orchestrates load → mutate → persist

The `IncrementScoreHandler.execute(cmd)` method SHALL: (1) load the existing `UserScore` aggregate from the repository (or create an empty one if none exists), (2) call `aggregate.credit(cmd.actionId, cmd.delta, cmd.occurredAt)`, (3) persist via `repository.credit(aggregate, event)`, (4) drain the aggregate's events via `pullEvents()`, and (5) return an `IncrementScoreResult` tagged with `kind: 'committed' | 'idempotent-replay'`. When the persist step raises `IdempotencyViolationError`, the handler SHALL own the recovery path: it SHALL look up the prior score event via `repository.findScoreEventByActionId(cmd.actionId)` and return the historical outcome tagged as `{ kind: 'idempotent-replay', ... }`. Callers (controllers) SHALL NOT be required to catch `IdempotencyViolationError`; the handler's public contract guarantees that any `IdempotencyViolationError` thrown from the repository is either recovered into an `idempotent-replay` result or re-thrown as `InternalError` when the prior row is missing.

#### Scenario: Happy path returns a committed result
- **GIVEN** a user `u1` with `total_score = 100`
- **WHEN** `handler.execute({ userId: u1, actionId: a1, delta: 10, occurredAt: now })` is called
- **THEN** the repository receives a credit call with the mutated aggregate
- **AND** the response is `{ kind: 'committed', userId: u1, newScore: 110, rank: <number|null>, topChanged: <boolean|null> }`
- **AND** `aggregate.pullEvents()` returned exactly one event before the response was built

#### Scenario: New user is loaded as an empty aggregate
- **GIVEN** no row exists for `u2`
- **WHEN** the handler runs `execute({ userId: u2, ... })`
- **THEN** the handler obtains an `empty` `UserScore` for `u2` (totalScore = 0)
- **AND** the repository persists the credit with the new aggregate state
- **AND** the response is `{ kind: 'committed', ... }`

#### Scenario: Idempotent replay is recovered inside the handler
- **GIVEN** a previous successful credit with `actionId = X` resulting in `total_score = 110`
- **WHEN** `handler.execute({ userId: u1, actionId: X, delta: 10, ... })` is called a second time
- **THEN** `repository.credit(...)` raises `IdempotencyViolationError`
- **AND** the handler catches it internally
- **AND** calls `repository.findScoreEventByActionId(X)` to obtain the prior row
- **AND** returns `{ kind: 'idempotent-replay', userId: u1, newScore: 110, rank: null, topChanged: null }`
- **AND** does NOT re-throw `IdempotencyViolationError` to the caller

#### Scenario: Idempotent replay with missing prior row raises InternalError
- **GIVEN** `repository.credit(...)` raises `IdempotencyViolationError` but `findScoreEventByActionId(X)` returns `null` (edge case: the unique row was deleted between the failed INSERT and the lookup)
- **WHEN** the handler's recovery path runs
- **THEN** the handler throws `InternalError` with message `'Prior credit record not found for idempotent replay'`
- **AND** the original `IdempotencyViolationError` is attached as `cause`

#### Scenario: Domain invariant violation aborts persistence
- **GIVEN** a request that would cause `aggregate.credit()` to throw (e.g. `delta` exceeds remaining headroom)
- **WHEN** the handler runs
- **THEN** the domain error propagates BEFORE the repository is called
- **AND** no transaction is opened
- **AND** no rows are written
- **AND** no `kind: 'committed' | 'idempotent-replay'` result is returned — the error propagates up

### Requirement: Idempotent replay returns the prior outcome with HTTP 200

When `IncrementScoreHandler.execute()` returns a result tagged `kind: 'idempotent-replay'`, the controller SHALL treat it as a successful 200 response and return the same JSON body shape as a committed response. The controller SHALL NOT contain any `try/catch` block targeting `IdempotencyViolationError`; the handler owns the recovery. The response body and HTTP status code SHALL be indistinguishable from a first-execution committed response (200, same field names, same types).

#### Scenario: Retry with same actionId returns the same response
- **GIVEN** a previous successful credit with `actionId = X` and resulting `newScore = 110`
- **WHEN** a retry with the same JWT, same action token, and same body is sent
- **THEN** the handler returns `{ kind: 'idempotent-replay', userId, newScore: 110, rank: null, topChanged: null }`
- **AND** the controller returns HTTP `200` with body `{ userId, newScore: 110, rank: null, topChanged: null }` (the `kind` field is stripped before serializing)
- **AND** no new `score_events` row is created
- **AND** the controller's method body does NOT contain a `catch (err instanceof IdempotencyViolationError)` block

#### Scenario: Retry after Redis eviction still returns the same response
- **GIVEN** a previous successful credit, then Redis evicts the SETNX entry
- **WHEN** a retry arrives
- **THEN** layer-1 SETNX succeeds (Redis has no record)
- **AND** the handler attempts the INSERT, which fails with the unique-constraint violation
- **AND** the handler catches `IdempotencyViolationError` internally
- **AND** calls `repository.findScoreEventByActionId(X)` to read the historical row
- **AND** returns `{ kind: 'idempotent-replay', ... }`
- **AND** the controller returns `200` with the historical DTO

#### Scenario: Controller code is thinner after this change
- **WHEN** `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` is inspected
- **THEN** it does NOT import `IdempotencyViolationError` from `domain/errors/`
- **AND** it does NOT import `USER_SCORE_REPOSITORY` or `UserScoreRepository` for the purpose of calling `findScoreEventByActionId`
- **AND** the method body is a simple `await this.handler.execute(cmd)` followed by returning the result (with `kind` stripped)
