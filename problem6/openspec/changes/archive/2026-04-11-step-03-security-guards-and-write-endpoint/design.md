## Context

`step-02` shipped the application-layer write path. The `IncrementScoreHandler` is fully functional but only callable via direct method invocation — there's no HTTP, no auth, no rate limiting, no idempotency layer 1. This change adds the entire security perimeter and the controller that uses it.

The architecture (`README.md §9.4`, `architecture.md` ADR-05/06/07/08) is unusually prescriptive about the guard order: **JWT → action-token → idempotency → rate-limit → handler**. This isn't arbitrary — the order is chosen so each guard's failure mode is the cheapest possible:
- JWT failure ⇒ no Redis call, no DB call (HMAC-SHA256 verify is microseconds)
- Action-token failure ⇒ no Redis call beyond the one already done by ActionTokenGuard for SETNX (the verifier is local HMAC)
- Idempotency hit ⇒ one Postgres `SELECT * FROM score_events WHERE action_id = ?` (cheap)
- Rate limit hit ⇒ one Lua EVAL (atomic, ~1ms)

If the order were rearranged (e.g. rate-limit before JWT), an unauthenticated flood could exhaust the rate limiter's Redis budget for the actual user. The order is part of the security model.

This change is the largest in the sequence (~6 stories worth of code) but it's structurally tight: 6 guard/adapter classes + 2 controllers + 1 module-wiring update. No exotic patterns, no async coordination beyond NestJS DI.

## Goals / Non-Goals

**Goals:**
- Every protected endpoint enforces JWT verification with the exact requirements from `architecture.md` ADR-05: `iss`, `aud`, `exp`, `alg ∈ {RS256, ES256}`, `alg=none` rejected at parse time.
- HMAC action tokens are issued by `POST /v1/actions:issue-token` (JWT-protected) and verified by `ActionTokenGuard`. One-shot consumption via Redis SETNX. Token claims include `sub` (userId binding), `aid` (action ID binding), `atp` (action type), `mxd` (max delta), `iat`, `exp`.
- Idempotency layers 1 and 2 work end-to-end: Redis SETNX as fast path, Postgres unique-violation translation as durable fallback. The handler-level replay reads the prior `score_events` row and returns the same outcome.
- Per-user rate limiting (Redis Lua token bucket) at 10 req/s default with burst 20. Global circuit breaker at 5000 req/s aggregate.
- The full guard chain for `POST /v1/scores:increment` is `JwtGuard → ActionTokenGuard → RateLimitGuard → handler`. Each guard's failure produces the documented HTTP code (`401`, `403`, `429`, `503`).
- The endpoint returns a 200 with `{ userId, newScore, rank: null, topChanged: null }` on success (rank/topChanged null until `step-05`).
- Unit tests cover every guard's happy and reject paths using mocked Redis/JWKS dependencies. No real Redis or JWT issuer needed for unit tests.

**Non-Goals:**
- Real Redis integration tests via Testcontainers — `step-04`.
- Real JWKS endpoint integration test (we mock the `jose` JWKS fetcher in unit tests) — `step-04` may add an integration test using a mock identity service.
- The Pino logger and structured request logging — `step-04`.
- The global exception filter that auto-wraps errors into the envelope — `step-04`. This change uses a local catch in each controller as a stop-gap.
- Multi-region or multi-tenant variations — none of v1 needs them.
- A dual-secret verification path (GAP-05 rotation runbook) — `step-04` adds the second secret support and the runbook.
- The cached prior outcome in the `ACTION_ALREADY_CONSUMED` response — for v1, the response is the prior `score_events` row decoded into `{ newScore, ... }`. If Postgres has been wiped between the original credit and the replay, the response is a generic 403 without the cached outcome (acceptable for MVP).

## Decisions

### Decision 1: Guard chain enforced at controller level via `@UseGuards()` ordering, not via a custom interceptor

**What**: The `ScoreboardController.incrementScore()` method is decorated with `@UseGuards(JwtGuard, ActionTokenGuard, RateLimitGuard)` in that exact order. NestJS runs them sequentially and short-circuits on the first failure.

**Why**:
- **Native NestJS semantics**: `@UseGuards` is the canonical pattern; no custom plumbing required.
- **Order is in the source code**: a reviewer reading the controller sees the guard order on one line. Refactor-resistant.
- **Failure behaviour matches the spec**: NestJS short-circuits on the first guard that returns false or throws. The remaining guards never run, the handler never runs, the response is built from the throwing guard's error.

**Alternatives considered**:
- **Custom `GuardChainInterceptor`** that runs the guards manually. Rejected — adds a layer of indirection NestJS already provides.
- **Module-level guards via `APP_GUARD`**. Rejected — applies to ALL endpoints, but `actions:issue-token` only needs `JwtGuard` (not the whole chain). Per-endpoint decoration is more precise.

### Decision 2: JWKS cache uses `jose` library with a 1-hour in-memory TTL, refreshed on cache miss

