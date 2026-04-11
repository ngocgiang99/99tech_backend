# scoreboard-resilience

## Purpose

Runtime-resilience primitives for the scoreboard module. Owns the `Singleflight<T>` class (collapses concurrent in-flight fetches for hot read paths), the `logWithMetadata()` helper (structured error logging from non-HTTP code paths), and the graceful-shutdown discipline (each stateful adapter implements `OnApplicationShutdown`, main.ts wires NestJS lifecycle hooks with a 10-second sentinel). Establishes the contract that thundering-herd reconnect storms don't trip the fail-CLOSED Redis SPOF contract (GAP-03), that rolling deploys release external state cleanly instead of via Kubernetes SIGKILL, and that non-HTTP error paths emit the same rich metadata as the HTTP exception filter. Lives at `src/scoreboard/shared/resilience/`.

## Requirements

### Requirement: Singleflight primitive collapses concurrent in-flight fetches

The system SHALL provide a generic `Singleflight<T>` class at `src/scoreboard/shared/resilience/singleflight.ts` that deduplicates concurrent callers asking for the same key. The class SHALL expose `do(key: string, fn: () => Promise<T>): Promise<T>` with the following semantics: the first caller's `fn` begins execution; subsequent callers for the same key within the in-flight window SHALL await the same promise and receive the same result (or rejection). The class SHALL expose a `size(): number` method for test assertions. The class SHALL apply a per-call timeout (default 3000ms, configurable via constructor options) that rejects all waiters if the `fn` promise does not settle within the window. Every terminal state (resolve, reject, timeout) SHALL clear the entry so the next caller can retry.

#### Scenario: Concurrent callers for the same key share one upstream call
- **GIVEN** a `Singleflight<string>` instance and a mock `fn` counter that increments per call
- **WHEN** 10 callers invoke `singleflight.do('key-A', fn)` in the same tick
- **THEN** `fn` is called exactly 1 time
- **AND** all 10 callers receive the same resolved value
- **AND** after the promise settles, `singleflight.size()` is 0

#### Scenario: Different keys are independent
- **GIVEN** a `Singleflight<string>` instance
- **WHEN** callers invoke `do('key-A', fn)` and `do('key-B', fn)` concurrently
- **THEN** `fn` is called exactly 2 times
- **AND** both callers receive their respective values

#### Scenario: Rejected fn rejects all waiters and clears the entry
- **GIVEN** a `Singleflight<string>` instance and a mock `fn` that throws `'upstream failed'`
- **WHEN** 5 callers invoke `do('key-A', fn)` in the same tick
- **THEN** all 5 callers receive a rejection with the `'upstream failed'` error
- **AND** `singleflight.size()` is 0 after the rejection
- **AND** a subsequent `do('key-A', freshFn)` call invokes `freshFn` (the entry is cleared)

#### Scenario: Timeout rejects all waiters and clears the entry
- **GIVEN** a `Singleflight<string>` instance with `timeoutMs: 100` and a mock `fn` that never resolves
- **WHEN** a caller invokes `do('key-A', fn)`
- **THEN** the promise rejects after ~100ms with an error message matching `/singleflight: timed out after 100ms/`
- **AND** `singleflight.size()` is 0 after the rejection
- **AND** a subsequent `do('key-A', freshFn)` call invokes `freshFn`

#### Scenario: Subsequent sequential callers always invoke fn
- **GIVEN** a settled previous call for `'key-A'` (resolved or rejected)
- **WHEN** a new caller invokes `do('key-A', fn)` after the previous settles
- **THEN** `fn` is invoked again (no stale caching — singleflight only dedupes IN-FLIGHT calls, not historical ones)

### Requirement: LeaderboardCacheImpl.getTop routes through an instance-scoped Singleflight

The `LeaderboardCacheImpl` class SHALL instantiate a private `Singleflight<TopEntry[]>` in its constructor and route `getTop(limit)` calls through it with key `top:${limit}`. Other methods on the cache (`upsert`, `getRank`, `size`) SHALL NOT use the singleflight. Each `LeaderboardCacheImpl` instance SHALL have its own singleflight (not module-scoped) so DI-scoped tests remain isolated. The singleflight SHALL protect the Redis ZREVRANGE call only; any Postgres fallback performed by upstream callers is outside the singleflight's scope.

