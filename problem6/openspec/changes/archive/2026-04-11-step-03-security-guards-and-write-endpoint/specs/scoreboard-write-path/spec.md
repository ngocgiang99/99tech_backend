## ADDED Requirements

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
