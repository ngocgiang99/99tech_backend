## Why

The sibling `problem5/` module ships a set of small runtime utilities that problem6 doesn't have yet, and several of them address real failure modes that our architecture documents already worry about:

1. **Thundering-herd on leaderboard reads is a self-inflicted GAP-03 trigger.** Under NFR-01 (10k concurrent SSE connections), a reconnect storm after a deploy or split-brain recovery sends all clients to `GET /v1/leaderboard/stream`, each of which issues a `ZREVRANGE leaderboard:global 0 9 WITHSCORES` on connect for the initial snapshot. That's 10k Redis ops arriving within a few hundred milliseconds against a single hot key. This can saturate the ioredis connection pool, add latency to every write's `idempotency:action:*` SETNX, and — in the worst case — trip `RateLimitGuard`'s Redis `MaxRetriesPerRequestError` detection and push the write path into its fail-CLOSED state (step-07 DECISION-1). The herd causes the exact outage the fail-CLOSED is supposed to contain. problem5 has a tiny `Singleflight<T>` class that collapses concurrent in-flight fetches for the same key into one upstream call. Adopting it for the top-10 read removes the self-inflicted pressure.

2. **Graceful shutdown is not wired.** NestJS exposes `app.enableShutdownHooks()` + `OnApplicationShutdown` / `OnModuleDestroy` lifecycle, but problem6's `main.ts` doesn't enable them and no adapter implements them. On SIGTERM (Kubernetes rolling deploy), the process currently stops accepting new connections and exits — but the outbox publisher's Redis lock doesn't get released (another instance waits for the TTL to expire before it can claim leadership), the JetStream ephemeral consumer doesn't unsubscribe (JetStream waits `inactive_threshold=30s` to GC it), open SSE streams are cut mid-frame (every client sees a `network error` then reconnects in a surge), and ioredis is hard-closed (pending commands lost). Each of these is a small paper cut; together they turn a "rolling deploy" into a "coordinated alert storm." problem5 has a `ShutdownManager` class; problem6 should adopt the *discipline* — each stateful adapter implements its own cleanup method — even if the class itself is replaced by NestJS's built-in lifecycle hooks.

3. **Error logs are only rich when they flow through the HttpExceptionFilter.** The in-flight `restructure-error-handling-for-observability` change gives the filter structured metadata (errorId, walked cause chain, scrubbed headers, pgCode, etc.). But errors that happen *outside* the HTTP request path — in the outbox publisher, in bootstrap, in the NATS subscriber, in a background rebuild — don't go through the filter and don't get the same treatment. problem5 has a thin `logWithMetadata()` helper that lets any non-HTTP code path emit the same rich log payload. For problem6, this is the difference between "the 3am outbox failure logged `err.message`" and "the 3am outbox failure logged errorId, cause chain, request-adjacent context, and pgCode."

4. **The leaderboard `X-Cache-Status` header is asymmetric and not k6-friendly.** `leaderboard.controller.ts` already sets `X-Cache-Status: miss-fallback` on the Postgres fallback path, but the HIT path sets no header at all. k6 can detect a miss (via header presence) but cannot compute a hit *rate*, which is the metric the `scoreboard-testing` capability's load profile wants to assert on. problem5 uses this exact pattern (`x-cache.ts` middleware) to let k6 threshold assertions verify cache effectiveness. We want the same: a symmetric `X-Cache-Status: hit | miss` enum emitted by the controller so the step-07 k6 profile can assert `cache_hits rate > 0.95` in steady state and `rate < 0.10` during a Redis-killed fault-injection test. The rename from `miss-fallback` to `miss` is a minor public-envelope cleanup — no prod consumer, no documented contract.

None of these are blocking bugs today. All four are latent: the singleflight gap only bites under reconnect storms; the shutdown gap only bites during rolling deploys; the log helper only matters when a non-HTTP error happens; the cache header only matters when k6 asserts on it. But each has a cheap fix whose ROI is "prevent an incident before it happens."

This change does not touch auth, rate limiting, idempotency semantics, the outbox transactional contract, or the SSE fan-out shape. It adds utilities that those subsystems opt into or that are orthogonal to their control flow.

## What Changes

