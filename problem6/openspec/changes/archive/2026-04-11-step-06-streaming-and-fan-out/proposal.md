## Why

`step-05` shipped the leaderboard cache, the cold rebuilder, the `outbox_events` table, and the write-through outbox INSERT inside the handler — but the outbox is **inert**: nobody reads from it and publishes events anywhere. Clients can call `GET /v1/leaderboard/top` and see fresh data, but they have no way to receive **live updates** as scores change.

This change builds the entire **streaming pipeline** end-to-end:
1. NATS JetStream client + the `SCOREBOARD` stream bootstrap (idempotent on boot).
2. The `JetStreamEventPublisher` adapter implementing the `DomainEventPublisher` port — it publishes events with `Nats-Msg-Id` set to the outbox row's `id` (this is ADR-07 layer 3).
3. The background **outbox publisher worker** that polls `outbox_events WHERE published_at IS NULL`, publishes each row to JetStream, then sets `published_at = now()`. Leader-elected via Redis `SET NX EX 10 outbox:lock` so only one instance is publishing at a time. Fixes GAP-04 (split-brain documentation).
4. A **coalescing window** in the publisher that batches publishes within a 100ms tumbling window AND only publishes `scoreboard.leaderboard.updated` when the top-10 actually changes (skips no-op publishes for non-leaderboard-changing credits).
5. An **ephemeral push consumer** per API instance that subscribes to `scoreboard.leaderboard.updated` and forwards messages to a local in-process emitter. Each instance has its own consumer with `inactive_threshold=30s` so the consumer is GC'd if the instance dies.
6. The **`GET /v1/leaderboard/stream` SSE controller** that opens a long-lived SSE connection, sends an initial snapshot from `LeaderboardCache.getTop(10)`, then forwards local emitter events to the client. Heartbeats every 15s to keep proxies happy.
7. **Backpressure** for slow SSE clients (GAP-02): drop oldest pending message when the socket buffer fills, disconnect clients whose buffer has been full for > 5s. **`<DECISION>` — `/opsx:apply` halts and prompts for the exact thresholds.**

After this change, the system delivers the full FR-06 contract: top-10 changes propagate to all connected clients within ≤ 1s p95.

## What Changes

- Add `src/scoreboard/infrastructure/messaging/nats/{nats.client.ts, nats.module.ts, stream-bootstrap.ts, index.ts}` providing a single shared `NatsConnection` + JetStream context across the application. `StreamBootstrap` runs `OnApplicationBootstrap` and idempotently creates/updates the `SCOREBOARD` stream per the config from `step-01`'s schema (`NATS_STREAM_*` env vars).
- Add `src/scoreboard/infrastructure/messaging/nats/jetstream.event-publisher.ts` implementing the `DomainEventPublisher` port. Method `publish(event, { msgId })` calls `js.publish(subject, payload, { msgID: msgId })` and awaits the PubAck. Errors throw a typed `JetStreamPublishError`.
- Define the `DomainEventPublisher` port in `src/scoreboard/domain/ports/domain-event-publisher.ts` (interface only).
- Add `src/scoreboard/infrastructure/outbox/outbox.publisher.service.ts` as `@Injectable() implements OnApplicationBootstrap, OnApplicationShutdown`. The service runs a background loop that:
  - Acquires the Redis lock `outbox:lock` (with `EX 10 NX`). If it loses, sleeps 5s and retries.
  - As leader, polls `SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 100`.
  - For each row: calls `JetStreamEventPublisher.publish(row, { msgId: row.id })`. On success, sets `published_at = now()`. On failure, logs and continues.
  - Sleeps 50ms between poll cycles (configurable via env). Holds the lock by re-extending `EX 10` every 5s.
  - On graceful shutdown (`OnApplicationShutdown`), releases the lock and stops polling.
- Add the **coalescing window** to the outbox publisher: instead of publishing every `scoreboard.leaderboard.updated` row immediately, the publisher accumulates them in a 100ms tumbling window and only publishes the LAST one (since each message carries the full current top-10). Additionally, before publishing a `scoreboard.leaderboard.updated` event, query `LeaderboardCache.getTop(10)` for the prior and current top-10; only publish if they differ. The `scoreboard.score.credited` rows (raw audit events) are published every cycle without coalescing.
- Add `src/scoreboard/infrastructure/messaging/nats/jetstream.subscriber.ts` as `@Injectable() implements OnApplicationBootstrap` that creates an ephemeral push consumer on `scoreboard.leaderboard.updated` with `deliver_policy=DeliverPolicy.New`, `ack_policy=AckPolicy.Explicit`, `ack_wait=5s`, `inactive_threshold=30s`. On message arrival, acks and emits to a local NestJS `EventEmitter2`.
- Add `src/scoreboard/infrastructure/messaging/nats/leaderboard-updates.emitter.ts` — a thin wrapper around NestJS `EventEmitter2` exposing `subscribe(callback)` and `emit(event)` for the SSE controller.
- Add `src/scoreboard/interface/http/controllers/leaderboard-stream.controller.ts` exposing `GET /v1/leaderboard/stream` with `@UseGuards(JwtGuard)`. The handler:
  - Sets headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
  - Sends an initial `event: snapshot` frame with `LeaderboardCache.getTop(10)`.
  - Subscribes to the local emitter; each emitted event becomes an `event: leaderboard.updated` frame.
  - Sends `event: heartbeat` every 15s.
  - On client disconnect: removes the emitter subscription, releases resources.
