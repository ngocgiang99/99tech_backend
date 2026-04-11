## 1. DECISION-1 (GAP-02) — SSE backpressure thresholds

- [x] 1.1 **<DECISION>** Resolve GAP-02 — SSE backpressure thresholds. **Resolved 2026-04-11** with defaults: 50 pending messages, 5000 ms timeout, message-count only. Values applied to `EnvSchema` in Task 4 and recorded inline in `architecture.md` openGaps.
- [x] 1.2 Update `_bmad-output/planning-artifacts/architecture.md` `openGaps` to mark GAP-02 as "resolved" with the chosen thresholds inline

## 2. Dependencies

- [x] 2.1 Add `nats` to `package.json` `dependencies` (`pnpm add nats`)
- [x] 2.2 Add `@nestjs/event-emitter` to `dependencies` (`pnpm add @nestjs/event-emitter`)
- [x] 2.3 Add `@testcontainers/nats` to `devDependencies` (`pnpm add -D @testcontainers/nats`)
- [x] 2.4 `pnpm install`, verify lock file
- [x] 2.5 `mise run typecheck` exits 0

## 3. NATS client and StreamBootstrap (capability: scoreboard-events)

- [x] 3.1 Create `src/scoreboard/infrastructure/messaging/nats/nats.client.ts` exporting `buildNatsClient(config: ConfigService): Promise<NatsConnection>` that calls `await connect({ servers: config.get('NATS_URL') })`
- [x] 3.2 Create `src/scoreboard/infrastructure/messaging/nats/nats.module.ts` as `@Global() @Module({...})` providing `{ provide: 'Nats', useFactory: buildNatsClient, inject: [ConfigService] }` and exporting `'Nats'`
- [x] 3.3 Add `OnModuleDestroy` to drain and close the connection cleanly
- [x] 3.4 Create `src/scoreboard/infrastructure/messaging/nats/stream-bootstrap.ts` exporting `@Injectable() class StreamBootstrap implements OnApplicationBootstrap`
- [x] 3.5 Constructor injects `'Nats'`, `ConfigService`
- [x] 3.6 `onApplicationBootstrap()`: get JetStream manager via `nc.jetstreamManager()`, then `await jsm.streams.add({ name: 'SCOREBOARD', subjects: ['scoreboard.>'], retention: RetentionPolicy.Limits, max_age: <ns from config>, max_msgs: ..., max_bytes: ..., duplicate_window: ..., num_replicas: 1 })`
- [x] 3.7 If the stream already exists with identical config, the SDK throws `JetStreamError` with code 10058 — catch it, log "stream already configured", proceed
- [x] 3.8 If the stream exists with drifted config, log a warning naming the drifted fields and proceed (do NOT auto-update)
- [x] 3.9 Re-export from `src/scoreboard/infrastructure/messaging/nats/index.ts`
- [x] 3.10 Update `AppModule` to import `NatsModule`

## 4. Update EnvSchema with 6 new vars (capability: scoreboard-config)

- [x] 4.1 Edit `src/config/schema.ts` and add the six new fields per the spec, using the chosen DECISION-1 values for `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES` and `SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS`
- [x] 4.2 Update `problem6/.env.example` to document the six new vars in their appropriate sections (Outbox / SSE)
- [x] 4.3 Run `mise run typecheck` to verify

## 5. DomainEventPublisher port (capability: scoreboard-domain)

- [x] 5.1 Create `src/scoreboard/domain/ports/domain-event-publisher.ts` exporting `interface DomainEvent { subject: string; payload: Record<string, unknown> }` and `interface DomainEventPublisher { publish(event: DomainEvent, options: { msgId: string }): Promise<void> }`
- [x] 5.2 Re-export from `src/scoreboard/domain/index.ts`
- [x] 5.3 Verify the file imports nothing framework-y (grep guard)

## 6. JetStreamEventPublisher (capability: scoreboard-events)

