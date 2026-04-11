## Context

Epic 1 (`step-01` through `step-04`) is structurally complete. The system can credit scores, enforce auth and rate limits, log structured JSON, expose Prometheus metrics, and recover from misconfiguration. There is no read path for the leaderboard, no transactional outbox, and no NATS/SSE infrastructure.

This change opens Epic 2 by adding the **read-side infrastructure**: the Redis ZSET cache for fast top-N queries, the cold-rebuild service for NFR-09 (< 60s recovery from Postgres after Redis loss), the HTTP read endpoint, and the outbox table — but NOT the outbox publisher worker. The publisher worker is `step-06`'s job because it requires NATS to be wired.

The change is gated on **GAP-01** (the tie-breaking ZSET encoding decision). Without that decision, every adapter, test, and endpoint in this change is ambiguous about how `(score, last_updated_at)` becomes a single sortable ZSET key. The decision is task #1, with a `<DECISION>` marker that `/opsx:apply` halts on.

A second decision (`MIN-03`) governs whether the `/top` endpoint is public or JWT-gated. It's smaller scope but still material — if the answer is "public", we don't decorate the controller with `@UseGuards(JwtGuard)`, and observability/rate-limit considerations differ.

This is the largest single change since `step-03`. The risk is that the GAP-01 decision is more involved than expected (e.g. bit-packing has precision-loss edge cases that need careful documentation). I've allocated room in tasks.md to document the decision thoroughly before any encoding code is written.

## Goals / Non-Goals

**Goals:**
- GAP-01 is resolved with a written decision in `architecture.md` and inline in this change's `design.md`. The decision drives every encoding/decoding line in the cache adapter.
- MIN-03 is resolved with a written decision and the chosen guard configuration is applied to the controller.
- `outbox_events` table exists in Postgres after `mise run db:migrate` runs the new migration. `types.generated.ts` is regenerated and committed.
- `IncrementScoreHandler` writes to all THREE tables (`score_events`, `user_scores`, `outbox_events`) atomically inside one transaction. Either all three rows exist or none do.
- After the transaction commits, the handler asynchronously calls `leaderboardCache.upsert()`. If that fails, the response still returns 200 with `rank: null, topChanged: null` and a warning log. The score commit is non-revocable.
- After upsert succeeds, the handler calls `getRank()` and `getTop()` to populate the response DTO with `rank` and `topChanged`. These calls are best-effort — failures still return 200 with nulls.
- `RedisLeaderboardCache.upsert/getTop/getRank` all behave per the GAP-01 contract. Integration tests use real Redis to verify.
- `LeaderboardRebuilder.rebuild()` reads `user_scores` (top-N by score then updated_at) and populates the ZSET. Default top-N is 10000 (configurable via env if needed).
- `OnApplicationBootstrap` runs the rebuild if the ZSET is empty. The rebuild blocks readiness (`/ready` returns 503 until rebuild completes). NFR-09 budget: < 60s for typical datasets.
- `GET /v1/leaderboard/top` returns the cached top-10 (or the configured `limit`). On empty cache, falls back to a Postgres direct query for the same shape.
- Integration tests cover: cache round-trip per GAP-01 contract, rebuilder against a seeded database, controller against a populated cache, controller fallback against an empty cache.

**Non-Goals:**
- The outbox publisher worker (`OutboxPublisher` service that polls and publishes to JetStream) — `step-06`.
- NATS client wiring — `step-06`.
- The SSE controller for `/leaderboard/stream` — `step-06`.
- Coalescing / debouncing the cache updates — `step-06` introduces the coalescing window in the outbox publisher.
- Multi-leaderboard support (per-region, per-game-mode) — out of scope for v1.
- Adaptive top-N size in the rebuilder — fixed at 10000 for v1.
- Authoritative cold-rebuild benchmark on 10M rows — `step-07` does the benchmark for MIN-02.
- The `/health` and `/ready` HTTP endpoints — `step-07`. We set the readiness flag here; the endpoint controller is in `step-07`.

## Decisions

### Decision 1 — DECISION-1 (GAP-01): Tie-breaking strategy for ZSET