#### Scenario: Concurrent getTop(10) calls issue one ZREVRANGE
- **GIVEN** a `LeaderboardCacheImpl` with a mock Redis client whose `zrevrange` is a `vi.fn()` resolving to a fixed reply
- **WHEN** 1000 concurrent callers invoke `cache.getTop(10)`
- **THEN** `redis.zrevrange` is called exactly 1 time
- **AND** all 1000 callers receive the same parsed top-entry array

#### Scenario: Different limits are independent singleflight keys
- **GIVEN** a `LeaderboardCacheImpl` with a mock Redis
- **WHEN** callers invoke `cache.getTop(10)` and `cache.getTop(25)` concurrently
- **THEN** `redis.zrevrange` is called exactly 2 times (once with each limit)

#### Scenario: upsert and getRank do NOT use singleflight
- **GIVEN** a `LeaderboardCacheImpl` with a mock Redis
- **WHEN** 100 concurrent `upsert` calls are issued for 100 distinct user IDs
- **THEN** `redis.zadd` is called exactly 100 times (no deduplication)

### Requirement: logWithMetadata emits structured error logs for non-HTTP paths

The system SHALL provide `logWithMetadata(logger, level, err, context?)` at `src/scoreboard/shared/resilience/log-with-metadata.ts` that coerces any thrown value via `wrapUnknown()` (from `scoreboard-errors`), builds a metadata payload via `buildErrorMetadata()` with a synthetic background-request stub, and emits a single structured log entry at the requested level. The `context` parameter SHALL be merged as a sibling field in the log entry (not inside the metadata object) so background callers can pass job-specific fields like `{ job: 'outbox-publish', aggregateId: 'user-123' }`. This helper SHALL be used by all non-HTTP error paths: background workers, JetStream message handlers, bootstrap code, scheduled jobs.

#### Scenario: Background error is logged with full metadata and context
- **GIVEN** a background outbox publisher encounters `new Error('publish failed')`
- **WHEN** `logWithMetadata(logger, 'error', err, { job: 'outbox-publish', aggregateId: 'abc' })` is called
- **THEN** `logger.error` is called exactly once
- **AND** the first argument is an object containing both a metadata object (with `errorClass: 'InternalError'`, `message: 'publish failed'`, `stack: ...`, `method: 'BACKGROUND'`) and the context fields `job` and `aggregateId` at the top level
- **AND** the second argument is the string `'Error logged with metadata'`

#### Scenario: Unknown thrown value is coerced via wrapUnknown
- **GIVEN** a background job throws the string `'unexpected'`
- **WHEN** `logWithMetadata(logger, 'error', 'unexpected')` is called
- **THEN** the metadata's `errorClass` is `'InternalError'`
- **AND** the metadata's `cause` array contains an entry for the original thrown value

#### Scenario: Log level is honored
- **GIVEN** a non-fatal background warning
- **WHEN** `logWithMetadata(logger, 'warn', err)` is called
- **THEN** `logger.warn` is called, NOT `logger.error`

#### Scenario: No request parameter is required
- **GIVEN** a caller in a context with no active Fastify request (bootstrap, worker, shutdown hook)
- **WHEN** `logWithMetadata()` is invoked without any request-like argument
- **THEN** the helper succeeds
- **AND** the metadata's `method` field is `'BACKGROUND'`
- **AND** the metadata's `route` field is `'__background'` (or the caller-supplied `context.source`)
- **AND** the metadata's `headers`/`query`/`body` fields are empty or absent

### Requirement: Stateful adapters implement OnApplicationShutdown

Every adapter in the scoreboard module that holds external state (Redis connection, NATS connection, open SSE streams, a background poll loop, or a leader-election lock) SHALL implement NestJS's `OnApplicationShutdown(signal)` lifecycle hook with a cleanup contract specific to that adapter. The lifecycle hooks SHALL be orchestrated by NestJS's built-in shutdown lifecycle via `app.enableShutdownHooks()` in `main.ts`. Each adapter's cleanup method SHALL be idempotent (safe to call multiple times), SHALL complete its teardown within a bounded time, and SHALL log a single structured line indicating the shutdown reached the adapter.