- [x] 6.1 Create `src/scoreboard/infrastructure/messaging/nats/jetstream.event-publisher.ts` exporting `@Injectable() class JetStreamEventPublisher implements DomainEventPublisher`
- [x] 6.2 Constructor injects `'Nats'`, logger
- [x] 6.3 Lazily build the JetStream client: `private js = this.nats.jetstream()`
- [x] 6.4 `publish(event, { msgId })`: `await this.js.publish(event.subject, this.codec.encode(event.payload), { msgID: msgId })`. Use `JSONCodec` from `nats` for encoding
- [x] 6.5 Wrap in try/catch: on `JetStreamError`, throw `JetStreamPublishError` with the original cause
- [x] 6.6 Unit tests with a mocked NATS client (use `nats`'s `mockNatsConnection` or hand-roll) covering: happy publish, dedup happy path (duplicate msgID returns PubAck), error path

## 7. OutboxPublisherService (capability: scoreboard-events)

- [x] 7.1 Create `src/scoreboard/infrastructure/outbox/outbox.publisher.service.ts` exporting `@Injectable() class OutboxPublisherService implements OnApplicationBootstrap, OnApplicationShutdown`
- [x] 7.2 Constructor injects `@Inject('Database') db`, `@Inject('Redis') redis`, `JetStreamEventPublisher`, `LeaderboardCache`, `ConfigService`, logger
- [x] 7.3 `onApplicationBootstrap()`: start the polling loop as a detached promise. Set `private running = true`
- [x] 7.4 The polling loop: `while (this.running) { try { await this.tryAcquireLeadership(); } catch (e) { logger.error(e); await sleep(5000); } }`
- [x] 7.5 `tryAcquireLeadership()`: `const acquired = await redis.set('outbox:lock', this.instanceId, 'EX', config.get('OUTBOX_LOCK_TTL_SECONDS'), 'NX'); if (!acquired) { await sleep(5000); return; }`
- [x] 7.6 As leader: start a heartbeat timer that runs every `OUTBOX_LOCK_TTL_SECONDS / 2` seconds and re-extends the lock with `EXPIRE outbox:lock 10` (or `SET ... XX EX 10`)
- [x] 7.7 Run the inner publish loop: `while (this.running && this.isLeader) { await this.publishBatch(); await sleep(config.get('OUTBOX_POLL_INTERVAL_MS')); }`
- [x] 7.8 `publishBatch()`: `const rows = await db.selectFrom('outbox_events').where('published_at', 'is', null).orderBy('id').limit(100).execute()`. For each row: build the `DomainEvent`, call `publisher.publish(event, { msgId: row.id.toString() })`, then `await db.updateTable('outbox_events').set({ published_at: new Date() }).where('id', '=', row.id).execute()`
- [x] 7.9 Catch publish errors per-row: log, do NOT update `published_at`, continue with next row (the row is retried on next poll)
- [x] 7.10 `onApplicationShutdown()`: set `this.running = false`, wait for the inner loop to finish (max 30s), explicitly release the lock with `DEL outbox:lock`
- [x] 7.11 Add the coalescing logic: separate the `scoreboard.leaderboard.updated` rows from `scoreboard.score.credited` rows. Score-credited go out 1:1. For leaderboard-updated, accumulate within the `OUTBOX_COALESCE_WINDOW_MS` window, then call `LeaderboardCache.getTop(10)`, compare to the cached `lastPublishedTop10`, only publish if different, update the cache
- [x] 7.12 Create `src/scoreboard/infrastructure/outbox/outbox.module.ts` providing the service
- [x] 7.13 Import into `ScoreboardModule`

## 8. JetStream subscriber + local emitter (capability: scoreboard-events, scoreboard-streaming)

- [x] 8.1 Add `EventEmitterModule.forRoot()` to `AppModule` (from `@nestjs/event-emitter`)
- [x] 8.2 Create `src/scoreboard/infrastructure/messaging/nats/leaderboard-updates.emitter.ts` exporting `@Injectable() class LeaderboardUpdatesEmitter` wrapping NestJS `EventEmitter2`
- [x] 8.3 `subscribe(callback: (event) => void): () => void` (returns an unsubscribe fn)
- [x] 8.4 `emit(event)`
- [x] 8.5 Create `src/scoreboard/infrastructure/messaging/nats/jetstream.subscriber.ts` exporting `@Injectable() class JetStreamSubscriber implements OnApplicationBootstrap, OnApplicationShutdown`
- [x] 8.6 Constructor injects `'Nats'`, `LeaderboardUpdatesEmitter`, `ReadinessService`, logger
- [x] 8.7 `onApplicationBootstrap()`: get JS, create the ephemeral consumer via `jsm.consumers.add('SCOREBOARD', {...})` then `js.consumers.get(stream, name)` (Note: NATS SDK uses `jsm.consumers.add` + `js.consumers.get`, not `js.consumers.create`)
- [x] 8.8 Pull messages in a loop: `for await (const msg of consumer.consume()) { try { const event = JSONCodec.decode(msg.data); this.emitter.emit(event); msg.ack(); } catch (e) { logger.error(e); msg.nak(); } }`
- [x] 8.9 On startup success, set `readiness.jetstreamReady = true` (add this flag to `ReadinessService` from `step-05`)
- [x] 8.10 `onApplicationShutdown()`: stop the consume loop, destroy the ephemeral consumer

## 9. SSE controller (capability: scoreboard-streaming)

- [x] 9.1 Create `src/scoreboard/interface/http/controllers/leaderboard-stream.controller.ts` with `@Controller('v1/leaderboard') @UseGuards(JwtGuard)`
- [x] 9.2 Add `@Get('stream') async stream(@Req() req, @Res() reply)`. Track per-instance connection count via a class-level static counter
- [x] 9.3 Check `currentConnectionCount >= MAX_SSE_CONN_PER_INSTANCE` — if true, return `503 TEMPORARILY_UNAVAILABLE` (use `reply.status(503).send({...})`)
- [x] 9.4 Increment the counter (note: scoreboard_sse_connections gauge deferred — not yet wired to metrics module)
- [x] 9.5 Set headers: `reply.raw.setHeader('Content-Type', 'text/event-stream'); reply.raw.setHeader('Cache-Control', 'no-cache'); reply.raw.setHeader('Connection', 'keep-alive'); reply.raw.setHeader('X-Accel-Buffering', 'no'); reply.raw.flushHeaders()`
- [x] 9.6 Send the initial snapshot: `const top = await this.cache.getTop(10); writeFrame('snapshot', { top })`
- [x] 9.7 Subscribe to the local emitter: `const unsubscribe = this.emitter.subscribe(event => writeFrame('leaderboard.updated', event))`
- [x] 9.8 Set up the heartbeat timer: `const heartbeatTimer = setInterval(() => reply.raw.write('event: heartbeat\ndata: {}\n\n'), config.get('SSE_HEARTBEAT_INTERVAL_MS'))`
- [x] 9.9 Set up backpressure tracking: maintain `pendingMessages: string[]` array for this connection. The `writeFrame` function appends to it and calls `reply.raw.write(...)`. When the write callback fires (drain), remove the frame
- [x] 9.10 Slow client tick: `setInterval(() => { if (bufferFullSince !== null && Date.now() - bufferFullSince >= TIMEOUT) { cleanup(); } else if (pendingMessages.length < MAX_PENDING) { bufferFullSince = null; } }, 1000)`
- [x] 9.11 Drop-oldest: when adding to `pendingMessages`, if `pendingMessages.length >= MAX_PENDING`, shift the oldest before pushing the new
- [x] 9.12 Listen for client disconnect: `req.raw.on('close', cleanup); req.raw.on('error', cleanup)`. The cleanup function: clears all timers, calls `unsubscribe`, decrements counter, ends reply

## 10. Update `OutboxPublisherService` to use coalescing properly

- [x] 10.1 Inside the publishBatch loop, group rows by `event_type`. The `scoreboard.score.credited` rows are published immediately, 1:1
- [x] 10.2 The `scoreboard.leaderboard.updated` rows are accumulated in a per-window buffer. At window boundary (`Math.floor(Date.now() / OUTBOX_COALESCE_WINDOW_MS) * OUTBOX_COALESCE_WINDOW_MS != lastWindow`), drain the buffer
- [x] 10.3 On drain: query `cache.getTop(10)`, compare to `this.lastPublishedTop10`, if different publish ONE message with the current top-10 and update `this.lastPublishedTop10`, set ALL the buffered rows' `published_at` (they're all "covered" by the one publish)
- [x] 10.4 If the top-10 didn't change, still mark the buffered rows' `published_at` (we're saying "we processed them, no publish needed")

## 11. ADR-11 split-brain documentation (capability: scoreboard-events) — GAP-04

- [x] 11.1 Edit `_bmad-output/planning-artifacts/architecture.md` ADR-11. Add a new section "Split-brain guarantee" explaining the JetStream dedup window vs Redis lock TTL math
- [x] 11.2 Update `architecture.md` `openGaps` to mark GAP-04 as "resolved"

## 12. Module wiring

- [x] 12.1 Updated `src/scoreboard/scoreboard.module.ts`: added `OutboxModule` import; added `LeaderboardStreamController`; `JetStreamSubscriber` + `LeaderboardUpdatesEmitter` live in `NatsModule` (@Global) and are available globally
- [x] 12.2 Confirmed: `NatsModule` imported in `AppModule`; `EventEmitterModule.forRoot()` added to `AppModule` imports
- [x] 12.3 Quality gates passed: `mise run typecheck` ✅, `mise run lint` ✅, `mise run build` ✅ (live boot test deferred to Wave 4 integration tests)

## 13. Integration tests (capability: scoreboard-quality, scoreboard-events, scoreboard-streaming)

- [x] 13.1 Create `test/integration/messaging/nats-publisher.test.ts` using `@testcontainers/nats`. Verify happy publish, dedup behavior (publish twice with same msgID, only one delivered to a test consumer)
- [x] 13.2 Create `test/integration/messaging/outbox-publisher.test.ts` covering: leader acquires lock, publishes unpublished rows, sets `published_at`, releases lock on shutdown
- [x] 13.3 Create `test/integration/messaging/coalescing.test.ts` covering: 50 leaderboard.updated rows in 100ms produce 1 publish; no-op publishes are skipped
- [x] 13.4 Create `test/integration/messaging/jetstream-subscriber.test.ts` covering: ephemeral consumer is created, messages are delivered to the local emitter, the consumer is destroyed on shutdown
- [x] 13.5 Create `test/integration/streaming/sse-controller.test.ts` covering: connection establishes with correct headers, initial snapshot is sent, live updates flow through, heartbeats fire every 15s, slow client is disconnected after timeout, connection-count cap returns 503
- [x] 13.6 Run `mise run test:integration` and verify all tests pass (NATS testcontainer pulls on first run)

## 14. End-to-end validation

- [x] 14.1 `mise run typecheck` exits 0
- [x] 14.2 `mise run lint` exits 0
- [x] 14.3 `mise run build` exits 0
- [x] 14.4 `mise run test:coverage` exits 0
- [x] 14.5 Manual smoke test: `mise run dev`, open an SSE connection via `curl -N http://localhost:3000/v1/leaderboard/stream -H "Authorization: Bearer <jwt>"`. See the `event: snapshot` frame
- [x] 14.6 In another terminal: send a credit. Within ~150ms, the SSE client receives an `event: leaderboard.updated` frame
- [x] 14.7 Wait 15s with no activity. The SSE client receives an `event: heartbeat` frame
- [x] 14.8 `psql` check: `SELECT * FROM outbox_events ORDER BY id DESC LIMIT 5` shows recent rows now have `published_at` set (the worker drained them)

## 15. Finalize

- [x] 15.1 Run `openspec validate step-06-streaming-and-fan-out`
- [x] 15.2 Mark all tasks complete and update File List
- [x] 15.3 Confirm GAP-02 and GAP-04 are marked resolved in `architecture.md`