- **NEW (capability)**: `scoreboard-resilience` — owns three new primitives: the `Singleflight<T>` class, the `OnApplicationShutdown`-based graceful-shutdown discipline (documented as a capability contract, not a single class), and the `logWithMetadata()` helper. Lives at `src/scoreboard/shared/resilience/`.
- **NEW (code)**: `src/scoreboard/shared/resilience/singleflight.ts` — a generic `class Singleflight<T>` with `do(key, fn): Promise<T>` and a per-call timeout (default 3000ms; configurable via constructor options). Entry is cleared on resolve, reject, and timeout. `size()` is exposed for test assertions. ~70 LOC including the timeout helper.
- **NEW (code)**: Wire the singleflight into `LeaderboardCacheImpl.getTop(limit)`. Each instance of the cache adapter holds one `Singleflight<TopEntry[]>` keyed by `top:${limit}`. Writes (`upsert`, `getRank`) are NOT routed through singleflight — they're intrinsically per-user and not on the hot read path. Existing unit and integration tests remain green.
- **NEW (code)**: `src/scoreboard/shared/resilience/log-with-metadata.ts` — exports `logWithMetadata(logger, level, err, context?)`. Wraps the thrown value via `wrapUnknown()` (from `scoreboard-errors`), builds a minimal ErrorMetadata payload via `buildErrorMetadata()` (with a synthetic request stub — see design.md Decision 4), and emits a structured Pino-compatible log entry. Used by background jobs and bootstrap code paths that don't flow through `HttpExceptionFilter`. ~50 LOC.
- **MODIFIED (code)**: Six adapters implement `OnApplicationShutdown(signal)` (NestJS lifecycle hook):
    - `OutboxPublisher` — stops its poll loop, releases the Redis lock (`outbox:lock`) so another instance can pick up leadership immediately, awaits any in-flight `publish()` call.
    - `JetStreamEventPublisher` — flushes pending publishes via NATS's `drain()`, closes the connection.
    - `JetStreamSubscriber` — unsubscribes the ephemeral push consumer cleanly so JetStream doesn't wait `ack_wait` to GC it.
    - `StreamController` (SSE fan-out controller) — sends a final `event: shutdown` frame to each open stream and closes them with a clean HTTP end, so clients see a deterministic close rather than a mid-frame TCP RST.
    - `RedisClient` provider — calls `redis.quit()` (not `disconnect()`) to drain pending commands.
    - `NatsClient` provider — calls `nats.drain()` to flush pending publishes before close.
- **MODIFIED (code)**: `src/main.ts` calls `app.enableShutdownHooks()` after `app.useGlobalFilters(...)` and before `app.listen(port)`. No env var changes; the shutdown timeout is controlled by NestJS's default (indefinite — each hook runs to completion). If any hook hangs, `main.ts` wraps `app.enableShutdownHooks()` with a 10-second overall timeout sentinel that calls `process.exit(1)` — this is the `ShutdownManager.timeoutMs` semantic from problem5, expressed via `setTimeout(unref=true)` around the Nest teardown.
- **MODIFIED (code)**: `src/scoreboard/interface/http/controllers/leaderboard.controller.ts` — symmetric `X-Cache-Status` header:
    - HIT path (`entries.length > 0`): set `X-Cache-Status: hit`
    - MISS path (Postgres fallback): set `X-Cache-Status: miss` (renamed from `miss-fallback`)
    - The empty-leaderboard edge case (Redis HIT returning zero entries, Postgres fallback also returning zero entries) is treated as `hit` — the empty-but-consistent cache is a legitimate cache hit, not a miss. This is a minor behavior refinement documented in design.md Decision 9.
- **MODIFIED (spec)**: `scoreboard-leaderboard` gets a new requirement: "GET /v1/leaderboard/top emits X-Cache-Status: hit|miss for load-test observability."
- **MODIFIED (spec)**: `scoreboard-ops` gets a new requirement: "Graceful shutdown hooks on all stateful adapters."
- **MODIFIED (spec)**: `scoreboard-observability` gets a new requirement: "logWithMetadata() helper exists for non-HTTP error paths." (This is the one item in this change that *depends* on `restructure-error-handling-for-observability` landing first — see Impact below.)
- **NOT CHANGED**: NestJS framework version. Fastify version. Any env var. Any database schema. Any Redis keyspace shape. Auth behavior. Rate limit semantics. Idempotency contract. SSE fan-out semantics.

## Capabilities

### New Capabilities

- `scoreboard-resilience`: Owns runtime-resilience primitives — the `Singleflight<T>` class for collapsing concurrent fetches, the graceful-shutdown discipline (each stateful adapter implements `OnApplicationShutdown`), and the `logWithMetadata()` helper for structured error logging outside the HTTP filter path. This is the capability that "prevents the incident before it happens" — each primitive addresses a latent failure mode that only surfaces under load or during lifecycle transitions.

### Modified Capabilities