- Add **SSE backpressure** (GAP-02): the controller tracks each connection's pending write buffer. When a write would exceed N pending bytes (or N pending messages), drop the oldest pending message. If the buffer has been full for > 5s, close the connection cleanly and increment the `sse_slow_client_disconnected` metric.
- Update `_bmad-output/planning-artifacts/architecture.md` ADR-11 with an explicit "Split-brain guarantee" section explaining that the 2-minute JetStream dedup window > 10s lock TTL, so concurrent publishers during lock expiry cannot cause duplicate fan-out. Mark GAP-04 resolved.
- Wire the new providers and controllers into `ScoreboardModule`. Update the `ScoreboardModule` providers and controllers list.
- Add `@testcontainers/nats` to dev deps. Add NATS-backed integration tests for the publisher, the outbox worker, the subscriber, and the SSE controller (with a fake NATS client for unit tests, real NATS via Testcontainers for integration).

## Capabilities

### New Capabilities

- `scoreboard-streaming`: The end-to-end live-update path. Owns the SSE controller (`GET /v1/leaderboard/stream`), the local-emitter wiring, the heartbeat loop, the backpressure policy (per GAP-02 decision), and the slow-client disconnect logic. Establishes the user-facing real-time contract.
- `scoreboard-events`: The NATS/JetStream infrastructure and the outbox publisher worker. Owns the `NatsClient`, `StreamBootstrap`, `JetStreamEventPublisher`, `OutboxPublisherService` (with leader election + coalescing), and the `JetStreamSubscriber` (ephemeral push consumer). This is the messaging plumbing that turns committed Postgres events into NATS messages and back into in-process events for SSE.

### Modified Capabilities

- `scoreboard-domain`: Adds the `DomainEventPublisher` port interface in `src/scoreboard/domain/ports/`.
- `scoreboard-leaderboard`: The SSE controller's initial snapshot reuses `LeaderboardCache.getTop(10)` from `step-05`. The publisher's coalescing logic queries `LeaderboardCache.getTop(10)` to detect "top-10 actually changed".
- `scoreboard-config`: Adds `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_LOCK_TTL_SECONDS`, `OUTBOX_COALESCE_WINDOW_MS`, `SSE_HEARTBEAT_INTERVAL_MS`, `SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS`, `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES` to `EnvSchema`. Defaults baked into the schema match the architecture.

## Impact

**New code**:
- `src/scoreboard/infrastructure/messaging/nats/{nats.client.ts, nats.module.ts, stream-bootstrap.ts, jetstream.event-publisher.ts, jetstream.subscriber.ts, leaderboard-updates.emitter.ts, index.ts}` (~500 LOC)
- `src/scoreboard/infrastructure/outbox/{outbox.publisher.service.ts, outbox.coalescer.ts, outbox.module.ts, index.ts}` (~400 LOC)
- `src/scoreboard/domain/ports/domain-event-publisher.ts` (~30 LOC)
- `src/scoreboard/interface/http/controllers/leaderboard-stream.controller.ts` (~250 LOC, the SSE protocol handling is the bulk)
- Integration tests: `test/integration/messaging/nats-publisher.test.ts`, `outbox-publisher.test.ts`, `jetstream-subscriber.test.ts`, `sse-controller.test.ts` (~500 LOC)

**Modified code**:
- `src/scoreboard/scoreboard.module.ts` — register the new providers and controller
- `src/config/schema.ts` — add 6 new env vars
- `_bmad-output/planning-artifacts/architecture.md` — ADR-11 split-brain section, GAP-02 + GAP-04 marked resolved
- `_bmad-output/planning-artifacts/architecture.md` `openGaps` — mark GAP-02 and GAP-04 resolved
- `problem6/README.md` — minor update to §8.4 (Heartbeat & Reconnect) reflecting the chosen GAP-02 backpressure thresholds

**New dependencies**:
- `nats` (the official Node NATS client with JetStream support — already listed in `step-01`'s scaffolding plan)
- `@nestjs/event-emitter` (for the local in-process emitter)

**New dev dependencies**:
- `@testcontainers/nats`

**Decisions** (`<DECISION>` markers in tasks.md):
- **DECISION-1 (GAP-02)**: SSE backpressure thresholds. The architecture says "drop-oldest + disconnect on overflow" but the exact thresholds are open. **Sub-questions**: max pending messages per client before drop-oldest fires (default suggestion: 50)? max time the buffer can be full before disconnect (default: 5s)? **`/opsx:apply` halts and prompts.**

**Out of scope** (deferred):
- Multi-region JetStream mirroring — `IMPROVEMENTS.md` I-SCL-01, post-MVP.
- Durable consumers (vs ephemeral) for analytics — post-MVP.
- The `/health`, `/ready`, `/metrics` HTTP endpoints — `step-07` (this change updates the readiness flag in `step-05`'s `ReadinessService` for the JetStream check, but the HTTP endpoint controllers are `step-07`).
- E2E test against the full docker-compose stack — `step-07`.
- k6 load tests with NFR thresholds — `step-07`.
- Production NATS cluster topology — `step-07`'s IaC stubs.
