## Why

`step-02` shipped the application-layer write path (`IncrementScoreHandler`) but it has no HTTP surface and no security boundary. To turn the system into a usable API, six pieces must land together: **JWT verification** via JWKS, an **action-token issuer endpoint**, an **action-token verifier guard**, **per-user rate limiting** via Redis Lua, **idempotency layers 1 and 2** (Redis SETNX + Postgres unique-violation translation, with handler-level replay), and the **POST /v1/scores:increment controller** wiring them together in the documented guard order.

These are inseparable: the controller is useless without the guards, and the guards are useless without a controller to protect. Bundling them into one change keeps the security perimeter consistent — a reviewer sees the entire auth-and-trust story in one place.

## What Changes

- Add `src/scoreboard/infrastructure/auth/jwks-cache.ts` with an in-memory JWKS cache (1-hour TTL) that fetches public keys from `JWKS_URL` on app boot and on cache miss. Uses `jose` library for JWK parsing.
- Add `src/scoreboard/infrastructure/auth/jwt.guard.ts` (`@Injectable() implements CanActivate`) that verifies bearer tokens via the JWKS cache: requires `iss === JWT_ISSUER`, `aud === JWT_AUDIENCE`, `exp > now`, alg in `[RS256, ES256]`. Sets `request.userId = payload.sub` on success. Rejects with `401 UNAUTHENTICATED` on any failure (and explicitly rejects `alg=none` at parse time, BEFORE signature verification).
- Add `src/scoreboard/infrastructure/auth/hmac-action-token.{issuer,verifier}.ts` implementing HMAC-SHA256 capability tokens with claims `{ sub, aid, atp, mxd, iat, exp }`. Issuer signs with `ACTION_TOKEN_SECRET`. Verifier checks alg, signature, expiry, audience binding (`sub === request.userId`), and `aid === body.actionId`, `mxd >= body.delta`.
- Add `src/scoreboard/interface/http/controllers/actions.controller.ts` exposing `POST /v1/actions:issue-token` (JWT-protected). Body: `{ actionType: string }`. Returns `{ actionId, actionToken, expiresAt, maxDelta }`. Uses `crypto.randomUUID()` for `actionId`. Records `SET NX EX 300 action:issued:<actionId>` in Redis. NEVER logs the raw action token.
- Add `src/scoreboard/infrastructure/auth/action-token.guard.ts` (`@Injectable() implements CanActivate`) that runs after `JwtGuard`: verifies the action token, then atomically `SET NX` on `idempotency:action:<aid>` in Redis. On SETNX loss, returns `403 ACTION_ALREADY_CONSUMED` with the cached prior outcome. (Cached prior outcome reads from Postgres `score_events` by `action_id` — same query as the layer-2 idempotency replay path.)
- Add `src/scoreboard/infrastructure/persistence/redis/redis.client.ts` — single shared `ioredis` instance built from `ConfigService.get('REDIS_URL')`. Wired as a `@Global()` provider with token `'Redis'`.
- Add `src/scoreboard/infrastructure/persistence/redis/idempotency-store.impl.ts` implementing the layer-1 SETNX semantics. Layer-2 (Postgres unique-violation translation) is already in `step-02`'s `KyselyUserScoreRepository`; this change wires the **replay** logic that catches `IdempotencyViolationError` from the handler and reads the prior `score_events` row to return the same outcome.
- Add `src/scoreboard/infrastructure/rate-limit/redis-token-bucket.ts` — atomic Redis Lua script implementing per-user token bucket (10 req/s default, burst 20). Loaded on app boot via `EVAL`/`EVALSHA`. Add `src/scoreboard/infrastructure/rate-limit/rate-limit.guard.ts` (`@Injectable() implements CanActivate`) that runs after `ActionTokenGuard`. On bucket exhaustion: `429 RATE_LIMITED` with `Retry-After`. Add a global circuit breaker at 5000 req/s aggregate that returns `503 TEMPORARILY_UNAVAILABLE`.
- Add `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` exposing `POST /v1/scores:increment` with the full guard chain in **strict order**: `JwtGuard → ActionTokenGuard → RateLimitGuard → handler`. Body validated via a zod schema (`{ actionId, delta }`). Returns the handler's DTO (`{ userId, newScore, rank: null, topChanged: null }`).
- Wire the new providers and controllers into `ScoreboardModule`. Update `AppModule` if needed.

## Capabilities

### New Capabilities