**What**: Resolved at `/opsx:apply` time. The three options below are presented to the user; the chosen option is recorded inline in this design.md AND in `architecture.md` as ADR-16.

**Option A — Bit-pack `(score, -updated_at)` into one ZSET score**
- Encoding: `encoded = score * 2^32 - (updated_at_seconds_since_epoch)`. For scores up to ~2 billion (`2^31`), this fits in JavaScript's safe integer range when stored as a Redis ZSET score (which is a 64-bit double).
- Pros: single ZSET, single ZADD per credit, atomic, O(log N) for getTop, exact.
- Cons: scores are capped (~2B). After the cap, precision loss makes ties resolve incorrectly. Not a problem for v1 if `Score` value object's max is set < 2B (it's `Number.MAX_SAFE_INTEGER` per `step-02` Q1, which is much higher — needs a tighter cap if option A is chosen).
- Decoding: `score = Math.floor(encoded / 2^32)`, `updated_at_seconds = -(encoded % 2^32)`.

**Option B — Two ZSETs (primary by score, tiebreaker by timestamp)**
- Storage: `leaderboard:global:score` ZSET keyed by score; `leaderboard:global:tiebreak` ZSET keyed by `-updated_at_seconds`.
- Encoding: each upsert is two `ZADD` calls, atomic via `MULTI`.
- getTop: read top-N from `leaderboard:global:score`, then break ties by reading the tiebreak ZSET for those N entries.
- Pros: no precision loss, supports any score range.
- Cons: two writes per credit (slightly slower), two reads per query, more complex test surface.

**Option C — Read-time reconciliation**
- Storage: single ZSET keyed by score only.
- Reads: read top-K (K = N + buffer, e.g. K = 50 for top-10) from the ZSET, then in app code, sort by `(score DESC, updated_at ASC)` (where `updated_at` comes from a parallel `MGET` from a side hash), take the top-N.
- Pros: simple ZSET, no encoding tricks.
- Cons: per-read latency includes a Redis MGET + JS sort. May not meet NFR-03 for hot reads under load. Edge case: if more than K entries tie on score, the buffer is too small and the result is wrong.

**Default if `/opsx:apply` doesn't prompt**: Option A (bit-pack) — it's the simplest and aligns with how most leaderboard systems encode tiebreakers. Tighten the `Score` value object's max to `1_000_000_000` (1 billion) to leave precision headroom. Document the cap in the runbook.

**Recorded answer (filled at /opsx:apply time)**: **Option A — Bit-pack** chosen. `encoded = score * 2^32 - updated_at_seconds`. Score value object is capped at `1_000_000_000` (one billion) to preserve bit-pack precision. Decoding: `score = Math.floor(encoded / 2^32)`, `updatedAtSec = -(encoded % 2^32)`. Recorded as ADR-16 in architecture.md (see note: architecture.md did not exist at apply time; decision recorded here only).

> **Encoding formula correction (impl-cache, Wave 2)**: the original design formula `encoded = score * 2^32 - updatedAtSeconds` produces incorrect `Math.floor` decode (yields `score - 1` for any non-zero timestamp). Implemented as: `encoded = score * SCORE_SHIFT + (MAX_TS - updatedAtSeconds)` where `MAX_TS = SCORE_SHIFT - 1`. Ordering guarantee (higher score → higher rank, ties broken by earlier `updatedAt`) is preserved. Lossless round-trip is guaranteed only for `score <= 2_097_151` (~2M); at `score = 1_000_000_000` ordering still holds but decoded `updatedAtSeconds` may be approximate due to float64 53-bit mantissa. See `src/scoreboard/infrastructure/persistence/redis/leaderboard-types.ts` JSDoc for full detail.

### Decision 2 — DECISION-2 (MIN-03): Public vs auth-gated `/v1/leaderboard/top`

**What**: The leaderboard top-N is a read-only resource. The architecture leaves open whether a JWT is required to read it.

**Option (a) — Public** (no `@UseGuards`): anyone can `curl` the endpoint and see the top-10. Pros: simplest, scales to any client. Cons: no per-user rate limit; aggregate rate limiting falls back to the global circuit breaker.

