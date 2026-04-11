## Context

problem5 ships a small set of runtime-resilience utilities that problem6 doesn't have yet. Three of them address latent failure modes already documented in problem6's architecture (GAP-03, deploy smoothness, error observability for non-HTTP paths), and one is a k6 load-test observability hook (`X-Cache-Status`). This change adopts the four that fit problem6's NestJS/Fastify stack and its specific threat model.

The comparison that surfaced this work (`/opsx:explore` session, April 2026) graded 11 problem5 utilities. Four were already planned via the `restructure-error-handling-for-observability` change. Four are worth adopting here (singleflight, graceful shutdown, logWithMetadata, X-Cache-Status). The remaining three were ruled out: x-cache as a response-cache header (not applicable — problem6 has no upstream cache layer), request-id (already done in step-04 via the Fastify onRequest hook), and the IP-based rate limiter (different threat model — edge-level concern that belongs at ingress).

**Current state — what exists today:**
- `src/scoreboard/infrastructure/persistence/redis/leaderboard-cache.impl.ts` — the `LeaderboardCacheImpl.getTop(limit)` method directly issues `redis.zrevrange(...)` per call. No deduplication. A reconnect storm with 10,000 clients produces 10,000 Redis ops.
- `src/scoreboard/interface/http/controllers/leaderboard.controller.ts` — the HIT path (entries.length > 0) returns without setting any cache header; the MISS path sets `X-Cache-Status: miss-fallback`. Asymmetric — k6 cannot compute a hit rate from an absent header.
- `src/main.ts` — bootstraps NestJS, registers the global filter, listens on the port. No `app.enableShutdownHooks()` call, no SIGTERM handling. On shutdown, the process stops accepting connections and exits; resource cleanup is best-effort via ioredis/nats auto-close, which does not release the outbox Redis lock, does not unsubscribe the JetStream consumer, and does not close SSE streams cleanly.
- `src/scoreboard/infrastructure/outbox/outbox.publisher.ts` (step-05 output) — runs a poll loop with a Redis leader lock. The lock has a 10s TTL by default; if the process dies mid-lock, the replacement instance waits up to 10 seconds to claim leadership.
- `src/scoreboard/infrastructure/messaging/nats/jetstream.subscriber.ts` (step-06 output) — creates an ephemeral push consumer on boot with `inactive_threshold=30s`. If the subscriber never unsubscribes, JetStream waits the full threshold to GC the consumer, temporarily wasting a consumer slot.
- Non-HTTP error paths (outbox publisher's catch blocks, NATS subscriber's message handlers, bootstrap code in `main.ts`) emit errors via `logger.error(err.message, err.stack)` — a two-argument string concatenation. No errorId, no cause chain, no request context. Nothing like the rich metadata the in-flight `restructure-error-handling-for-observability` change gives the HTTP filter.

**Current state — what's already in flight:**
- The `restructure-error-handling-for-observability` change (proposal + design + specs + tasks all written, not yet applied) introduces the `DomainError` hierarchy, `wrapUnknown()`, `buildErrorMetadata()`, `scrubHeaders`, `mapDbError`, `toPublicResponse` primitives in `src/scoreboard/shared/errors/`. The `logWithMetadata()` helper in this change reuses those primitives. Apply order is therefore error-restructure → this change.

**Constraints that shape the decisions below:**
- NestJS has a built-in `OnApplicationShutdown` lifecycle hook. This change must use it rather than invent a parallel `ShutdownManager` class, because duplicating the framework's lifecycle management is a bug magnet.
- Singleflight is a per-process primitive. It cannot dedupe across pods. For 10k SSE clients hashed across 3 pods, each pod sees ~3333 concurrent callers; singleflight collapses each pod's share to 1 Redis op, for a total of 3 Redis ops instead of 10,000. This is the correct semantic — we want each pod's Redis pool protected, not a global lock.
- The singleflight timeout must be shorter than the HTTP handler timeout. If a fetch hangs, singleflight rejects all waiters so they can surface a clean 5xx rather than having the HTTP layer time them out individually.
- `logWithMetadata()` needs a way to build ErrorMetadata without a real Fastify request object — the helper's entire purpose is to run in contexts where there is no active request. The metadata builder must accept a synthetic request stub or an optional request parameter.
- SSE stream cleanup during shutdown is subtle. The browser's `EventSource` treats a clean server close as "connection closed, reconnect later" — exactly the desired behavior. An abrupt TCP RST is treated as "network error, reconnect now" which produces the thundering herd. The difference is one well-placed `response.end()` per stream.

