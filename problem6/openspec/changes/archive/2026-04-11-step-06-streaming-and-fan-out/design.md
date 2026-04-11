## Context

After `step-05`, the leaderboard cache exists, the outbox table is populated atomically with score credits, and `GET /v1/leaderboard/top` returns fresh data. But:
- `outbox_events.published_at` is always NULL — nobody is publishing.
- There's no NATS connection.
- There's no SSE controller.
- Clients can poll `/top` but can't subscribe to live updates.

This is the most architecturally complex change in the sequence. It introduces three new infrastructure components (NATS client, outbox worker, SSE controller) that must work together correctly under failure modes (instance crashes mid-publish, slow SSE clients, JetStream unavailable, Redis lock expiry races). The architecture (`README.md §8`, `architecture.md` ADRs 04, 09, 11) is detailed about the design — this change implements it faithfully.

The hardest piece is the **outbox publisher worker**. It must:
- Run on every API instance but only one is the leader at a time (Redis lock).
- Survive lock expiry races without double-publishing (JetStream `Nats-Msg-Id` dedup is the safety net — see GAP-04 below).
- Coalesce bursts of leaderboard updates so SSE clients aren't hammered.
- Drain unpublished rows reliably even after instance crashes.

The second-hardest piece is the **SSE controller**. SSE is a long-lived connection with subtle backpressure semantics. Slow clients can OOM the API instance if not handled. Our solution is the GAP-02 backpressure policy (decision needed).

The third-hardest piece is **wiring it all together**. The outbox worker → JetStream → ephemeral consumer → local emitter → SSE controller chain has 5 hops. Tracing a message end-to-end requires all five to be correctly instrumented.

## Goals / Non-Goals