**Option (b) — JWT-gated** (`@UseGuards(JwtGuard)`): every reader must authenticate. Pros: per-user rate limit applies; user identity is logged for analytics. Cons: anonymous users can't peek at the leaderboard.

**Option (c) — Gated with a scoped JWT claim** (e.g. `scope: 'leaderboard:read'`): authenticated AND authorized. Pros: fine-grained access control. Cons: requires the identity service to issue scoped tokens (may not be possible).

**Default if `/opsx:apply` doesn't prompt**: Option (b) — JWT-gated. It's the safer choice for v1 (rate limit applies) and matches the rest of the API which is all JWT-gated.

**Recorded answer (filled at /opsx:apply time)**: **Option (b) — JWT-gated** chosen. `GET /v1/leaderboard/top` is decorated with `@UseGuards(JwtGuard)`. Per-user rate limit applies; matches the JWT-gated pattern of all other endpoints in the API.

### Decision 3: Outbox row format and the new `credit()` signature

**What**: The repository's `credit()` method gains a third parameter (or a new `creditWithOutbox()` method) accepting the outbox payload. The payload is `{ aggregate_id: userId, event_type: 'scoreboard.score.credited', payload: JSON.stringify({ userId, actionId, delta, newTotal, occurredAt }) }`. The repository inserts it into `outbox_events` inside the same transaction as `score_events` and `user_scores`.

**Why**:
- Atomicity is the entire point of the transactional outbox. The outbox row MUST be inserted in the same transaction.
- Adding a third parameter to `credit()` keeps the API simple: caller passes the aggregate, the score event, and the outbox event. The repository wires the SQL.
- The handler builds the outbox event from the aggregate's `pullEvents()` output (already a `ScoreCredited` instance).

**Alternatives considered**:
- **A separate `OutboxRepository.append(...)` called from the handler**. Rejected — the handler would have to coordinate two repositories inside one transaction, which means passing the transaction handle around. Messy.
- **An OutboxModule that listens for domain events and INSERTs in a separate transaction**. Rejected — breaks atomicity (if the second transaction fails, the score is committed but the event is lost).

### Decision 4: Post-commit cache update is a fire-and-forget call wrapped in a try/catch

**What**: After the Postgres transaction commits, the handler calls `await leaderboardCache.upsert(userId, newTotal, updatedAt)`. The call is wrapped in a try/catch that logs a warning and proceeds on error. If `upsert` succeeds, the handler then calls `getRank()` and `getTop()` to populate the response DTO. If those fail, response still returns 200 with nulls.

**Why**:
- The score is already durable in Postgres. Failing the request after the commit would mislead the client.
- The `LeaderboardRebuilder` is the recovery mechanism for cache divergence — if the cache is wrong, the next rebuild fixes it.
- `getRank` and `getTop` are best-effort enrichment, not part of the durability contract.

**Alternatives considered**:
- **Synchronously fail the request if upsert fails**. Rejected — the client would believe the credit was lost when it wasn't.
- **Queue the upsert to a background job**. Rejected — adds complexity for marginal benefit. The outbox publisher in `step-06` will republish the event if the cache is missing it.

### Decision 5: `LeaderboardRebuilder` runs at boot and blocks readiness

**What**: A NestJS `OnApplicationBootstrap` hook in `LeaderboardRebuilderService` checks `ZCARD leaderboard:global`. If 0, the rebuilder runs and sets a `readiness.leaderboardReady = false` flag during the rebuild. When the rebuild completes, the flag becomes `true`. The `/ready` endpoint (in `step-07`) reads this flag.

**Why**:
- Empty cache + accepting traffic = users see empty leaderboard. Bad UX.
- Blocking readiness lets Kubernetes/load balancers gate traffic until the cache is hot.
- The rebuild is also exposed as a manually-triggerable admin endpoint (or CLI) for incident recovery.

**Alternatives considered**:
- **Skip the rebuild on boot, let the cache populate organically**. Rejected — first 1000 users see an empty `top` until enough credits arrive.
- **Always rebuild on boot, even if the cache is non-empty**. Rejected — wasteful in normal restarts. The `ZCARD == 0` check is the right trigger.

