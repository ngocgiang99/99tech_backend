## ADDED Requirements

### Requirement: Per-user token bucket via atomic Redis Lua

The system SHALL enforce a per-user token bucket rate limit on the write endpoint via an atomic Redis Lua script. The default capacity SHALL be 10 tokens per second with burst 20 (configurable via `RATE_LIMIT_PER_SEC`). The Lua script SHALL be loaded once at boot via `SCRIPT LOAD` and called via `EVALSHA` thereafter.

#### Scenario: User within budget is allowed
- **GIVEN** a user whose Redis token bucket has tokens available
- **WHEN** `RateLimitGuard` runs for that user
- **THEN** the Lua script atomically decrements the bucket
- **AND** the guard returns true
- **AND** the request proceeds to the handler

#### Scenario: User over burst capacity is rejected with 429
- **GIVEN** a user who has consumed all 20 burst tokens within the refill window
- **WHEN** they send a 21st request
- **THEN** the Lua script returns "rejected"
- **AND** the response is `429 RATE_LIMITED`
- **AND** the response includes a `Retry-After` header indicating seconds until the next token is available

#### Scenario: Lua script remains idempotent across concurrent calls
- **GIVEN** 100 concurrent requests for a single user with a bucket capacity of 20
- **WHEN** the requests are processed
- **THEN** exactly 20 are admitted and 80 are rejected
- **AND** no race condition results in more than 20 admissions (atomicity guarantee)

#### Scenario: Lua script reloads on NOSCRIPT error
- **GIVEN** Redis has flushed its script cache (e.g. via `SCRIPT FLUSH` or restart)
- **WHEN** `EVALSHA` returns a `NOSCRIPT` error
- **THEN** the rate-limit guard catches the error
- **AND** falls back to `EVAL` with the full script source
- **AND** caches the new SHA for future requests

### Requirement: Global circuit breaker at 5000 req/s per instance

The system SHALL enforce a global per-instance ceiling of 5000 requests per second across all users. When the per-instance counter exceeds this ceiling within a 1-second window, subsequent requests SHALL receive `503 TEMPORARILY_UNAVAILABLE` until the next window starts.

#### Scenario: Aggregate budget exhausted returns 503
- **GIVEN** a single API instance has admitted 5000 requests in the current 1-second window
- **WHEN** the 5001st request arrives
- **THEN** the response is `503 TEMPORARILY_UNAVAILABLE`
- **AND** the per-user bucket is NOT consulted (the global breaker fires first)

#### Scenario: Counter resets at the start of each second
- **GIVEN** the per-instance counter at 5000 in second `t`
- **WHEN** time advances to second `t+1`
- **THEN** the counter resets to 0
- **AND** new requests are admitted again (subject to per-user budget)

#### Scenario: Global ceiling is per-instance, not cluster-wide
- **GIVEN** 3 API instances each at 4500 req/s (aggregate ~13500)
- **WHEN** the global breaker is evaluated
- **THEN** none of the instances trip (each is below its 5000 ceiling)
- **AND** the documentation explicitly notes that "5000 aggregate" in `architecture.md` means per-instance, not cluster-wide

### Requirement: RateLimitGuard runs after ActionTokenGuard in the chain

The `@UseGuards()` decorator on `POST /v1/scores:increment` SHALL list the guards in the exact order `JwtGuard, ActionTokenGuard, RateLimitGuard` so that NestJS executes them sequentially. The handler SHALL only run if all three guards return true.

#### Scenario: Guard order is documented in source
- **WHEN** `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` is read
- **THEN** the `@UseGuards()` decorator on `incrementScore` lists `JwtGuard, ActionTokenGuard, RateLimitGuard` in that order

#### Scenario: An earlier guard's failure short-circuits later guards
- **GIVEN** a request whose JWT is invalid
- **WHEN** the request hits the controller
- **THEN** `JwtGuard` rejects with 401
- **AND** neither `ActionTokenGuard` nor `RateLimitGuard` runs
- **AND** no Redis call is made