**Goals:**
- The `SCOREBOARD` JetStream stream exists and is correctly configured (per `step-00`'s `mise run nats:init` and the `StreamBootstrap` reapplication on boot).
- Domain events flow from `outbox_events` → JetStream → ephemeral consumers → local emitters → SSE clients within ≤ 1s p95 (NFR-03).
- Exactly one outbox publisher is leader at a time across all instances. Redis lock + 2-min JetStream dedup window protects against split-brain double-publishing (GAP-04 documentation).
- Coalescing reduces 50+ rapid score credits to ≤ 1 leaderboard.updated message per 100ms window.
- The publisher only emits `scoreboard.leaderboard.updated` if the top-10 actually changed (skips no-op updates for non-leaderboard credits).
- Each API instance has its own ephemeral push consumer with `inactive_threshold=30s` (auto-GC if instance dies).
- `GET /v1/leaderboard/stream` returns the SSE protocol headers, sends an initial snapshot, forwards local emitter events, and sends heartbeats every 15s.
- Slow SSE clients are detected and disconnected per the GAP-02 policy (thresholds decided at `/opsx:apply` time).
- All new components are unit-tested with mocked NATS/Redis and integration-tested against real NATS via Testcontainers.

**Non-Goals:**
- Reconnect logic on the client side — that's the client's responsibility. The server emits a clean SSE termination on disconnect; the client reconnects with a fresh `GET /v1/leaderboard/stream`.
- Historical replay — the JetStream stream has retention but consumers are `DeliverPolicy.New`, so they only see messages emitted after they connect. No backfill on reconnect.
- Per-user filtering — every SSE client gets the same global top-10 stream. Per-user "your rank" data could be added later.
- Multi-leaderboard fan-out — single leaderboard, single ZSET, single stream subject.
- WebSocket support — SSE only per ADR-09.
- Distributed tracing of SSE messages end-to-end — observability traces stop at the outbox publisher publish call. SSE-side tracing is best-effort.

## Decisions

### Decision 1 — DECISION-1 (GAP-02): SSE backpressure thresholds

**What**: Resolved at `/opsx:apply` time. The architecture says "drop-oldest + disconnect on overflow" but doesn't specify the exact thresholds. Three sub-questions:

**Sub-Q1: How many pending messages per client before drop-oldest activates?**
- Options: 10, 50, 100, 200
- **Default suggestion**: 50 (matches a healthy ~1Hz update rate × 50 seconds of slack)

**Sub-Q2: How long can the per-client buffer stay full before the connection is closed?**
- Options: 1s, 3s, 5s, 10s, 30s
- **Default suggestion**: 5s (matches ack_wait on the JetStream consumer; if the client can't drain in 5s, it's never going to)

**Sub-Q3: What does "buffer full" mean — message count or byte count?**
- Options: (a) message count only, (b) byte count only, (c) both (whichever comes first)
- **Default suggestion**: message count only — simpler to reason about, and each message is small (~500 bytes for a top-10 snapshot)

**Default if `/opsx:apply` doesn't prompt**: 50 messages, 5s timeout, message-count-only. The values land in `EnvSchema` as `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES`, `SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS`. Operators can tune later.

**Recorded answer**: _(unresolved)_

### Decision 2: Outbox lock TTL is 10s, lock-renewal heartbeat is 5s

**What**: The Redis key `outbox:lock` has TTL 10s. The leader extends the TTL every 5s while it's actively polling. If the leader dies without renewing, the lock expires within 10s and another instance becomes leader.

**Why**:
- **10s TTL** is short enough that a dead leader doesn't block the queue for long, but long enough to survive a transient pause (e.g. GC pause).
- **5s heartbeat** gives a 2x safety margin (renew at 50% of TTL).
- **JetStream's 2-min dedup window** is far longer than the lock TTL, so even if two leaders briefly publish the same message during a lock-handover race, JetStream's dedup catches it. This is the GAP-04 split-brain guarantee.

**Alternatives considered**:
- **Longer TTL** (60s). Rejected — a dead leader blocks the queue for too long.
- **No renewal, just re-acquire on each poll**. Rejected — adds Redis call overhead and creates a race window every 50ms instead of every 5s.

### Decision 3: Coalescing window is 100ms tumbling, with top-10 diff check

**What**: The publisher accumulates `scoreboard.leaderboard.updated` events in a 100ms window keyed by wall-clock time (`Math.floor(Date.now() / 100) * 100`). At window close, it queries `LeaderboardCache.getTop(10)` for the CURRENT top-10, compares it to the LAST PUBLISHED top-10 (cached in memory), and only publishes the new top-10 if they differ. Raw `scoreboard.score.credited` events (the per-credit audit events) are NOT coalesced — they go out 1:1.

**Why**:
- **100ms window** matches NFR-03's "≤ 1s p95" budget with 10x slack. Coalescing 50 credits in a 100ms window publishes 1 message instead of 50, dramatically reducing JetStream and SSE write rates.
- **Top-10 diff check** prevents non-leaderboard-changing credits from generating no-op updates. A user crediting from rank #500 to rank #500 doesn't cause a leaderboard update; only a rank change in the top 10 does.
- **Raw events stay 1:1** because analytics consumers (future) need every score event, not just leaderboard transitions.

**Alternatives considered**:
- **Sliding window** (no clear window boundary, just "last 100ms"). Rejected — harder to reason about; tumbling is simpler.
- **No diff check, publish every coalesced window**. Rejected — wastes SSE bandwidth on no-op updates.

### Decision 4: Each API instance creates its own ephemeral consumer with `inactive_threshold=30s`

**What**: On `OnApplicationBootstrap`, the `JetStreamSubscriber` calls `js.consumers.create('SCOREBOARD', { filter_subject: 'scoreboard.leaderboard.updated', deliver_policy: DeliverPolicy.New, ack_policy: AckPolicy.Explicit, ack_wait: 5_000_000_000, inactive_threshold: 30_000_000_000 })`. The consumer's name is auto-generated (no fixed name). It's destroyed by JetStream automatically after 30s of inactivity.

**Why**:
- **Ephemeral**: each instance gets its own consumer, no inter-instance coordination.
- **`DeliverPolicy.New`**: consumers only see messages published AFTER they were created. No backfill on instance restart (acceptable — the SSE clients reconnect and get a fresh snapshot from the cache).
- **`inactive_threshold=30s`**: if an instance dies without cleanly closing its consumer, JetStream removes the consumer state after 30s. Prevents consumer leak.

**Alternatives considered**:
- **Durable consumer per instance** with a stable name. Rejected — name collisions risk if two instances accidentally share a name. Ephemeral is simpler.
- **Single durable consumer shared across all instances**. Rejected — JetStream's load-balancing of a shared consumer means each message goes to ONE instance, not all; this breaks the "broadcast to all SSE clients across all instances" model.

### Decision 5: SSE writes use `reply.raw.write(...)` directly (Fastify low-level)

**What**: The SSE controller uses `reply.raw.write('event: snapshot\ndata: <json>\n\n')` to write SSE frames directly to the underlying socket. NestJS's `@Sse()` decorator is NOT used because it returns an Observable and we want fine-grained control over backpressure.

**Why**:
- **Backpressure control**: NestJS's `@Sse()` doesn't expose the underlying socket buffer. We need to know when writes are pending to enforce GAP-02's drop-oldest/disconnect policy.
- **Heartbeat control**: we need to send heartbeats on a custom interval, separate from data events.
- **Custom termination**: we need clean termination logic for slow-client disconnects.

**Alternatives considered**:
- **NestJS `@Sse()` decorator with RxJS**. Rejected — abstracts the socket too far from the backpressure tracking.
- **A separate Fastify plugin for SSE**. Considered, but adds another dependency.

### Decision 6: ADR-11 split-brain documentation (GAP-04)

**What**: After implementation, append to `architecture.md` ADR-11 a section explicitly stating: "Concurrent leaders during lock expiry race cannot cause duplicate fan-out because the JetStream `Nats-Msg-Id` dedup window (2 minutes) is significantly longer than the lock TTL (10 seconds). Even if two leaders briefly publish the same outbox row, JetStream deduplicates by `msgID = outbox.id` and delivers exactly once to each consumer."

**Why**: GAP-04 from the planning phase is "outbox split-brain documentation". This change resolves it by writing the explicit guarantee.

### Decision 7: SSE controller does NOT include rate-limiting on connection establishment

**What**: `GET /v1/leaderboard/stream` is decorated with `@UseGuards(JwtGuard)` only. The `RateLimitGuard` from `step-03` is NOT applied to SSE connections.

**Why**:
- **Rate limit is per-request**: it counts each SSE connection as one request, but the connection lasts hours. Applying the per-second budget would either block all SSE connections after 10 (the per-user budget) or never. Neither is correct.
- **Connection-count limiting** is a different problem (NFR-01: 10k concurrent SSE per cluster, ~3300 per instance). We track this with the `MAX_SSE_CONN_PER_INSTANCE` config but don't enforce it as a guard — it's enforced at the controller level by checking `currentConnectionCount` and returning 503 if exceeded.

**Alternatives considered**:
- **Apply RateLimitGuard with a separate "connect" budget**. Rejected — too complex for v1; the per-instance connection cap covers the practical case.

## Risks / Trade-offs

- **[Risk]** The JetStream SDK has subtle reconnection semantics. If NATS goes down mid-publish, the SDK retries internally — but if the publisher worker can't tell whether the publish succeeded, it might double-publish on retry → **Mitigation**: JetStream's `Nats-Msg-Id` dedup catches this. The publisher is allowed to retry naively because the dedup window protects us.

- **[Risk]** The outbox lock heartbeat (every 5s) is a single point of failure. If the heartbeat fails (e.g. transient Redis blip), the lock expires and another instance takes over — but the original leader doesn't KNOW it lost the lock and continues publishing → **Mitigation**: GAP-04 dedup window protects us. Worst case is brief duplicate publishing during the race window, all caught by dedup.

- **[Risk]** SSE connections across instances see the SAME global stream. With 3 instances and 10000 users, ~3333 users connect to each instance. A leaderboard update is published once to JetStream, fanned out to 3 ephemeral consumers, each forwarding to ~3333 SSE clients. The total fan-out is 10000 socket writes per update → **Mitigation**: NFR-01 capacity is 10k SSE total (3.3k per instance × 3 instances). Each instance must handle 3.3k concurrent socket writes in < 100ms. The SSE controller writes are non-blocking; Node's event loop handles this fine for socket writes. Verified via k6 in `step-07`.

- **[Risk]** A slow SSE client could pin a stale snapshot for the rest of its connection. If the client is hopelessly slow, our drop-oldest policy means they see ZERO updates between drops — but they're not disconnected because the buffer never overflows → **Mitigation**: each `event: leaderboard.updated` message includes the full current top-10, so even if they only get one message every 30 seconds, that one message is still up-to-date. Correctness is preserved at the cost of update frequency.

- **[Risk]** The coalescing window's "skip no-op updates" check requires reading `LeaderboardCache.getTop(10)` twice per window (before and after). That's 2 Redis reads per 100ms per instance — manageable but worth measuring → **Mitigation**: cache the "last published top-10" in memory. Only call `LeaderboardCache.getTop(10)` once per window.

- **[Risk]** The ephemeral consumer's `inactive_threshold=30s` means a paused-for-31s instance loses its consumer and won't receive messages until it creates a new one → **Mitigation**: 30s of inactivity is unusual for a healthy instance. If it happens, the next request to the SSE controller triggers a re-subscribe via the local emitter, and the new ephemeral consumer is created. Brief gap in updates is acceptable.

- **[Risk]** `OutboxPublisherService` blocks NestJS shutdown if the polling loop is in the middle of a publish → **Mitigation**: `OnApplicationShutdown` hook sets a `shouldStop = true` flag, the polling loop checks it after each publish, and exits cleanly. Add a 30s shutdown timeout in case JetStream is unresponsive.

- **[Trade-off]** The publisher worker runs on EVERY instance (3 of them), but only one is leader. The other two waste CPU on the lock-acquire-fail loop (every 5s). Cost is negligible — one Redis SETNX per 5s per non-leader instance.

- **[Trade-off]** Coalescing means `scoreboard.leaderboard.updated` is delayed by up to 100ms. Total end-to-end latency is `commit (1ms) + outbox poll (50ms avg) + JetStream publish (5ms) + JetStream → consumer (5ms) + emitter → SSE write (1ms) + network (~30ms) ≈ 100ms`. Plus the 100ms coalescing window, that's ≤ 250ms total, well under the 1s NFR-03 budget.

## Open Questions

- **Q1 — DECISION-1 (GAP-02)**: see Decision 1 above.
- **Q2: Should the outbox publisher have an explicit "drain on shutdown" mode?** I.e. before exiting, publish all unpublished rows. **Default decision**: no — the next instance to acquire the lock will pick them up. Adds complexity for marginal benefit.
- **Q3: Should `OUTBOX_POLL_INTERVAL_MS` differ between leader and non-leader?** Non-leaders can poll less aggressively. **Default decision**: same interval (50ms) for both. Premature optimization.
- **Q4: How does the SSE controller handle JetStream being unreachable on connection?** The initial snapshot comes from `LeaderboardCache.getTop(10)` (which itself can fall back to Postgres direct query per `step-05`). Live updates simply don't arrive — the client sees only the snapshot until JetStream recovers. **Default decision**: keep the connection open and serve heartbeats; document the degraded mode in the operator runbook (which gets a brief mention in `step-07`'s SPOF runbook).
- **Q5: Does the SSE controller need a connection-count limit?** Yes — `MAX_SSE_CONN_PER_INSTANCE` from `step-01`'s schema. The controller checks `currentConnectionCount >= MAX_SSE_CONN_PER_INSTANCE` and returns `503 TEMPORARILY_UNAVAILABLE` if exceeded. This is enforced in the controller, not as a guard.
