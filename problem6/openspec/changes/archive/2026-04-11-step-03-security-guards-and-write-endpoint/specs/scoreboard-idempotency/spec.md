## ADDED Requirements

### Requirement: Layer 1 — Redis SETNX as fast-path idempotency check

The system SHALL use Redis `SET NX EX <ACTION_TOKEN_TTL_SECONDS> idempotency:action:<actionId>` as the layer-1 idempotency check. This call is made by `ActionTokenGuard` immediately after action-token verification succeeds. SETNX win means "this is the first time we've seen this `actionId`, proceed". SETNX loss means "we've seen this `actionId` before".

#### Scenario: SETNX win allows the request through
- **GIVEN** a request whose `actionId` has not been seen before
- **WHEN** `ActionTokenGuard` runs `SET NX idempotency:action:<actionId>`
- **THEN** the SETNX returns OK
- **AND** the request proceeds to `RateLimitGuard` and ultimately the handler

#### Scenario: SETNX loss returns ACTION_ALREADY_CONSUMED
- **GIVEN** a request whose `actionId` matches a SETNX entry already in Redis
- **WHEN** `ActionTokenGuard` runs `SET NX idempotency:action:<actionId>`
- **THEN** the SETNX returns nil
- **AND** the response is `403 ACTION_ALREADY_CONSUMED`

#### Scenario: SETNX entry expires after TTL
- **GIVEN** a SETNX entry inserted at time `t`
- **WHEN** time advances by `ACTION_TOKEN_TTL_SECONDS + 1`
- **THEN** the key has been removed by Redis
- **AND** a new SETNX with the same `actionId` would succeed (allowing the user to retry after the TTL window)

### Requirement: Layer 2 — Postgres unique constraint as durable backstop

When Redis evicts the SETNX entry mid-request (memory pressure, restart) or the layer-1 check is otherwise bypassed, the system SHALL fall back to the Postgres `UNIQUE(action_id)` constraint on `score_events`. The repository SHALL surface the constraint violation as `IdempotencyViolationError`, and the controller SHALL catch this error and translate it into an idempotent replay response (200 with the prior outcome).

#### Scenario: Repository raises IdempotencyViolationError on duplicate insert
- **GIVEN** a `score_events` row with `action_id = X` already persisted (from a previous successful credit)
- **WHEN** the handler attempts another credit with the same `actionId = X`
- **THEN** the repository's INSERT fails with Postgres SQLSTATE `23505`
- **AND** the repository throws `IdempotencyViolationError` with `actionId = X`

#### Scenario: Controller catches IdempotencyViolationError and returns the prior outcome
- **GIVEN** the handler propagated an `IdempotencyViolationError`
- **WHEN** the controller's catch block runs
- **THEN** the controller calls `repository.findScoreEventByActionId(X)`
- **AND** uses the historical row to construct the response DTO `{ userId, newScore: <prior total at the time of original credit>, rank: null, topChanged: null }`
- **AND** returns 200 with that DTO (NOT a 409 or 403)

#### Scenario: Layer 2 catches the case where Layer 1 was bypassed
- **GIVEN** a credit request whose Redis SETNX was lost due to eviction (the SETNX entry no longer exists)
- **WHEN** the request reaches the handler and the handler calls `repository.credit()`
- **THEN** Postgres' UNIQUE constraint catches the duplicate
- **AND** the response is the same idempotent replay (200 with prior outcome)
- **AND** no double-credit occurs

### Requirement: Layer 3 placeholder — JetStream dedup window

Layer 3 idempotency (NATS JetStream `Nats-Msg-Id` dedup) SHALL be wired in `step-05` (when the outbox lands) and `step-06` (when the JetStream publisher lands). This change SHALL document layer 3's eventual role but SHALL NOT implement it.

#### Scenario: Layer 3 is documented but not implemented in this change
- **WHEN** the codebase is grepped for `Nats-Msg-Id`
- **THEN** zero matches are returned (it lands in `step-06`)
- **AND** `design.md` of this change references the future location

### Requirement: Concurrent duplicate requests under load result in exactly one credit

Under concurrent load (e.g. 50 simultaneous duplicate requests with the same `actionId`), the system SHALL persist exactly one `score_events` row and return the same response to ALL 50 requests. The mechanism SHALL be the combination of layer-1 (Redis SETNX atomicity) and layer-2 (Postgres unique constraint).

#### Scenario: 50 concurrent duplicates result in 1 row and identical responses
- **GIVEN** 50 concurrent `POST /v1/scores:increment` requests with the same `actionId = X`, the same JWT, and the same body
- **WHEN** the controller processes them
- **THEN** exactly 1 `score_events` row exists with `action_id = X`
- **AND** the `user_scores.total_score` reflects exactly one credit
- **AND** all 50 responses have the same `newScore` value
- **AND** layer-1 admits one and rejects 49 (or layer-1 admits multiple due to a race, in which case layer-2 catches the rest — both paths produce the same outcome)