- `scoreboard-auth`: JWT verification (JWKS-based) + HMAC action-token issuer/verifier. Owns the auth guards (`JwtGuard`, `ActionTokenGuard`), the JWKS cache, the action-token signer/verifier classes, and the `actions:issue-token` endpoint. Establishes the contract that every protected endpoint runs `JwtGuard` first.
- `scoreboard-rate-limit`: Per-user token bucket (Redis Lua) + global circuit breaker. Owns `RateLimitGuard` and the Lua script lifecycle (load on boot, evict on Redis flush).
- `scoreboard-idempotency`: Three-layer idempotency contract. Owns the layer-1 Redis SETNX implementation, the layer-2 catch-and-replay logic in the controller's error path (which calls back into the handler with the original outcome retrieved from Postgres), and the documentation of layer-3 (JetStream `Nats-Msg-Id` dedup, wired in `step-05`/`step-06`).

### Modified Capabilities

- `scoreboard-write-path`: Adds the HTTP entry point. The previously-orphan `IncrementScoreHandler` from `step-02` is now invoked from `ScoreboardController.incrementScore()`. Also adds a controller-level catch for `IdempotencyViolationError` that translates it into a 200 with the prior outcome (the "idempotent replay" behaviour described in Story 1.13).

## Impact

**New code**:
- `src/scoreboard/infrastructure/auth/{jwks-cache.ts, jwt.guard.ts, hmac-action-token.issuer.ts, hmac-action-token.verifier.ts, action-token.guard.ts, action-token.types.ts, index.ts}` (~400 LOC)
- `src/scoreboard/infrastructure/persistence/redis/{redis.client.ts, redis.module.ts, idempotency-store.impl.ts, index.ts}` (~150 LOC)
- `src/scoreboard/infrastructure/rate-limit/{redis-token-bucket.ts, rate-limit.guard.ts, lua/token-bucket.lua, index.ts}` (~200 LOC)
- `src/scoreboard/interface/http/dto/{issue-action-token.dto.ts, increment-score.dto.ts, error-response.dto.ts}` (~80 LOC, zod schemas)
- `src/scoreboard/interface/http/controllers/{actions.controller.ts, scoreboard.controller.ts}` (~200 LOC)
- Unit tests: `test/unit/auth/*.test.ts`, `test/unit/rate-limit/*.test.ts` covering happy paths and every reject case (~400 LOC of tests)

**Modified code**:
- `src/scoreboard/scoreboard.module.ts` — register new guards, controllers, Redis client, idempotency store, rate-limit guard
- `src/scoreboard/application/commands/increment-score.handler.ts` — minor: add a `findByActionId(actionId)` lookup helper to support the controller's idempotent replay path. **OR** the controller does the lookup directly via `repository.findScoreEventByActionId(actionId)` — design.md picks one
- `src/scoreboard/domain/ports/user-score.repository.ts` — add `findScoreEventByActionId(actionId)` method to the port (returns the historical outcome shape needed for the replay)

**New dependencies** (added to `package.json`):
- `jose` (JWT verification + JWKS)
- `ioredis` (Redis client)

**New configuration**:
- All env vars consumed in this change are already in `step-01`'s `EnvSchema` (`JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `ACTION_TOKEN_SECRET`, `ACTION_TOKEN_TTL_SECONDS`, `RATE_LIMIT_PER_SEC`, `REDIS_URL`). No schema changes needed.

**Runtime contracts established for downstream changes**:
- `request.userId` is set by `JwtGuard` and consumed by every guard downstream
- `request.actionTokenClaims` is set by `ActionTokenGuard` (carries `sub, aid, atp, mxd, exp`) for downstream guards that need rate-limit context
- `JwtGuard` is the canonical entry guard — every protected endpoint in Epic 2 (`step-05`'s `/leaderboard/top`, `step-06`'s `/leaderboard/stream`) decorates with `@UseGuards(JwtGuard)`
- The HTTP error envelope `{ error: { code, message, requestId, hint } }` is established here (the controller's exception filter does the wrapping until `step-04` introduces the global filter)

**Out of scope** (deferred):
- Pino structured logger + request-ID propagation — `step-04` (today this change uses `console.log` for any logging)
- Global exception filter — `step-04`. Until then, the controller has a local try/catch that builds the envelope manually
- Prometheus metrics + OTel traces — `step-04`
- ESLint boundaries enforcement — `step-04`
- Real Redis integration tests via Testcontainers — `step-04`
- The `/leaderboard/top` and `/leaderboard/stream` endpoints — `step-05` and `step-06`
- Action-token rotation runbook (GAP-05, two-secret verification) — `step-04` (it's a documentation + minor verifier patch)