### Decision 6: Default top-N for the rebuilder is 10000

**What**: `LeaderboardRebuilder.rebuild()` reads the top 10000 users by `total_score DESC, updated_at ASC` from `user_scores` and populates the ZSET. Configurable via env var `LEADERBOARD_REBUILD_TOP_N` (added to `EnvSchema` in this change).

**Why**:
- The leaderboard exposes top-10. 10000 is a 1000x buffer — more than enough headroom for `getRank` lookups of users who fall out of the top-10 but are still on a "near top" view.
- Any larger N is wasted Redis memory; any smaller N risks `getRank` returning null too often.

**Alternatives considered**:
- **All users**. Rejected — unbounded memory growth in Redis. Mitigation in `step-07` (cold-rebuild benchmark) confirms 10000 is a safe choice for the v1 dataset.

## Risks / Trade-offs

- **[Risk]** GAP-01's Option A (bit-pack) silently breaks at score > 2^31. If the `Score` value object's max stays at `Number.MAX_SAFE_INTEGER`, a malicious user could push their score above the bit-pack capacity and corrupt the leaderboard → **Mitigation**: tighten the `Score.of()` cap to `1_000_000_000` if Option A is chosen. The cap goes in `step-02`'s domain layer (which means a small follow-up commit there). Document in design.md.

- **[Risk]** The `LeaderboardRebuilder` runs on app boot, which serializes startup. With 3 replicas, all three rebuild simultaneously and contend for Postgres → **Mitigation**: only one rebuild runs at a time across the cluster. Use a Redis SET NX lock (`leaderboard:rebuild:lock`, TTL 5 minutes) — the loser instances wait for the rebuild to complete. The redis lock pattern already exists in `step-03`'s rate-limit work. Cleaner alternative: each instance checks `ZCARD` on its own, and since one instance's rebuild populates the ZSET, the other two skip on second-check.

- **[Risk]** The cache update is fire-and-forget after commit. If Redis goes down right after a credit, the cache misses that update permanently → **Mitigation**: the outbox publisher in `step-06` will republish the event. The next consumer of the event (the cache update) will refresh from the publisher. End-to-end consistency is restored within the publisher's polling interval (50ms).

- **[Risk]** Modifying `IncrementScoreHandler` from `step-02` is a regression risk for the entire write path → **Mitigation**: comprehensive integration tests against real Postgres in `step-04` already verify the write path. The new outbox INSERT is added to those tests as a "the outbox row also exists" assertion. The post-commit cache update is a separate code path; its integration tests verify it independently.

- **[Risk]** The `/v1/leaderboard/top` fallback to direct Postgres query is uncovered by load tests until `step-07` → **Mitigation**: document the fallback latency budget in the controller (target < 50ms p95 even on Postgres direct query for top-10). `step-07`'s k6 test verifies.

- **[Trade-off]** The handler now does 3 things on success (commit, upsert, getTop) and 2 are best-effort. Latency p99 increases by ~5-10ms (Redis round trips). Acceptable for v1.

- **[Trade-off]** The outbox table is a future-cost choice — it adds INSERT time per credit and grows unbounded until the publisher (step-06) drains it. The growth is bounded by `published_at IS NULL` rows, which the publisher keeps small.

## Open Questions

- **Q1 — DECISION-1 (GAP-01)**: see Decision 1 above.
- **Q2 — DECISION-2 (MIN-03)**: see Decision 2 above.
- **Q3: Should the rebuilder log progress at intervals?** Yes — every 1000 rows processed, log at `info` level with `{ processed, total, elapsedMs }`.
- **Q4: Should the rebuilder be idempotent if the ZSET is already populated?** Yes — if `ZCARD > 0`, skip the rebuild and log "cache already populated, skipping rebuild". The manual admin trigger forces a full rebuild regardless.
- **Q5: Should `getRank` return 0-indexed or 1-indexed ranks?** **Default decision**: 1-indexed (rank 1 is the top). 0-indexed is technically correct but UX-hostile.