- `scoreboard-leaderboard`: Adds the symmetric `X-Cache-Status` header to `GET /v1/leaderboard/top`. The HIT path (served from Redis ZSET) emits `X-Cache-Status: hit`; the MISS path (Postgres fallback) emits `X-Cache-Status: miss`. This enables k6 threshold assertions on cache hit rate as part of the `scoreboard-testing` load profile.
- `scoreboard-ops`: Adds the graceful-shutdown requirement — six stateful adapters implement `OnApplicationShutdown`, and `main.ts` enables NestJS shutdown hooks with a 10-second overall timeout sentinel.
- `scoreboard-observability`: Adds the `logWithMetadata()` requirement. Note: this one spec delta has a dependency on the `restructure-error-handling-for-observability` change landing first, because the helper reuses that change's `wrapUnknown()` and `buildErrorMetadata()` primitives. Apply order: error-restructure → this change.

## Impact

**New code (~250 LOC):**
- `src/scoreboard/shared/resilience/singleflight.ts` (~70 LOC)
- `src/scoreboard/shared/resilience/log-with-metadata.ts` (~50 LOC)
- `src/scoreboard/shared/resilience/index.ts` (barrel export, ~10 LOC)
- Six `OnApplicationShutdown` implementations, ~15 LOC each (~90 LOC total)
- `main.ts` shutdown wiring + overall timeout (~15 LOC)
- `leaderboard.controller.ts` X-Cache-Status header edits (~5 LOC)

**Modified code (~15 LOC):**
- `leaderboard-cache.impl.ts` — instantiate `Singleflight<TopEntry[]>` in constructor, wrap `getTop(limit)` call
- Existing test in `leaderboard.controller.test.ts` — assert the header

**New tests (~200 LOC):**
- `test/unit/shared/resilience/singleflight.test.ts` — concurrent callers share a promise, entry cleared on resolve/reject/timeout, timeout rejects and clears, size() reports in-flight count, different keys are independent, rejected promise doesn't leak across callers (~100 LOC)
- `test/unit/shared/resilience/log-with-metadata.test.ts` — wraps unknown errors, builds metadata via the barrel, emits at the requested level, context fields merged (~50 LOC)
- `test/unit/scoreboard/infrastructure/outbox/outbox-publisher.test.ts` — new scenarios for onApplicationShutdown: stop poll, release lock, await in-flight publish (~30 LOC)
- `test/unit/interface/http/controllers/leaderboard.controller.test.ts` — existing test updated to assert `X-Cache-Status: hit` on the HIT path and `X-Cache-Status: miss` on the MISS path (~20 LOC)

**Dependency on another in-flight change:**
- Item 3 (`logWithMetadata`) requires `restructure-error-handling-for-observability` to land first. Items 1 (singleflight), 2 (shutdown hooks), and 4 (X-Cache-Status) have no such dependency and could technically ship today against main. Design.md Decision 5 documents why we keep all four in one change despite the dependency (one review, one coherent theme, one archive entry).

**Operational consequences:**
- Reduced Redis load during reconnect storms (singleflight collapses N concurrent top-10 reads into 1).
- Faster rolling deploys — the outbox Redis lock is released immediately instead of waiting for its 10-second TTL.
- Fewer "network error" reconnect storms from clients during rolling deploys (SSE streams close cleanly).
- k6 load tests can assert on cache hit rate — a new signal for CI regression detection.
- Non-HTTP error paths (outbox failures, bootstrap errors, background jobs) produce structured logs with the same richness as HTTP errors, making night-owl debugging consistent.

**No breaking changes:**
- API contract unchanged.
- Env vars unchanged.
- Database schema unchanged.
- The `X-Cache-Status` header rename (`miss-fallback` → `miss`) is technically a public-response change, but there is no prod release, no documented contract, and no downstream consumer today. The header is explicitly informational (documented as a "load-test observability signal" in spec + infra README).

**Out of scope:**
- Rate limiter middleware port (problem5's IP-based limiter). Different threat model — problem6's per-user limiter from step-03 is correct for the authenticated write path, and edge-level IP limiting is ingress-level responsibility. A one-line note added to `infra/README.md` makes the division of responsibility explicit.
- Pluggable HealthCheckRegistry (problem5's pattern for adapters registering their own pings). Low-value refactor for 3 hardcoded pings; skip until there's a fourth dependency.
- Metrics label allowlist policy enforcement (problem5's `as const` tuples for label values). Policy discussion, not code — worth mentioning in CLAUDE.md or code review guidelines, but not a code change.
- OpenTelemetry span-level integration for graceful shutdown events. Adapters log on shutdown but don't emit OTel spans for the teardown lifecycle. Deferred as a separate concern.
- Circuit breakers or retry logic around Redis / NATS / Postgres. Out of scope; the existing fail-CLOSED and layer-2 fallback behaviors are the defense contract.