## Goals / Non-Goals

**Goals:**
- A `Singleflight<T>` primitive exists under `src/scoreboard/shared/resilience/` with a clean API (`do(key, fn): Promise<T>`) and per-call timeout.
- `LeaderboardCacheImpl.getTop(limit)` routes through an instance-scoped `Singleflight<TopEntry[]>`. Concurrent callers for the same `limit` share one Redis call.
- `main.ts` calls `app.enableShutdownHooks()` after filters are registered and before `app.listen()`.
- Six stateful adapters implement `OnApplicationShutdown(signal)` with specific cleanup semantics: outbox publisher releases its lock, JetStream publisher drains pending publishes, JetStream subscriber unsubscribes, SSE controller closes open streams, Redis client quits (drains), NATS client drains.
- `main.ts` has a 10-second overall shutdown timeout sentinel. If NestJS's teardown hasn't completed by then, the process force-exits with code 1 and a log line.
- A `logWithMetadata(logger, level, err, context?)` helper exists at `src/scoreboard/shared/resilience/log-with-metadata.ts`, wraps errors via `wrapUnknown()` (from `scoreboard-errors`), builds metadata via `buildErrorMetadata()`, and emits a structured log entry.
- `leaderboard.controller.ts` emits `X-Cache-Status: hit` on the HIT path and `X-Cache-Status: miss` on the MISS path (rename from `miss-fallback`). Empty-leaderboard-but-cache-consistent is treated as `hit`.
- Comprehensive unit tests for the singleflight primitive (concurrency, timeout, cleanup, independent keys), the log helper (branches, metadata shape), and the shutdown hooks (each adapter's cleanup method).
- Spec deltas for `scoreboard-resilience` (NEW), `scoreboard-leaderboard` (MODIFIED — header), `scoreboard-ops` (MODIFIED — shutdown), `scoreboard-observability` (MODIFIED — logWithMetadata).

**Non-Goals:**
- Cross-pod singleflight. A Redis-based distributed lock would be the tool for that, and it's the wrong tool — it would serialize top-10 reads across the cluster and create a different bottleneck.
- Custom `ShutdownManager` class. Use NestJS's `OnApplicationShutdown` lifecycle; do not invent a parallel abstraction.
- Circuit breakers around Redis/NATS/Postgres. Fail-CLOSED + layer-2 fallback is the contract.
- Retries inside singleflight. A failed fetch rejects all waiters; they each decide whether to retry.
- Applying `logWithMetadata()` to every existing `logger.error(...)` call site as a mass refactor. Ride-along: migrate call sites opportunistically in future changes, not as part of this one. This change adds the helper and validates it against one or two natural call sites (outbox publisher catch block, main.ts bootstrap failure handler) but does not do a sweep.
- Changing the 10-second shutdown timeout into a config knob. Hardcoded; revisit if an adapter legitimately needs longer (e.g. flushing a large JetStream batch).
- IP-based rate limiting. Deferred as ingress-layer responsibility; documented in `infra/README.md`.
- Pluggable HealthCheckRegistry. Out of scope; the hardcoded HealthService is fine for three dependencies.
- OpenTelemetry integration for shutdown events. Log-only for now.

## Decisions

### Decision 1 — Singleflight file layout and the per-key Map

**Decision**: The class lives at `src/scoreboard/shared/resilience/singleflight.ts`. The implementation mirrors problem5's `Singleflight<T>` almost verbatim: one `Map<string, Promise<T>>` as in-flight registry, a constructor-supplied default timeout (3000ms, overridable), a `runWithTimeout` helper that races the supplied function against `setTimeout(unref=true)`, and a `.finally(() => inflight.delete(key))` cleanup on every terminal state (resolve, reject, timeout).

The key design choice: the Promise stored in the Map is the *wrapped* promise (with timeout applied and cleanup attached), not the raw `fn()` return. This means every caller sees the same timeout semantics — the first caller's fn creates the promise; subsequent callers await the already-created promise; when it resolves/rejects/times out, everyone sees the same outcome.

**Rationale**: Simplest correct thing. The problem5 implementation has been battle-tested within the repo's conventions; direct adoption saves design cycles. The only change: import path uses TypeScript's NodeNext-style relative imports (no `.js` extension).

**Alternatives rejected**:
- *Use `p-memoize` from npm*: rejected — adds a dependency for a 70-line file.
- *Store the raw fn promise and layer timeout separately*: rejected — timeout handling becomes inconsistent across callers.
- *Use a `WeakMap`*: rejected — string keys don't support weak references.

### Decision 2 — One `Singleflight` instance per `LeaderboardCacheImpl`, key = `top:${limit}`

**Decision**: The `LeaderboardCacheImpl` constructor instantiates `new Singleflight<TopEntry[]>()` and stores it as a private field. The `getTop(limit)` method wraps its Redis call:

```ts
async getTop(limit: number): Promise<TopEntry[]> {
  return this.topReadSingleflight.do(`top:${limit}`, async () => {
    const raw = await this.redis.zrevrange(KEY, 0, limit - 1, 'WITHSCORES');
    return parseZrevrangeReply(raw);
  });
}
```

The key is `top:${limit}` so different limits get independent in-flight entries. In practice the only limit anyone calls is 10, so there's effectively one entry ever; but the key includes limit for correctness.

Other methods on `LeaderboardCacheImpl` (`upsert`, `getRank`, `size`) are NOT wrapped. Per-user upserts don't thunder; `getRank` is a different Redis call shape and can be added to singleflight later if it becomes a hot path.

**Rationale**: Instance-scoped (not module-scoped) so test isolation works — each test instantiates its own cache with its own singleflight. Per-cache (not cross-cache) scope matches the single-pod semantics — we want each pod's Redis pool protected, not a global lock.

**Alternatives rejected**:
- *Module-level singleton singleflight*: rejected — fights DI, breaks test isolation, and encourages the wrong mental model (cross-instance dedup is not what we want).
- *Cache the result and serve it from a local TTL cache*: rejected — that's a different primitive (LRU/TTL cache), and it introduces staleness that the outbox fan-out is specifically designed to prevent. Singleflight is strictly stronger: it only dedupes *in-flight* calls; it doesn't hold stale results.

### Decision 3 — Singleflight timeout vs. HTTP timeout

**Decision**: Default timeout is 3000ms, matching problem5. This MUST be less than or equal to the effective HTTP handler timeout so that a hung Redis call surfaces as a `503 TEMPORARILY_UNAVAILABLE` via `wrapUnknown()` (the singleflight timeout produces an `Error: singleflight: timed out after 3000ms` that `wrapUnknown()` routes through the Redis-infrastructure branch and into `DependencyUnavailableError`).

If the HTTP handler timeout is < 3000ms in any environment, the singleflight timeout must be adjusted to stay lower. This is called out in a unit test assertion: `singleflight.timeoutMs` is read and compared against a documented bound. If step-07 adds a request-level timeout middleware, revisit.

**Rationale**: A slower Redis call should not hang every SSE handshake for 10 seconds. The 3-second bound is aggressive enough to fail fast without being so tight that a brief GC pause triggers it.

**Alternatives rejected**:
- *Make the timeout infinite*: rejected — a hung Redis call would hang every waiter indefinitely.
- *Timeout = 100ms*: rejected — too aggressive; normal ioredis tail latency on a loaded Redis can exceed this, causing spurious failures.

### Decision 4 — `logWithMetadata` accepts an optional `context` bag and a synthetic request stub

**Decision**: The helper's signature is:

```ts
function logWithMetadata(
  logger: Logger,                    // nestjs/common Logger or pino.Logger
  level: 'warn' | 'error' | 'fatal',
  err: unknown,
  context: Record<string, unknown> = {},
): void
```

It does NOT take a request parameter. Instead, it constructs a synthetic request stub for `buildErrorMetadata()`:

```ts
const syntheticRequest = {
  requestId: null,
  method: 'BACKGROUND',
  routeOptions: { url: context.source ?? '__background' },
  url: '',
  headers: {},
} as unknown as FastifyRequest & { requestId?: string };
```

The `context` bag is merged into the log entry alongside the metadata object as a sibling field, not inside the metadata itself. This lets background jobs pass structured context like `{ job: 'outbox-publish', aggregateId: 'user-123' }` without polluting the request-shaped metadata fields.

**Rationale**: The helper's whole purpose is non-HTTP paths. Forcing callers to fabricate a request object would be terrible UX. The synthetic stub is invisible to callers and produces metadata fields that look distinct from HTTP errors (method `BACKGROUND`, route `__background` unless overridden via `context.source`).

**Alternatives rejected**:
- *Make `buildErrorMetadata()` accept an explicit "is-background" mode*: rejected — adds complexity to the error subsystem for a single caller.
- *Second helper: `logBackgroundError()` with its own metadata shape*: rejected — two log formats is worse than one slightly-stubbed format.

### Decision 5 — Single change despite the dependency on `restructure-error-handling-for-observability`

**Decision**: All four items (singleflight, shutdown, log helper, X-Cache-Status) ship as one openspec change, even though items 1, 2, and 4 are dependency-free and item 3 requires the error-restructure change to land first. Apply order is enforced by the operator: error-restructure first, then this change.

**Rationale**: One review, one archive entry, one coherent "runtime resilience" theme. The alternative (split into two changes) creates two reviews, two archives, and two sets of openspec ceremony for no meaningful reduction in review burden.

If the error-restructure change is delayed significantly, items 1, 2, and 4 can be split out in a follow-up by the operator — but that's not the expected path.

**Alternatives rejected**:
- *Two changes (dependency-free items + dependent item)*: rejected — doubled ceremony, fragmented theme.
- *Block this change until error-restructure is applied*: rejected — we want the artifacts written now so the operator can schedule both.

### Decision 6 — Adapter-by-adapter shutdown hook contracts

**Decision**: Each adapter's `onApplicationShutdown(signal)` method has a specific contract. The table below is normative — the tasks.md task for each adapter cites this decision for the exact steps.

```
OutboxPublisher.onApplicationShutdown(signal):
  1. Set this.shuttingDown = true (stop the poll loop)
  2. Await this.currentPublishPromise (if one is in flight)
  3. Release the Redis lock: del('outbox:lock')  (best-effort, ignore errors)
  4. Log 'outbox publisher stopped' with signal field

JetStreamEventPublisher.onApplicationShutdown(signal):
  1. Call nats.drain()  (waits for in-flight publishes to ack)
  2. Log 'jetstream publisher drained' with signal field

JetStreamSubscriber.onApplicationShutdown(signal):
  1. If subscription exists: await subscription.unsubscribe()
     (NATS ephemeral consumer — server GCs it immediately on unsub)
  2. Log 'jetstream subscriber unsubscribed' with signal field

StreamController (SSE fan-out).onApplicationShutdown(signal):
  1. For each open stream in this.openStreams:
       a. Write 'event: shutdown\ndata: {"reason":"graceful"}\n\n'
       b. Call reply.raw.end()
       c. Remove from openStreams set
  2. Log 'sse streams closed' with count field

RedisClient provider.onApplicationShutdown(signal):
  1. Call redis.quit()  (drains pending commands, closes connection)
     NOT disconnect() — disconnect drops pending commands

NatsClient provider.onApplicationShutdown(signal):
  1. Call nats.drain()  (idempotent with the JetStreamEventPublisher
     drain — drain() is safe to call multiple times)
  2. Call nats.close()
```

**Rationale**: Each contract answers one question: *"what external state does this adapter hold that another instance or client needs to observe the cleanup of?"* — the outbox lock, the JetStream consumer slot, the SSE connections, the Redis command queue.

**Order of cleanup**: NestJS orchestrates adapters in reverse dependency order — leaf providers shut down first. In practice this means `OutboxPublisher` and `JetStreamSubscriber` shut down before `RedisClient` / `NatsClient`, which is exactly the desired order (publishers/subscribers release handles before the transports close). This is Nest's default behavior; no manual ordering required.

**Alternatives rejected**:
- *Put everything in a single `ShutdownManager` class that NestJS calls*: rejected — defeats DI, breaks NestJS's per-provider lifecycle.
- *Use `OnModuleDestroy` instead of `OnApplicationShutdown`*: rejected — `OnModuleDestroy` doesn't receive the signal parameter, and `OnApplicationShutdown` is specifically the hook NestJS documents for signal-triggered shutdown.

### Decision 7 — 10-second overall timeout sentinel in `main.ts`

**Decision**: `main.ts` wraps the process-level SIGTERM handling with a 10-second sentinel:

```ts
async function bootstrap() {
  const app = await NestFactory.create(...);
  app.enableShutdownHooks();
  // ... filter registration, listen, etc.
}

// Outside bootstrap, after the app is up:
process.on('SIGTERM', () => {
  const forceExitTimer = setTimeout(() => {
    logger.warn('Shutdown timeout exceeded — forcing exit');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref?.();
  // NestJS's enableShutdownHooks will run its own teardown;
  // this sentinel only fires if that teardown hangs.
});
```

The `unref()` call ensures the timer doesn't keep the event loop alive if everything else drains cleanly.

**Rationale**: Without this, a bug in any single adapter's `onApplicationShutdown` could hang the whole process indefinitely on SIGTERM. Kubernetes would eventually SIGKILL after its `terminationGracePeriodSeconds` (default 30s), which is sloppy. A 10-second sentinel with a log line gives us early warning and a clean exit code.

**Alternatives rejected**:
- *Rely on Kubernetes SIGKILL*: rejected — no log, no exit code signal.
- *Infinite wait*: rejected — turns one stuck hook into a deploy-halting incident.
- *Configurable timeout via env var*: rejected — 10s is a sane default; the tasks.md includes a note for operators who need to adjust.

### Decision 8 — SSE stream cleanup: send a shutdown frame before closing

**Decision**: `StreamController.onApplicationShutdown()` sends the following frame on each open stream before calling `reply.raw.end()`:

```
event: shutdown
data: {"reason":"graceful"}

```

(Note the double newline at the end — SSE frames are terminated by `\n\n`.)

Clients using `EventSource` see this as a regular event; application code can listen for `event: shutdown` and initiate a graceful reconnect to a different pod. Clients that don't listen for the event simply see the stream end and auto-reconnect per the `EventSource` spec.

**Rationale**: The alternative — abrupt TCP close — produces a `network error` in the browser, which triggers auto-reconnect in a burst (all clients reconnect simultaneously at the next RTT). Sending a shutdown frame first gives well-behaved clients a chance to schedule their reconnect over a spread window.

**Alternatives rejected**:
- *Send a `:` comment line instead*: rejected — comments are advisory per the SSE spec; event frames are the "please listen" pattern.
- *Use a longer reason string*: rejected — short is better for a frame every client receives.

### Decision 9 — Empty leaderboard → `X-Cache-Status: hit`

**Decision**: The controller's current logic uses `entries.length > 0` as the cache-hit signal. This is incorrect in one edge case: an empty leaderboard (no users, or all users at score 0) produces an empty Redis reply — not a cache miss — and the controller currently treats it as a miss and falls through to Postgres.

After this change, the controller SHALL treat the Redis response as authoritative: if `redis.zrevrange(...)` succeeds (no throw), the cache is considered to have answered the question, and `X-Cache-Status: hit` is emitted regardless of whether the result is empty.

The Postgres fallback is reached ONLY when the Redis call throws (connection error, timeout, etc.), at which point the fallback emits `X-Cache-Status: miss`. This matches what k6 wants to measure: "the Redis layer is serving reads" vs "we're falling through to Postgres."

**Rationale**: The empty-leaderboard case is a legitimate consistent cache state, not a miss. Treating it as a miss would inflate the miss-rate metric during early-stage deploys (zero users) or quiet periods.

**Implementation detail**: The controller wraps the Redis call in a try/catch. The try path emits `hit` and returns whatever entries Redis gave (possibly empty). The catch path emits `miss`, runs the Postgres query, and returns those entries.

**Alternatives rejected**:
- *Treat empty Redis as miss (current behavior)*: rejected — pollutes the metric and is semantically wrong.
- *Emit a third value `empty`*: rejected — k6 wants a binary signal; three states complicates threshold assertions.

### Decision 10 — X-Cache-Status header name and value enum

**Decision**: The header name is `X-Cache-Status` (the current value problem6 uses, not `X-Cache` which problem5 uses). Values are the enum `{ 'hit', 'miss' }`. The rename from the current `miss-fallback` value to `miss` is a minor cleanup documented in proposal.md.

**Rationale**: `X-Cache-Status` is more explicit than `X-Cache`; stick with the name already present in problem6's code. The value rename is one edit, one test update, one spec delta.

**Alternatives rejected**:
- *Rename to `X-Cache` for problem5 parity*: rejected — churn without benefit; problem5's name convention is not a standard, and problem6's existing name is already clear.
- *Keep `miss-fallback`*: rejected — ambiguous, longer, and k6 assertions would need to match on a compound string.

## Risks / Trade-offs

- **[Singleflight could hide Redis latency regressions]** → If `zrevrange` slows down and singleflight deduplicates, only one caller pays the latency; the others inherit it via the shared promise. This could mask a real perf problem. Mitigation: the existing `scoreboard_http_request_duration_seconds` histogram still captures the end-to-end latency, and Redis command latency is captured by `scoreboard_cache_operation_duration_seconds` (step-04). The mask is on *throughput* not *latency*, so the monitoring stack still alarms correctly.
- **[Shutdown hooks can reintroduce bugs]** → An `onApplicationShutdown` that throws or hangs turns a clean SIGTERM into a messy one. Mitigation: Decision 7's 10-second sentinel bounds the damage; each hook is unit-tested; the tasks.md explicitly requires manual smoke-tests with SIGTERM on the dev stack before merging.
- **[Dependency on the error-restructure change]** → `logWithMetadata` is the one part of this change that can't land until `restructure-error-handling-for-observability` is applied. Mitigation: proposal.md calls this out explicitly; the apply order is documented; the operator is responsible for sequencing.
- **[X-Cache-Status rename is technically a public-response break]** → `miss-fallback` → `miss`. Mitigation: no prod release, no documented consumer, the header is explicitly test-observability infrastructure. The spec and infra README flag it as non-contractual.
- **[SSE shutdown frame is not in the SSE spec]** → `event: shutdown` is an application-level convention. Non-browser clients may not recognize it. Mitigation: browsers (the primary client per NFR-01) handle it correctly because an unknown event name just fires `onmessage` or is silently ignored. The frame's real purpose is to let the raw TCP connection close gracefully; the event name is advisory.
- **[Singleflight adds per-request overhead for cold paths]** → Every `getTop()` call now checks a Map before doing anything. Overhead is ~microseconds; irrelevant at the request scale.
- **[NATS drain() behavior differs across NATS.js versions]** → Mitigation: pin the NATS.js version in `package.json` (already done by step-01), and the unit tests use the same version mocked out.
- **[Test isolation for singleflight]** → Tests that run the same `getTop(limit)` concurrently must observe deduplication. Use `Promise.all([cache.getTop(10), cache.getTop(10)])` and assert `redis.zrevrange` was called exactly once. Mitigation: the test file includes a concurrency helper.

## Migration Plan

1. Land `restructure-error-handling-for-observability` first (its own archive). Verify the `DomainError` hierarchy and `buildErrorMetadata` are importable from `src/scoreboard/shared/errors/`.
2. Apply this change:
    - Group 1: `Singleflight<T>` primitive + unit tests (standalone, can merge any time after step 1).
    - Group 2: Wire singleflight into `LeaderboardCacheImpl` + update its existing tests.
    - Group 3: `logWithMetadata` helper + unit tests. **Requires step 1.**
    - Group 4: X-Cache-Status header fix in `leaderboard.controller.ts` + test update.
    - Group 5: Six adapter `onApplicationShutdown` implementations + unit tests per adapter.
    - Group 6: `main.ts` wiring — `enableShutdownHooks()` + the 10-second sentinel.
    - Group 7: Manual smoke test on the dev stack: `mise run dev`, SIGTERM the process, observe the log output and confirm all six adapter cleanup lines fire in dependency order.
    - Group 8: Spec validation via `openspec validate`.

**Rollback**: Each group is independently revertible. Singleflight can be removed by dropping the wrap in `LeaderboardCacheImpl` and deleting the class file. Shutdown hooks can be removed by deleting the `onApplicationShutdown` methods (no interface constraint to violate). The X-Cache-Status header change can be reverted by re-adding the `miss-fallback` value. The log helper is strictly additive — nothing depends on it.

## Open Questions

None. The exploration session resolved all four items' scope, dependency ordering, and spec impact. The only operator decision left is when to apply this change relative to `restructure-error-handling-for-observability` — and that's sequencing, not design.