**What**: `JwksCache` is a simple class wrapping `createRemoteJWKSet` from `jose`. It exposes `verify(token: string): Promise<JWTPayload>` which lazily fetches keys from `JWKS_URL` and caches them per `kid` for 1 hour. On cache miss (or TTL expiry), it re-fetches.

**Why**:
- **`jose` is the standard**: it's the library we already added in `step-01`'s dependency list (or this change adds it). Battle-tested.
- **`createRemoteJWKSet` handles the cache for us**: no manual `Map<kid, key>` management.
- **1 hour TTL matches the architecture**: ADR-05 specifies "cached in-memory for 1h".
- **No graceful refresh**: if the issuer rotates a `kid` mid-cache, the next verify with the new `kid` triggers a refresh. Acceptable for v1.

**Alternatives considered**:
- **Background refresh every 50 minutes**: rejected — adds a timer and lifecycle complexity for marginal benefit.
- **Manual JWKS parser using `node:crypto`**: rejected — `jose` does it correctly and handles `RS256`/`ES256` differences.

### Decision 3: Action token is HS256 JWT with a fixed claim shape

**What**: The action token is a JWT signed with `ACTION_TOKEN_SECRET` using HS256. Claims:
- `sub`: userId (binds to JWT subject)
- `aid`: actionId UUID (binds to body.actionId)
- `atp`: actionType (e.g. `"level-complete"`)
- `mxd`: max delta (the upper bound for the score-credit this token authorises)
- `iat`: issued-at
- `exp`: expiry (`iat + ACTION_TOKEN_TTL_SECONDS`, default 5 minutes)

**Why**:
- **JWT format reuses `jose`**: same library, same parser, same alg verification path.
- **HS256 is symmetric**: the issuer and verifier share `ACTION_TOKEN_SECRET`. No JWKS fetch overhead.
- **Claim names are short**: `aid`, `atp`, `mxd` are the convention from JWT registered claims (3-character lowercase). Saves bytes per token.
- **`mxd` allows per-action delta caps**: the issuer can mint a token allowing `mxd: 100` for a "boss kill" action and `mxd: 1` for a "click" action. The verifier checks `body.delta <= mxd`.

**Alternatives considered**:
- **A custom binary token format** (Ed25519 signature, smaller bytes). Rejected — `IMPROVEMENTS.md I-SEC-01` notes Ed25519 as a post-MVP optimization.
- **An opaque token (random string) backed by Redis**. Rejected — requires a Redis lookup on every request, which trades the HMAC verify (microseconds) for a network round trip. JWT is faster for the v1 scale.

### Decision 4: Idempotency layer 2 lives in the controller's catch block, not in a separate interceptor

**What**: `ScoreboardController.incrementScore()` calls `handler.execute(cmd)` inside a `try/catch`. The catch block handles `IdempotencyViolationError` specially:
1. Read the prior `score_events` row by `actionId` from the repository.
2. Reconstruct the response DTO from the historical row (`{ userId, newScore: prior_total, rank: null, topChanged: null }`).
3. Return 200 with the historical DTO.
Other errors propagate to the (eventually) global exception filter.

**Why**:
- **Layer-2 replay is a legitimate success path**, not an exception. The catch block "translates the rare exception case back into a success" — exactly the contract of "retry with same actionId returns the same result without double-credit".
- **Keeping it in the controller** avoids creating a custom NestJS exception filter just for this one case.
- **No new abstraction**: the existing repository port gets one new method (`findScoreEventByActionId`). Easy to test.

**Alternatives considered**:
- **A NestJS exception filter** (`@Catch(IdempotencyViolationError)`). Rejected — requires registering a separate filter, fights with the global filter that lands in `step-04`.
- **The handler swallows the error and returns the prior outcome internally**. Rejected — couples the handler to the repository's `findScoreEventByActionId` method, which is really a controller-level concern (the handler's job is to *credit*, not to *replay*).

### Decision 5: Rate limit Lua script is loaded once at boot and called via `EVALSHA`

**What**: On `RateLimitModule` initialization, `redis.scriptLoad(luaSource)` runs once and stores the SHA1. Every request uses `redis.evalsha(sha, ...)`. On `NOSCRIPT` error (Redis flushed scripts), fall back to `redis.eval(luaSource, ...)` and re-cache.

**Why**:
- **`EVALSHA` avoids sending the script bytes per request**. ~50 bytes saved per request. Material at 1500 writes/sec.
- **`NOSCRIPT` fallback** handles Redis restarts and `SCRIPT FLUSH` cleanly without crashing.

**Alternatives considered**:
- **`EVAL` every time**. Rejected — wastes bandwidth.
- **A library like `rate-limiter-flexible`**. Considered, but the spec is explicit about a Lua token bucket, and the library adds 200KB for what's a 30-line Lua script.

### Decision 6: Global circuit breaker uses an in-process counter, not a Redis-backed one

