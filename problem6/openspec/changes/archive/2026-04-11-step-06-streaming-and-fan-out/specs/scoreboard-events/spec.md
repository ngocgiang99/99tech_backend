## ADDED Requirements

### Requirement: NATS JetStream client and SCOREBOARD stream bootstrap

The system SHALL provide a single shared `NatsConnection` and JetStream context across the application. On `OnApplicationBootstrap`, `StreamBootstrap` SHALL idempotently create or update the `SCOREBOARD` stream per the `NATS_STREAM_*` config from `step-01`'s schema. If the stream already exists with identical config, it SHALL be a no-op. If the config drifted, the bootstrap SHALL log a WARNING and SHALL NOT auto-update (production source of truth is infra-as-code).

#### Scenario: Stream is created on first boot
- **GIVEN** a fresh NATS server with no streams
- **WHEN** the app boots
- **THEN** `StreamBootstrap.onApplicationBootstrap()` runs
- **AND** the SCOREBOARD stream exists with the configured retention values

#### Scenario: Stream creation is idempotent on second boot
- **GIVEN** the SCOREBOARD stream already exists with identical config
- **WHEN** the app boots
- **THEN** the bootstrap detects the existing stream
- **AND** does not re-create or modify it
- **AND** logs `info` "stream already configured"

#### Scenario: Drifted config logs a warning but does not auto-update
- **GIVEN** the existing SCOREBOARD stream has `max_age=14d` (drifted from the configured 30d)
- **WHEN** the app boots
- **THEN** the bootstrap detects the drift
- **AND** logs `warn` indicating the drift and the expected vs actual values
- **AND** does NOT modify the existing stream
- **AND** the application continues to boot normally

### Requirement: JetStreamEventPublisher publishes with msgID for dedup

The `JetStreamEventPublisher` SHALL implement the `DomainEventPublisher` port. Its `publish(event, { msgId })` method SHALL call `js.publish(subject, payload, { msgID: msgId })` and await the PubAck. The `msgID` SHALL be the outbox row's `id` (BIGSERIAL). Duplicate publishes within the 2-minute dedup window SHALL be deduplicated by JetStream automatically.

#### Scenario: Successful publish returns PubAck
- **GIVEN** a JetStream connection and the SCOREBOARD stream
- **WHEN** `publisher.publish({ subject: 'scoreboard.score.credited', payload, msgId: '123' })` is called
- **THEN** the call awaits the PubAck
- **AND** returns successfully
- **AND** the message is now stored in the stream

#### Scenario: Duplicate msgID within dedup window is silently deduplicated
- **GIVEN** a successful publish with `msgId = '456'`
- **WHEN** another publish is attempted with the same `msgId = '456'` within the 2-minute dedup window
- **THEN** JetStream returns a duplicate PubAck
- **AND** no second copy of the message is delivered to subscribers

#### Scenario: Publish failure throws JetStreamPublishError
- **GIVEN** a NATS connection in a failed state (e.g. server unreachable)
- **WHEN** `publisher.publish(...)` is called
- **THEN** the call throws `JetStreamPublishError` wrapping the original NATS error
- **AND** the caller (outbox worker) catches it and logs

### Requirement: Outbox publisher worker drains rows with leader election

`OutboxPublisherService` SHALL run on every API instance as a background polling loop. Exactly one instance at a time SHALL be the leader (enforced by Redis lock `outbox:lock` with TTL 10s, renewed every 5s). The leader polls `SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT <batch>`, publishes each row via `JetStreamEventPublisher` with `msgId = row.id`, and updates `published_at = now()` on success.

#### Scenario: Leader acquires the lock and polls
- **GIVEN** an instance starts and no other instance holds the lock
- **WHEN** the worker's polling loop runs for the first time
- **THEN** the instance acquires `outbox:lock` via `SET NX EX 10`
- **AND** begins polling for unpublished rows

#### Scenario: Non-leader instance retries every 5s
- **GIVEN** an instance starts but another instance holds the lock
- **WHEN** the worker's polling loop runs
- **THEN** the SETNX fails
- **AND** the instance sleeps 5 seconds
- **AND** retries the SETNX

#### Scenario: Leader publishes an unpublished row and updates published_at
- **GIVEN** the leader and an unpublished row with `id = 42`
- **WHEN** the polling loop processes the row
- **THEN** `JetStreamEventPublisher.publish({ subject, payload, msgId: '42' })` is called
- **AND** on success, `UPDATE outbox_events SET published_at = now() WHERE id = 42` is executed
- **AND** the row is no longer in the next poll's result set

