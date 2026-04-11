## ADDED Requirements

### Requirement: Graceful shutdown via NestJS lifecycle hooks on all stateful adapters

The system SHALL enable NestJS's application shutdown lifecycle via `app.enableShutdownHooks()` in `src/main.ts`, registered after the global exception filter and before `app.listen()`. Every stateful adapter in the scoreboard module SHALL implement `OnApplicationShutdown(signal)` with a cleanup contract appropriate to the external state it holds (Redis lock, NATS connection, open SSE streams, background poll loop). The `main.ts` entrypoint SHALL additionally install a 10-second overall timeout sentinel so a hanging hook cannot indefinitely block the process; the sentinel SHALL log a warning and force-exit with code 1.

The adapters that SHALL implement the hook are: `OutboxPublisher`, `JetStreamEventPublisher`, `JetStreamSubscriber`, `StreamController` (SSE fan-out), `RedisClient` provider, `NatsClient` provider. The exact cleanup contract for each adapter is defined in `scoreboard-resilience/spec.md` — this requirement mandates that the hook exists and is wired; the resilience spec mandates what it does.

#### Scenario: main.ts enables shutdown hooks
- **WHEN** `src/main.ts` is inspected
- **THEN** `app.enableShutdownHooks()` is called exactly once
- **AND** the call appears after `app.useGlobalFilters(...)` and before `app.listen(...)`

#### Scenario: SIGTERM triggers the full shutdown sequence
- **GIVEN** a running instance with an active outbox leader lock, 3 open SSE streams, and an active JetStream subscription
- **WHEN** the process receives SIGTERM
- **THEN** `OutboxPublisher.onApplicationShutdown('SIGTERM')` runs and releases the Redis lock
- **AND** `JetStreamSubscriber.onApplicationShutdown('SIGTERM')` runs and unsubscribes the ephemeral consumer
- **AND** `StreamController.onApplicationShutdown('SIGTERM')` sends shutdown frames to all 3 streams and closes them
- **AND** `RedisClient.onApplicationShutdown('SIGTERM')` calls `redis.quit()`
- **AND** `NatsClient.onApplicationShutdown('SIGTERM')` calls `nats.drain()` + `nats.close()`
- **AND** the process exits with code 0 within the 10-second sentinel window
- **AND** each adapter logs its shutdown line with the signal name

#### Scenario: 10-second sentinel force-exits on a hanging hook
- **GIVEN** an adapter whose `onApplicationShutdown` never completes
- **WHEN** SIGTERM is received
- **AND** 10 seconds elapse
- **THEN** a warning log is emitted: `'Shutdown timeout exceeded — forcing exit'`
- **AND** `process.exit(1)` is called

#### Scenario: Clean shutdown exit code
- **GIVEN** all adapters' shutdown hooks complete in under 10 seconds
- **WHEN** the process exits
- **THEN** the exit code is 0
- **AND** the sentinel timer (which was `unref()`'d) did not fire and did not keep the event loop alive

#### Scenario: Shutdown ordering — publishers release handles before transports close
- **GIVEN** NestJS's lifecycle orchestration
- **WHEN** SIGTERM teardown runs
- **THEN** `OutboxPublisher` and `JetStreamSubscriber` complete their shutdown before `RedisClient` and `NatsClient` close their transports
- **NOTE**: NestJS orders providers in reverse dependency order by default; this scenario documents the expected outcome, not a manual ordering
