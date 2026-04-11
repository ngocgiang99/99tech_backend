## Why

Epic 1 is structurally complete after `step-04`: the write path is secure, observable, tested, and operationally documented. Epic 2 starts with the **leaderboard read path** — turning persisted score events into a fast top-N query and a cold-rebuild fallback. This change is the foundation of Epic 2: it lands the outbox table, the Redis ZSET cache adapter, the post-commit ZADD logic in the handler, the cold-rebuild service, and the `GET /v1/leaderboard/top` REST endpoint. The streaming layer (NATS, SSE, fan-out) comes in `step-06`.

This change is **blocked at task #1 by GAP-01** — the architecture explicitly says no Epic 2 work can ship until the tie-breaking strategy is decided. Task 1 of `tasks.md` is the decision-recording task with a `<DECISION>` marker; `/opsx:apply` will halt and prompt for the answer before proceeding.

## What Changes

- **Resolve GAP-01 (Story 2.1)**: pick a tie-breaking strategy for the Redis ZSET. The decision determines the encoding used by every other task in this change. Three options: (a) bit-pack `(score << 32) - updated_at_seconds` into one ZSET score, (b) use TWO ZSETs (primary by score, tiebreaker by timestamp), (c) read-time reconciliation (read top-20 from ZSET, sort in-app, return top-10). The decision is recorded as a new ADR amendment in `_bmad-output/planning-artifacts/architecture.md` and as inline documentation in this change's `design.md`. **`<DECISION>` — `/opsx:apply` halts and prompts you for the choice.**
- **Resolve MIN-03 (Story 2.6)**: decide whether `GET /v1/leaderboard/top` is public or JWT-gated. Three sub-options: (a) public (no auth), (b) gated by general JWT (any authenticated user), (c) gated by a specific scope/claim. **`<DECISION>` — `/opsx:apply` halts and prompts.**
- Add a new Kysely migration `0002_create_outbox_events.ts` that creates the `outbox_events` table per `README.md §6.1` (columns: `id BIGSERIAL PK, aggregate_id UUID, event_type TEXT, payload JSONB, created_at TIMESTAMPTZ, published_at TIMESTAMPTZ`) with the partial index `idx_outbox_unpublished (id) WHERE published_at IS NULL`.
- Re-run `mise run db:codegen` to regenerate `src/database/types.generated.ts` with the new `outbox_events` shape; commit the regenerated file.
- **Modify `IncrementScoreHandler`** (from `step-02`/`step-03`) to also INSERT a row into `outbox_events` inside the SAME transaction as `score_events` and `user_scores`. The new row has `event_type='scoreboard.score.credited'` and `payload` containing `{ userId, actionId, delta, newTotal, occurredAt }`. The repository's `credit()` method gets a new parameter (or a new method) for the outbox row.
- Define the `LeaderboardCache` port in `src/scoreboard/domain/ports/leaderboard-cache.ts` with methods `upsert(userId, score, updatedAt): Promise<void>`, `getTop(n): Promise<LeaderboardEntry[]>`, `getRank(userId): Promise<number | null>`. The encoding semantics depend on the GAP-01 decision.
- Implement `RedisLeaderboardCache` in `src/scoreboard/infrastructure/persistence/redis/leaderboard-cache.impl.ts` using ZSET semantics per the GAP-01 decision. Bind to a fixed key `leaderboard:global`.
- Add `LeaderboardRebuilder` service in `src/scoreboard/infrastructure/persistence/redis/leaderboard-rebuilder.ts` that reads `user_scores` from Postgres (top-N by `total_score DESC, updated_at ASC`) and writes them all to the Redis ZSET via batched `ZADD`. Default batch size 1000 rows per `MULTI`.
- Wire `LeaderboardRebuilder.rebuild()` into a NestJS startup hook (`OnApplicationBootstrap`) that runs at boot if the ZSET is empty (`ZCARD leaderboard:global == 0`). Block the `/ready` endpoint until the rebuild completes (the `/ready` endpoint itself lands in `step-07`; this change just sets the readiness flag in a shared service).
- **Modify `IncrementScoreHandler`** to call `leaderboardCache.upsert()` AFTER the Postgres transaction commits. Then call `leaderboardCache.getRank(userId)` and `getTop(10)` to populate `rank` and `topChanged` in the response DTO (replacing the `null` placeholders from `step-02`).
- **If `LeaderboardCache.upsert()` fails** (Redis down), the handler logs a warning and returns the response with `rank: null` and `topChanged: null` — does NOT fail the request (the score is already committed in Postgres).
- Add `GET /v1/leaderboard/top?limit=10` controller in `src/scoreboard/interface/http/controllers/leaderboard.controller.ts`. Returns `{ entries: [...], generatedAt }` per `README.md §7.3`. If the ZSET is empty, falls back to a direct Postgres `ORDER BY total_score DESC, updated_at ASC LIMIT N` query.
- Wire all new providers into `ScoreboardModule`.
- Integration tests for the cache adapter, the rebuilder, and the controller (Testcontainers, real Redis + Postgres).

