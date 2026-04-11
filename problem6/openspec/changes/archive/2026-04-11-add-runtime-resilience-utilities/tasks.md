## 1. Singleflight primitive

- [x] 1.1 Create `src/scoreboard/shared/resilience/singleflight.ts`
- [x] 1.2 Implement `class Singleflight<T>` with: private `inflight: Map<string, Promise<T>>`, private `timeoutMs: number`, constructor accepting `{ timeoutMs?: number }` (default 3000)
- [x] 1.3 Implement `do(key: string, fn: () => Promise<T>): Promise<T>` — check `inflight.get(key)`, return existing promise if present, otherwise call `runWithTimeout(fn)` with `.finally(() => inflight.delete(key))` and set in map
- [x] 1.4 Implement private `runWithTimeout(fn)` — wrap `fn()` in a new `Promise` that races against `setTimeout(reject, timeoutMs)`, `timer.unref?.()`, clear the timer on both branches
- [x] 1.5 Implement `size(): number` returning `inflight.size` for test assertions
- [x] 1.6 Create `test/unit/shared/resilience/singleflight.test.ts`
- [x] 1.7 Test: 10 concurrent callers for the same key → fn called once, all receive same value, size is 0 after settle
- [x] 1.8 Test: different keys are independent → fn called twice for A and B
- [x] 1.9 Test: rejected fn rejects all waiters, size is 0, subsequent call invokes fresh fn
- [x] 1.10 Test: timeout with `timeoutMs: 100` rejects after ~100ms with error matching `/singleflight: timed out after 100ms/`, size is 0
- [x] 1.11 Test: sequential callers always invoke fn (no historical caching)
- [x] 1.12 Run `mise run test -- test/unit/shared/resilience/singleflight.test.ts` — all green

## 2. Wire Singleflight into LeaderboardCacheImpl

- [x] 2.1 Open `src/scoreboard/infrastructure/persistence/redis/leaderboard-cache.impl.ts`
- [x] 2.2 Import `Singleflight` from the resilience barrel (created in Task 8.2)
- [x] 2.3 Add a private field `private readonly topReadSingleflight = new Singleflight<TopEntry[]>()` in the constructor (or class body)
- [x] 2.4 In `getTop(limit)`, wrap the Redis call: `return this.topReadSingleflight.do(\`top:${limit}\`, async () => { /* existing Redis + parse logic */ })`
- [x] 2.5 DO NOT wrap `upsert`, `getRank`, or `size` — leave those untouched
- [x] 2.6 Update existing `test/integration/leaderboard/leaderboard-cache.test.ts` (or the unit equivalent) — add one test scenario: 100 concurrent `getTop(10)` calls → assert `redis.zrevrange` invoked exactly once
- [x] 2.7 Run `mise run test -- test/integration/leaderboard` — confirm all green (existing + new)

## 3. logWithMetadata helper (requires restructure-error-handling-for-observability)

- [x] 3.1 Verify `src/scoreboard/shared/errors/index.ts` exists and exports `wrapUnknown` and `buildErrorMetadata` — if not, stop and land `restructure-error-handling-for-observability` first
- [x] 3.2 Create `src/scoreboard/shared/resilience/log-with-metadata.ts`
- [x] 3.3 Import `wrapUnknown`, `buildErrorMetadata` from `../errors`
- [x] 3.4 Define the signature: `export function logWithMetadata(logger: Logger, level: 'warn' | 'error' | 'fatal', err: unknown, context: Record<string, unknown> = {}): void`
- [x] 3.5 Build a synthetic request stub: `{ requestId: null, method: 'BACKGROUND', routeOptions: { url: (context['source'] as string) ?? '__background' }, url: '', headers: {} }` cast to the metadata builder's expected shape
- [x] 3.6 Call `wrapUnknown(err)` to get a `DomainError`
- [x] 3.7 Call `buildErrorMetadata(appErr, syntheticRequest, crypto.randomUUID())` for the metadata payload
- [x] 3.8 Emit via `logger[level]({ err: metadata, ...context }, 'Error logged with metadata')`
- [x] 3.9 Handle logger.fatal gracefully: if the logger doesn't have a `fatal` method, fall back to `error`
- [x] 3.10 Create `test/unit/shared/resilience/log-with-metadata.test.ts`
- [x] 3.11 Test: background error with context — assert logger.error called once with both metadata and context fields
- [x] 3.12 Test: unknown thrown value (string) — assert errorClass is InternalError, cause chain captures the string
- [x] 3.13 Test: no request in scope — assert method is `'BACKGROUND'`, route is `'__background'`
- [x] 3.14 Test: `context.source` overrides the route
- [x] 3.15 Test: pg-shaped error delegates to `mapDbError` correctly (errorClass is ConflictError for `23505`, pgCode is `'23505'`)
- [x] 3.16 Run `mise run test -- test/unit/shared/resilience/log-with-metadata.test.ts` — all green