**What**: The 5000-req/s aggregate ceiling is enforced by a per-instance counter resetting every second. With 3 replicas, the effective ceiling is ~15000 req/s aggregate, NOT 5000 strict.

**Why**:
- **`architecture.md` ADR-08 says "5000 req/sec aggregate"** — but ADR-12 says 3 stateless replicas. So "5000 aggregate" is interpreted as "5000 per instance, ~15000 total" for v1. Document this in design.md so reviewers don't think we're missing a feature.
- **Per-instance is fast**: an atomic counter increment costs nothing.
- **Cross-instance coordination would require Redis or another shared store**, adding latency to the hot path. Not justified for v1.

**Alternatives considered**:
- **Redis-based global counter** (`INCR`, expire). Rejected — adds a Redis call per request to enforce a soft ceiling. The actual throughput target (1500 writes/sec from NFR-02) is well below this.
- **Drop the global breaker entirely**. Rejected — having ANY global brake is better than none, and ADR-08 mandates one.

## Risks / Trade-offs

- **[Risk]** JWKS fetcher fails on app boot (network issue or wrong URL) → app crashes during boot → **Mitigation**: `JwksCache` is lazy — it fetches on first verify, not at boot. If the first request happens before JWKS is reachable, that request gets a 401 and the cache will retry on the next request. Document this in `step-07`'s readiness probe (the `/ready` endpoint should NOT depend on JWKS reachability).

- **[Risk]** Redis flush wipes loaded Lua scripts → first request after flush hits `NOSCRIPT` → **Mitigation**: catch `NOSCRIPT` in the rate-limit guard and fall back to `EVAL` once (which re-caches the script). Verified by an integration test in `step-04`.

- **[Risk]** Action token's `aid` is duplicated across two parallel "issue-token" calls (UUID collision) → **Mitigation**: UUID v4 collision probability is 1 in 2^122, negligible. The `SET NX EX 300 action:issued:<aid>` in the issuer additionally protects against duplicate issuance — if two issuance calls collide on `aid`, the second SETNX loses and the issuer re-rolls the UUID.

- **[Risk]** A user requests an action token, never consumes it, and the token expires → wasted `action:issued:<aid>` Redis key → **Mitigation**: the SETNX has `EX 300` matching the token TTL, so the key expires on its own. No leak.

- **[Risk]** The controller's local try/catch for idempotency replay competes with the (future) global exception filter from `step-04` → **Mitigation**: the local catch only handles `IdempotencyViolationError` and rethrows everything else. The global filter handles the rest. Confirmed compatible.

- **[Trade-off]** Layer-1 idempotency (Redis SETNX) is not atomic with the actual write — there's a race window where the SETNX succeeds, the handler crashes, and the row is never written. The next retry hits the SETNX (still set), gets `ACTION_ALREADY_CONSUMED`, but Postgres has nothing. Mitigation: the SETNX TTL is 24h (per ADR-07); the user can retry after the TTL with the same `actionId` and get a fresh attempt. Documented in design.md, accepted for v1. `step-05` will harden this when the outbox lands.

- **[Trade-off]** No per-route rate limit (e.g. `actions:issue-token` could be hammered to issue tokens). For v1, the per-user JWT-bound rate limit on `actions:issue-token` is the same as `scores:increment` — 10 req/s. If issuance becomes a problem, future stories can add a stricter ceiling.

## Open Questions

- **Q1: Should `ActionTokenGuard` consume the SETNX entry or just check it?** The spec says "one-shot consumption" — meaning the token can only be used once. **Default decision**: SETNX with `EX = ACTION_TOKEN_TTL_SECONDS` matches the token expiry; the token is consumed on first verification (the SETNX value is the request's outcome JSON). Subsequent attempts hit the SETNX, see the existing value, and short-circuit to a 403 with the prior outcome. The atomicity is the SETNX itself; no separate "consume" step needed.

- **Q2: What happens if `ACTION_TOKEN_SECRET` is shorter than 32 bytes despite the zod validation in `step-01`?** It can't, because `step-01`'s schema enforces `z.string().min(32)` — the boot fails first. No defensive check needed in the verifier.

- **Q3: Should the body schema for `POST /v1/scores:increment` be defined inline in the controller or in a dedicated DTO file?** **Default decision**: dedicated `src/scoreboard/interface/http/dto/increment-score.dto.ts` exporting a zod schema. Reused in tests. The controller uses `@nestjs/zod` (or a manual `parse()`) to validate.

- **Q4: How are errors mapped to HTTP codes inside the controller before `step-04`'s global filter lands?** **Default decision**: the controller has a small switch on the error type: `IdempotencyViolationError → 200 (replay)`, other `DomainError → 400`, `UnauthenticatedError → 401`, `ForbiddenError → 403`, default → 500. Once `step-04` adds the global filter, this switch is deleted.

- **Q5: Should the JWKS cache log a warning when it fetches a new key set?** **Default decision**: yes, at `info` level — but until the Pino logger lands in `step-04`, use `console.info`. Replace with the structured logger when available.