## Capabilities

### New Capabilities

- `scoreboard-leaderboard`: The hot read path for the top-N leaderboard. Owns the `LeaderboardCache` port, the `RedisLeaderboardCache` adapter (ZSET semantics per GAP-01), the `LeaderboardRebuilder` (cold rebuild from Postgres for NFR-09), and the `GET /v1/leaderboard/top` REST controller. Establishes the read contract that `step-06`'s SSE controller will reuse for its initial snapshot.
- `scoreboard-outbox`: The transactional outbox table and the write-through wiring inside `IncrementScoreHandler`. The table is migrated, the handler inserts into it, and that's it for this change. The background publisher worker that drains the table is in `step-06`.

### Modified Capabilities

- `scoreboard-database`: Adds the `outbox_events` table via migration `0002_*`. Regenerates `types.generated.ts` to include the new shape.
- `scoreboard-write-path`: Modifies `IncrementScoreHandler` to (1) insert the outbox row inside the existing transaction, (2) call `leaderboardCache.upsert()` post-commit, (3) populate `rank` and `topChanged` in the response DTO. Modifies `KyselyUserScoreRepository.credit()` (or adds a new method) to accept the outbox row.
- `scoreboard-domain`: Adds the `LeaderboardCache` port interface in `src/scoreboard/domain/ports/`.

## Impact

**New code**:
- `src/database/migrations/0002_create_outbox_events.ts` (~40 LOC)
- `src/scoreboard/domain/ports/leaderboard-cache.ts` (~30 LOC)
- `src/scoreboard/infrastructure/persistence/redis/leaderboard-cache.impl.ts` (~150 LOC; encoding logic depends on GAP-01)
- `src/scoreboard/infrastructure/persistence/redis/leaderboard-rebuilder.ts` (~120 LOC)
- `src/scoreboard/infrastructure/persistence/redis/leaderboard-types.ts` (~20 LOC, the encoding/decoding helpers)
- `src/scoreboard/interface/http/controllers/leaderboard.controller.ts` (~80 LOC)
- `src/scoreboard/interface/http/dto/leaderboard.dto.ts` (~30 LOC)
- `src/scoreboard/application/queries/get-top-leaderboard.handler.ts` (~50 LOC, optional — controller can call cache directly)
- Integration tests: `test/integration/leaderboard/leaderboard-cache.test.ts`, `leaderboard-rebuilder.test.ts`, `leaderboard-controller.test.ts` (~300 LOC)

**Modified code**:
- `src/scoreboard/application/commands/increment-score.handler.ts` — outbox insert + post-commit ZADD + populate rank/topChanged
- `src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts` — `credit()` accepts the outbox row and INSERTs it inside the transaction
- `src/scoreboard/scoreboard.module.ts` — register `LeaderboardCache`, `RedisLeaderboardCache`, `LeaderboardRebuilder`, `LeaderboardController`
- `src/scoreboard/domain/ports/user-score.repository.ts` — update `credit()` signature to accept the outbox row
- `src/database/types.generated.ts` — regenerated by `mise run db:codegen` after the migration

**Decisions** (`<DECISION>` markers in tasks.md):
- **DECISION-1 (GAP-01)**: Tie-breaking strategy. Options (a) bit-pack, (b) two ZSETs, (c) read-time reconciliation. The choice fundamentally shapes the cache adapter implementation.
- **DECISION-2 (MIN-03)**: Public vs auth-gated `/v1/leaderboard/top`. Options (a) public, (b) general JWT, (c) scoped JWT. Affects whether `LeaderboardController` uses `@UseGuards(JwtGuard)` or not.

**Out of scope** (deferred):
- The outbox publisher worker (the background process that drains `outbox_events` and publishes to JetStream) — `step-06`.
- NATS / JetStream client wiring — `step-06`.
- SSE controller and live updates — `step-06`.
- Cold-rebuild benchmark on a 10M-row dataset (MIN-02) — `step-07`.
- The `/health` and `/ready` HTTP endpoints — `step-07`. (The readiness flag is set here; the controller exposing it lands in `step-07`.)