## 4. X-Cache-Status header fix in LeaderboardController

- [x] 4.1 Open `src/scoreboard/interface/http/controllers/leaderboard.controller.ts`
- [x] 4.2 Refactor the `getTop()` method to wrap the `this.cache.getTop(parsed.limit)` call in a `try/catch`
- [x] 4.3 In the `try` branch: emit `res.header('X-Cache-Status', 'hit')` before returning the entries (whether empty or not)
- [x] 4.4 In the `catch` branch: run the existing Postgres fallback, emit `res.header('X-Cache-Status', 'miss')`, and return the fallback entries
- [x] 4.5 Remove the old `entries.length > 0` check — the Redis response is now authoritative (empty is still a hit)
- [x] 4.6 Remove the old `X-Cache-Status: miss-fallback` line — replaced by `miss`
- [x] 4.7 Open `test/unit/interface/http/controllers/leaderboard.controller.test.ts` (or create if missing)
- [x] 4.8 Test: HIT path with entries — assert response has `X-Cache-Status: hit` and correct entries
- [x] 4.9 Test: HIT path with empty Redis result (but Redis reachable) — assert response has `X-Cache-Status: hit` and `entries: []`
- [x] 4.10 Test: MISS path when cache throws — assert response has `X-Cache-Status: miss` and the Postgres fallback entries
- [x] 4.11 Run `mise run test -- test/unit/interface/http/controllers` — confirm all green

## 5. Shutdown hooks — OutboxPublisher

- [x] 5.1 Open `src/scoreboard/infrastructure/outbox/outbox.publisher.ts`
- [x] 5.2 Implement `OnApplicationShutdown` interface from `@nestjs/common`
- [x] 5.3 Add private field `private shuttingDown = false` and `private currentPublishPromise: Promise<void> | null = null`
- [x] 5.4 Modify the poll loop to check `if (this.shuttingDown) return;` at the top of each iteration
- [x] 5.5 Modify the publish flow to assign `this.currentPublishPromise = this.doPublish(...)` and clear it on completion
- [x] 5.6 Implement `async onApplicationShutdown(signal?: string): Promise<void>`: set `shuttingDown = true`, await `currentPublishPromise` if present, best-effort `await this.redis.del('outbox:lock').catch(() => {})`, log `{ signal, count: 0 }, 'outbox publisher stopped'`
- [x] 5.7 Make the method idempotent — if `shuttingDown` is already true, return immediately
- [x] 5.8 Update `test/unit/scoreboard/infrastructure/outbox/outbox-publisher.test.ts` — add scenarios: poll loop stops on shutdown, Redis del called, awaits in-flight publish, idempotent on second call
- [x] 5.9 Run `mise run test -- test/unit/scoreboard/infrastructure/outbox` — all green

## 6. Shutdown hooks — JetStream adapters

- [x] 6.1 Open `src/scoreboard/infrastructure/messaging/nats/jetstream.event-publisher.ts`
- [x] 6.2 Implement `OnApplicationShutdown`: `await this.nats.drain()`, log `{ signal }, 'jetstream publisher drained'`
- [x] 6.3 Make idempotent: track a private `drained` flag
- [x] 6.4 Open `src/scoreboard/infrastructure/messaging/nats/jetstream.subscriber.ts`
- [x] 6.5 Implement `OnApplicationShutdown`: if `this.subscription` exists, `await this.subscription.unsubscribe().catch(() => {})`, clear the subscription reference, log `{ signal }, 'jetstream subscriber unsubscribed'`
- [x] 6.6 Update the corresponding unit tests

## 7. Shutdown hooks — StreamController SSE

- [x] 7.1 Open `src/scoreboard/interface/http/controllers/stream.controller.ts` (or wherever the SSE fan-out lives)
- [x] 7.2 Verify the controller maintains a `Set<FastifyReply>` of open streams — if not, audit the existing code and add one
- [x] 7.3 Implement `OnApplicationShutdown`: iterate `openStreams`, write `event: shutdown\ndata: {"reason":"graceful"}\n\n` to each reply's raw socket, call `reply.raw.end()`, remove from the set, log `{ signal, count }, 'sse streams closed'`
- [x] 7.4 Guard against already-closed streams: wrap the write/end in try/catch, skip silently if the stream is already closed
- [x] 7.5 Update SSE controller tests — add scenario: 3 open streams, SIGTERM, assert each stream received the frame and was ended

## 8. Shutdown hooks — Redis and NATS client providers