#### Scenario: Publish failure does not advance published_at
- **GIVEN** a publish that throws `JetStreamPublishError`
- **WHEN** the polling loop catches the error
- **THEN** the row's `published_at` remains NULL
- **AND** the worker logs the error
- **AND** continues to the next row (does NOT crash)
- **AND** the failed row is retried on the next poll cycle

#### Scenario: Lock heartbeat extends TTL every 5 seconds
- **GIVEN** the leader has been polling for > 5 seconds
- **WHEN** the heartbeat tick fires
- **THEN** the leader re-issues `EXPIRE outbox:lock 10` (or `SET ... XX EX 10`) to extend the lock
- **AND** the lock TTL is reset to 10 seconds

#### Scenario: Leader release on shutdown
- **GIVEN** the leader receives `OnApplicationShutdown`
- **WHEN** the lifecycle hook runs
- **THEN** the worker sets `shouldStop = true`
- **AND** finishes the current polling iteration
- **AND** explicitly releases the lock via `DEL outbox:lock`
- **AND** another instance can become leader within 5 seconds

### Requirement: Coalescing window batches leaderboard updates and skips no-ops

The outbox publisher SHALL coalesce `scoreboard.leaderboard.updated` events within a 100ms tumbling window: at window close, only the LAST event in the window is considered, AND it is only published if the current top-10 differs from the last published top-10. The `scoreboard.score.credited` raw audit events are NOT coalesced — they are published 1:1.

#### Scenario: 50 credits within 100ms produce one leaderboard.updated
- **GIVEN** 50 score credits committed within a 100ms window
- **WHEN** the publisher processes them
- **THEN** at most 1 `scoreboard.leaderboard.updated` message is published in that window
- **AND** the message contains the top-10 AT THE END of the window
- **AND** all 50 `scoreboard.score.credited` raw events are still published (1:1)

#### Scenario: No-op leaderboard update is skipped
- **GIVEN** a credit that does not change the top-10 (e.g. user at rank #500 gains points but stays at #500)
- **WHEN** the publisher evaluates the new top-10 against the cached previous top-10
- **THEN** they are equal
- **AND** no `scoreboard.leaderboard.updated` message is published
- **AND** the `scoreboard.score.credited` event IS still published

#### Scenario: 1500 credits/sec produces ≤ 10 leaderboard.updated/sec
- **GIVEN** a load test with 1500 credits/sec for 10 seconds
- **WHEN** the publisher coalesces them
- **THEN** the publish rate of `scoreboard.leaderboard.updated` is ≤ 10 messages/sec (10 windows × 100ms each)
- **AND** the rate of `scoreboard.score.credited` is approximately 1500/sec (1:1 with credits)

### Requirement: Ephemeral push consumer per API instance

Each API instance SHALL create an ephemeral push consumer on `scoreboard.leaderboard.updated` at boot. The consumer SHALL use `DeliverPolicy.New`, `AckPolicy.Explicit`, `ack_wait=5s`, `inactive_threshold=30s`. On message arrival, the consumer SHALL ack and emit the payload to a local in-process emitter.

#### Scenario: Consumer is created on boot
- **GIVEN** an API instance with a working JetStream connection
- **WHEN** `JetStreamSubscriber.onApplicationBootstrap()` runs
- **THEN** an ephemeral consumer is created with the documented config
- **AND** the consumer name is auto-generated (random)

#### Scenario: Message arrival emits to local emitter
- **GIVEN** a consumer subscribed and a `scoreboard.leaderboard.updated` message published
- **WHEN** the consumer callback runs
- **THEN** the message is acked
- **AND** `leaderboardUpdatesEmitter.emit('leaderboard.updated', payload)` is called
- **AND** any local SSE subscribers receive the event

#### Scenario: Dead instance has consumer GC'd by JetStream
- **GIVEN** an API instance dies without cleanly closing its consumer
- **WHEN** 30 seconds pass
- **THEN** JetStream removes the consumer state (per `inactive_threshold`)
- **AND** no leaked consumer accumulates

### Requirement: ADR-11 split-brain guarantee documented (GAP-04)

`_bmad-output/planning-artifacts/architecture.md` ADR-11 SHALL be amended with an explicit "Split-brain guarantee" section explaining that the JetStream `Nats-Msg-Id` 2-minute dedup window is significantly longer than the Redis lock TTL (10s), so concurrent leaders during a lock-handover race cannot cause duplicate fan-out. `architecture.md` `openGaps` GAP-04 SHALL be marked as "resolved".

#### Scenario: ADR-11 has the split-brain section after this change
- **WHEN** `architecture.md` is read after this change is implemented
- **THEN** ADR-11 contains a section titled "Split-brain guarantee"
- **AND** the section explains that 2min dedup window > 10s lock TTL
- **AND** `openGaps` lists GAP-04 as "resolved"