#### Scenario: OutboxPublisher releases its Redis lock on shutdown
- **GIVEN** an `OutboxPublisher` with an active leader-election lock at `outbox:lock`
- **WHEN** `onApplicationShutdown('SIGTERM')` is called
- **THEN** the publisher sets its internal `shuttingDown` flag to stop the poll loop
- **AND** awaits any in-flight publish promise
- **AND** calls `redis.del('outbox:lock')` (best-effort — errors are logged but do not throw)
- **AND** logs a line with `signal: 'SIGTERM'` and `'outbox publisher stopped'`

#### Scenario: JetStreamEventPublisher drains pending publishes
- **WHEN** `JetStreamEventPublisher.onApplicationShutdown('SIGTERM')` is called
- **THEN** `nats.drain()` is awaited
- **AND** a line is logged with `signal: 'SIGTERM'` and `'jetstream publisher drained'`

#### Scenario: JetStreamSubscriber unsubscribes the ephemeral consumer
- **GIVEN** a `JetStreamSubscriber` with an active ephemeral push consumer
- **WHEN** `onApplicationShutdown('SIGTERM')` is called
- **THEN** `subscription.unsubscribe()` is awaited
- **AND** a line is logged with `signal: 'SIGTERM'` and `'jetstream subscriber unsubscribed'`

#### Scenario: StreamController closes SSE streams with a shutdown frame
- **GIVEN** a `StreamController` with 3 open SSE streams
- **WHEN** `onApplicationShutdown('SIGTERM')` is called
- **THEN** each stream receives the frame `event: shutdown\ndata: {"reason":"graceful"}\n\n`
- **AND** each stream's underlying `reply.raw.end()` is called
- **AND** the internal open-streams set is empty after the method returns
- **AND** a line is logged with `count: 3` and `'sse streams closed'`

#### Scenario: RedisClient provider calls quit not disconnect
- **GIVEN** the `RedisClient` provider with a live ioredis connection
- **WHEN** `onApplicationShutdown('SIGTERM')` is called
- **THEN** `redis.quit()` is called (NOT `disconnect()`)
- **AND** the connection closes after flushing any pending commands

#### Scenario: NatsClient provider drains and closes
- **GIVEN** the `NatsClient` provider with a live NATS connection
- **WHEN** `onApplicationShutdown('SIGTERM')` is called
- **THEN** `nats.drain()` is awaited
- **AND** `nats.close()` is called
- **AND** the drain is idempotent with any prior drain call from the JetStreamEventPublisher

#### Scenario: Multiple shutdown calls are idempotent
- **GIVEN** an adapter whose `onApplicationShutdown` has already run once
- **WHEN** `onApplicationShutdown('SIGTERM')` is called a second time
- **THEN** no error is thrown
- **AND** no duplicate log line is emitted (either suppressed or the second call short-circuits)

### Requirement: main.ts wires enableShutdownHooks and a 10-second sentinel

`src/main.ts` SHALL call `app.enableShutdownHooks()` after the global exception filter is registered and before `app.listen(port)`. It SHALL also install a process-level `SIGTERM` handler that starts a 10-second `setTimeout(..., 10_000).unref()` timer; if the timer fires before NestJS's internal teardown completes, the handler SHALL log a warning and call `process.exit(1)`. The timer SHALL be `unref()`'d so it does not keep the event loop alive when everything drains cleanly.

#### Scenario: enableShutdownHooks is called in the correct order
- **WHEN** `main.ts` is inspected
- **THEN** `app.enableShutdownHooks()` appears after `app.useGlobalFilters(...)` and before `app.listen(...)`

#### Scenario: SIGTERM sentinel force-exits after 10s
- **GIVEN** an adapter whose `onApplicationShutdown` hangs indefinitely
- **WHEN** `SIGTERM` is received
- **AND** 10 seconds elapse
- **THEN** a warning log is emitted with message `'Shutdown timeout exceeded — forcing exit'`
- **AND** `process.exit(1)` is called
- **NOTE**: This scenario is integration-tested via a synthetic hanging hook; in production the sentinel should never fire if the adapter contracts are correct

#### Scenario: Clean shutdown does not fire the sentinel
- **GIVEN** all adapters' `onApplicationShutdown` methods complete within 10 seconds
- **WHEN** `SIGTERM` is received
- **THEN** NestJS's teardown finishes normally
- **AND** the sentinel timer is not fired (it was `unref()`'d, so it does not keep the process alive)
- **AND** the process exits with code 0