- [x] 8.1 Open the `RedisClient` provider module (wherever `ioredis` is instantiated and provided)
- [x] 8.2 Wrap the provider in a class that implements `OnApplicationShutdown`: `await this.redis.quit()` (NOT `disconnect()`), log `{ signal }, 'redis client quit'`
- [x] 8.3 If the current provider is a useFactory without a class, convert to a `@Injectable()` class wrapper that exposes the `Redis` instance and implements the hook
- [x] 8.4 Open the `NatsClient` provider module
- [x] 8.5 Same treatment: class wrapper implementing `OnApplicationShutdown` calling `await this.nats.drain()` then `await this.nats.close()`, log `{ signal }, 'nats client closed'`
- [x] 8.6 Document in code comments that drain() is idempotent and the JetStreamEventPublisher's drain() + this drain() are safe together
- [x] 8.7 Update unit tests to confirm the hook is called on shutdown

## 9. Barrel export + resilience module

- [x] 9.1 Create `src/scoreboard/shared/resilience/index.ts` exporting `Singleflight`, `SingleflightOptions`, `logWithMetadata`
- [x] 9.2 Run `mise run typecheck` — confirm the barrel compiles
- [x] 9.3 Update any `LeaderboardCacheImpl` import to use the barrel: `import { Singleflight } from '../../../shared/resilience'`

## 10. main.ts wiring

- [x] 10.1 Open `src/main.ts`
- [x] 10.2 Add `app.enableShutdownHooks()` call after `app.useGlobalFilters(new HttpExceptionFilter(...))` and before `await app.listen(...)`
- [x] 10.3 Install a process-level SIGTERM handler BEFORE `bootstrap()` returns: `process.on('SIGTERM', () => { const t = setTimeout(() => { logger.warn('Shutdown timeout exceeded — forcing exit'); process.exit(1); }, 10_000); t.unref?.(); })`
- [x] 10.4 The existing NestJS shutdown lifecycle will run in parallel; the sentinel only fires if teardown hangs
- [x] 10.5 Manual smoke test: `mise run dev`, send SIGTERM to the dev process, observe log output — confirm all six adapter shutdown lines appear (outbox, jetstream publisher, jetstream subscriber, sse, redis, nats)
- [x] 10.6 Confirm process exits with code 0 on clean shutdown

## 11. Integration / smoke validation

- [x] 11.1 Run `mise run typecheck` — exit 0
- [x] 11.2 Run `mise run lint` — exit 0, no unused-import warnings on touched files
- [x] 11.3 Run `mise run test` (unit) — exit 0, new resilience tests pass
- [x] 11.4 Run `mise run test:integration` — exit 0, leaderboard cache test passes with new singleflight scenario
- [x] 11.5 Run `mise run test:coverage` — confirm new `src/scoreboard/shared/resilience/**` files are covered
- [x] 11.6 Manual smoke: `mise run dev` → hit `GET /v1/leaderboard/top` with a valid JWT, inspect response headers with `curl -i`, confirm `X-Cache-Status: hit` appears
- [x] 11.7 Manual smoke: stop Redis container (`docker compose -p problem6 stop redis`), hit the same endpoint again, confirm `X-Cache-Status: miss` appears and the response still succeeds with Postgres data. Restart Redis
- [x] 11.8 Manual smoke: `mise run dev`, in another terminal `kill -TERM <pid>`, observe logs — all six adapter shutdown lines, process exits cleanly with code 0
- [x] 11.9 Git diff review — confirm files touched are exactly: `src/scoreboard/shared/resilience/*`, `leaderboard-cache.impl.ts`, `leaderboard.controller.ts`, the 6 adapters with shutdown hooks, `main.ts`, the corresponding test files, and the openspec change directory

## 12. OpenSpec validation

- [x] 12.1 Run `openspec validate add-runtime-resilience-utilities` from inside `problem6/` — confirm exit 0
- [x] 12.2 Confirm all four spec files parse: `specs/scoreboard-resilience/spec.md` (ADDED), `specs/scoreboard-leaderboard/spec.md` (MODIFIED), `specs/scoreboard-ops/spec.md` (ADDED), `specs/scoreboard-observability/spec.md` (ADDED)
- [x] 12.3 Mark the change done by archiving in a follow-up commit once Groups 1-11 are complete

## 13. Documentation

- [x] 13.1 Add a one-line note to `infra/README.md` or equivalent: "IP-level rate limiting is the responsibility of the ingress layer (nginx/ALB); problem6 enforces per-user quotas via `RateLimitGuard` only."
- [x] 13.2 Add a one-line note to `infra/README.md` or equivalent: "problem6 emits an `X-Cache-Status: hit|miss` header on `GET /v1/leaderboard/top` for k6 load-test assertions. The header is informational and MUST NOT be relied on by production clients."
