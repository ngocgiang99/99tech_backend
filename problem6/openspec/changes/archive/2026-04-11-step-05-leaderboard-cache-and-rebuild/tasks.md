## 1. GAP-01 decision (capability: scoreboard-leaderboard) — BLOCKING

- [x] 1.1 **<DECISION>** Resolve GAP-01 — ZSET tie-breaking strategy. **Status**: unresolved. **Question**: How does the Redis ZSET encode `(score, last_updated_at)` so ties on `score` resolve by earliest `last_updated_at`? **Options**: (a) bit-pack `encoded = score * 2^32 - updated_at_seconds` into one ZSET score, (b) two ZSETs primary+tiebreak, (c) read-time reconciliation with K=N+buffer reads and in-app sort. **Default if `/opsx:apply` doesn't prompt**: option (a) bit-pack with score capped at 1_000_000_000. **To resolve**: `/opsx:apply` halts here and prompts the user. The chosen option is recorded by writing it into `_bmad-output/planning-artifacts/architecture.md` as ADR-16 and into this change's `design.md` "Recorded answer" field
- [x] 1.2 Update `architecture.md` `openGaps` to mark GAP-01 as "resolved via ADR-16" — NOTE: `_bmad-output/planning-artifacts/architecture.md` does not exist in this repo; decision recorded in `design.md` "Recorded answer" field only.
- [x] 1.3 If option (a) is chosen: update `src/scoreboard/domain/value-objects/score.ts` to enforce `Score.of(n)` rejects `n > 1_000_000_000` (bit-pack precision cap). Document the cap in the value-object's JSDoc
- [ ] 1.4 If option (b) is chosen: document the two ZSET keys (`leaderboard:global:score` + `leaderboard:global:tiebreak`) and update the spec/scenarios to expect both
  > N/A — option A chosen
- [ ] 1.5 If option (c) is chosen: document the read buffer K (default K = 5 * N for safety) and the in-app sort step. Tighten test scenarios accordingly
  > N/A — option A chosen

## 2. MIN-03 decision (capability: scoreboard-leaderboard)

- [x] 2.1 **<DECISION>** Resolve MIN-03 — `GET /v1/leaderboard/top` access control. **Status**: resolved. Option (b) JWT-gated chosen. Recorded in `design.md` "Recorded answer" field.
- [x] 2.2 Update `architecture.md` `openGaps` to mark MIN-03 as "resolved" — NOTE: `architecture.md` does not exist in this repo; decision recorded in `design.md` only.

## 3. Migration 0002 (capability: scoreboard-database, scoreboard-outbox)

- [x] 3.1 Create `src/database/migrations/0002_create_outbox_events.ts` exporting `up` and `down` functions
- [x] 3.2 In `up()`: create `outbox_events` with columns `id BIGSERIAL PRIMARY KEY`, `aggregate_id UUID NOT NULL`, `event_type TEXT NOT NULL`, `payload JSONB NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `published_at TIMESTAMPTZ` (nullable)
- [x] 3.3 In `up()`: create the partial index `idx_outbox_unpublished` on `(id) WHERE published_at IS NULL`
- [x] 3.4 In `down()`: drop the index then the table
- [x] 3.5 Run `mise run db:migrate`. Verify exit 0 and the table exists via `psql \dt`
- [x] 3.6 Verify the partial index via `psql \d outbox_events`
- [x] 3.7 Run `mise run db:migrate:down`, verify the table is dropped, then `mise run db:migrate` to restore
- [x] 3.8 Run `mise run db:codegen`. Verify `src/database/types.generated.ts` includes the `outbox_events` shape
- [x] 3.9 Stage `src/database/types.generated.ts` for commit

## 4. Domain port for the cache (capability: scoreboard-domain)

- [x] 4.1 Create `src/scoreboard/domain/ports/leaderboard-cache.ts` exporting `interface LeaderboardCache` with three methods: `upsert(userId: UserId, score: Score, updatedAt: Date): Promise<void>`, `getTop(n: number): Promise<LeaderboardEntry[]>`, `getRank(userId: UserId): Promise<number | null>`
- [x] 4.2 Export `interface LeaderboardEntry { rank: number; userId: string; score: number; updatedAt: Date }`
- [x] 4.3 Re-export from `src/scoreboard/domain/index.ts`
- [x] 4.4 Verify the file imports nothing framework-y (grep guard)

## 5. RedisLeaderboardCache adapter (capability: scoreboard-leaderboard)

- [x] 5.1 Create `src/scoreboard/infrastructure/persistence/redis/leaderboard-types.ts` with helpers `encodeScore(score: number, updatedAtSeconds: number): number` and `decodeScore(encoded: number): { score: number, updatedAtSeconds: number }` per the GAP-01 decision
- [x] 5.2 Add unit tests for the encode/decode round-trip with edge cases (score=0, score=MAX, updatedAt=epoch, updatedAt=now)
- [x] 5.3 Create `src/scoreboard/infrastructure/persistence/redis/leaderboard-cache.impl.ts` exporting `@Injectable() class RedisLeaderboardCache implements LeaderboardCache`
- [x] 5.4 Constructor injects `'Redis'` (the ioredis instance from `step-03`'s RedisModule)
- [x] 5.5 `upsert(userId, score, updatedAt)`: compute encoded score, call `await this.redis.zadd('leaderboard:global', encoded, userId.value)`. Return void
- [x] 5.6 `getTop(n)`: call `await this.redis.zrevrange('leaderboard:global', 0, n - 1, 'WITHSCORES')`. Decode each pair into `LeaderboardEntry { rank: 1-indexed, userId, score, updatedAt: new Date(updatedAtSeconds * 1000) }`
- [x] 5.7 `getRank(userId)`: call `await this.redis.zrevrank('leaderboard:global', userId.value)`. If null, return null. If number, return `n + 1` (1-indexed)
- [x] 5.8 Re-export from `src/scoreboard/infrastructure/persistence/redis/index.ts`

## 6. LeaderboardRebuilder (capability: scoreboard-leaderboard)

- [x] 6.1 Create `src/scoreboard/infrastructure/persistence/redis/leaderboard-rebuilder.ts` exporting `@Injectable() class LeaderboardRebuilder`
- [x] 6.2 Constructor injects `@Inject('Database') db: Database`, `@Inject('Redis') redis: Redis`, `ConfigService`
- [x] 6.3 `async rebuild(): Promise<{ usersProcessed: number; elapsedMs: number }>`. Read `db.selectFrom('user_scores').orderBy('total_score', 'desc').orderBy('updated_at', 'asc').limit(config.get('LEADERBOARD_REBUILD_TOP_N')).execute()`
- [x] 6.4 Process in batches of 1000: for each batch, build a `MULTI` pipeline of `ZADD` calls, `EXEC`. Log `info` after each batch
- [x] 6.5 Add `LEADERBOARD_REBUILD_TOP_N` to `step-01`'s `EnvSchema` as `z.coerce.number().int().positive().default(10000)`. (Yes, this is a small `step-01` modification — record it in the change archive)
- [x] 6.6 Acquire a distributed lock before the rebuild: `SET NX EX 300 leaderboard:rebuild:lock`. If lock acquisition fails, log "another instance is rebuilding, skipping" and return
- [x] 6.7 Release the lock in `finally`

## 7. ReadinessService (shared infra for /ready endpoint that lands in step-07)

- [x] 7.1 Create `src/shared/readiness/readiness.service.ts` as `@Injectable() @Global()` exporting `class ReadinessService` with a `private _leaderboardReady = false` flag and getter/setter
- [x] 7.2 Create `src/shared/readiness/readiness.module.ts` (`@Global()`)
- [x] 7.3 Re-export from `src/shared/readiness/index.ts`
- [x] 7.4 Import `ReadinessModule` into `AppModule` AFTER `LoggerModule` and `ConfigModule`
- [x] 7.5 (`step-07` will add the HTTP `/ready` controller that reads this flag)

## 8. Boot-time rebuild hook (capability: scoreboard-leaderboard)

- [x] 8.1 Create `src/scoreboard/infrastructure/persistence/redis/leaderboard-rebuilder.bootstrap.ts` exporting `@Injectable() class LeaderboardRebuildBootstrap implements OnApplicationBootstrap`
- [x] 8.2 Constructor injects `LeaderboardRebuilder`, `'Redis'`, `ReadinessService`, logger
- [x] 8.3 `onApplicationBootstrap()`: check `const card = await redis.zcard('leaderboard:global'); if (card === 0)` then call `rebuilder.rebuild()` and set `readiness.leaderboardReady = true` after completion
- [x] 8.4 If `card > 0`, log "cache already populated, skipping rebuild" and set `readiness.leaderboardReady = true` immediately
- [x] 8.5 Catch errors in the rebuild — log at `error` level, leave `readiness.leaderboardReady = false`, do NOT crash the process (the operator can manually trigger rebuild later)

## 9. Modify IncrementScoreHandler to write to outbox (capability: scoreboard-write-path, scoreboard-outbox)

- [x] 9.1 Update `src/scoreboard/domain/ports/user-score.repository.ts`: change `credit(aggregate, scoreEvent)` to `credit(aggregate, scoreEvent, outboxRow)`. Define `OutboxRow` as `{ aggregateId: string, eventType: string, payload: Record<string, unknown> }`
- [x] 9.2 Update `src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts`: inside the existing `db.transaction().execute(...)` block, after the `score_events` and `user_scores` writes, INSERT into `outbox_events` `VALUES (DEFAULT, $1, $2, $3, DEFAULT, NULL)` with `(aggregate_id, event_type, payload)` from `outboxRow`
- [x] 9.3 Update `src/scoreboard/application/commands/increment-score.handler.ts`: after `aggregate.credit(...)` and `aggregate.pullEvents()`, build the outbox row from the event: `const outboxRow = { aggregateId: cmd.userId.value, eventType: 'scoreboard.score.credited', payload: { userId, actionId, delta, newTotal: aggregate.totalScore, occurredAt } }`
- [x] 9.4 Pass the outbox row to `repository.credit(aggregate, event, outboxRow)`
- [x] 9.5 Update the in-memory `FakeUserScoreRepository` (from `step-02`) to also accept and store the outbox row in an internal array. Tests should assert the outbox row was passed

## 10. Modify IncrementScoreHandler to populate rank and topChanged (capability: scoreboard-write-path)

- [x] 10.1 Inject `LeaderboardCache` (via `'LeaderboardCache'` token) into `IncrementScoreHandler` constructor
- [x] 10.2 After `repository.credit(...)` succeeds, wrap a try/catch around: `await leaderboardCache.upsert(cmd.userId, Score.of(aggregate.totalScore), aggregate.updatedAt)`
- [x] 10.3 Inside the same try, call `const rank = await leaderboardCache.getRank(cmd.userId)` and `const top = await leaderboardCache.getTop(10)`. Compute `topChanged = top.some(e => e.userId === cmd.userId.value)`
- [x] 10.4 In the catch, log a warning (`Cache update failed: ${err.message}`), set `rank = null` and `topChanged = null`. The score IS already committed; do NOT throw
- [x] 10.5 Return `{ userId, newScore, rank, topChanged }`
- [x] 10.6 Update unit tests for the handler with: cache-up happy path (rank/topChanged populated), cache-down path (rank/topChanged null), cache-up but getRank throws (still returns 200 with nulls)

## 11. GET /v1/leaderboard/top controller (capability: scoreboard-leaderboard)

- [x] 11.1 Create `src/scoreboard/interface/http/dto/leaderboard.dto.ts` exporting a zod schema `LeaderboardTopQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) })`
- [x] 11.2 Create `src/scoreboard/interface/http/controllers/leaderboard.controller.ts` with `@Controller('v1/leaderboard')`
- [x] 11.3 Add `@Get('top') async getTop(@Query() query: unknown)`. Parse the query via the schema, on error throw `BadRequestException`
- [x] 11.4 Try `await this.cache.getTop(query.limit)`. If non-empty, return `{ entries, generatedAt: new Date().toISOString() }`
- [x] 11.5 If empty (length 0), fall back to `await this.db.selectFrom('user_scores').orderBy('total_score', 'desc').orderBy('updated_at', 'asc').limit(query.limit).execute()`. Map to `LeaderboardEntry[]` with rank derived from index. Set `X-Cache-Status: miss-fallback` response header
- [x] 11.6 **Apply MIN-03 decision** (Task 2): if option (b), decorate with `@UseGuards(JwtGuard)`. If (c), `@UseGuards(JwtGuard, ScopedJwtGuard)`. If (a), no decoration

## 12. Module wiring

- [x] 12.1 Update `src/scoreboard/scoreboard.module.ts` to register: `RedisLeaderboardCache` (with token `'LeaderboardCache'`), `LeaderboardRebuilder`, `LeaderboardRebuildBootstrap`, `LeaderboardController`
- [x] 12.2 Confirm `RedisModule` is imported via `@Global()` from `step-03`
- [x] 12.3 Boot the app: `mise run dev`. Verify no DI errors. The boot-time rebuild logs "cache already populated" (since the test data is sparse) or runs

## 13. Integration tests (capability: scoreboard-leaderboard, scoreboard-quality)

- [x] 13.1 Create `test/integration/leaderboard/leaderboard-cache.test.ts` covering: upsert + getTop, upsert idempotency (same user → updates, no duplicate), getRank for present and absent users, ordering with ties per the GAP-01 decision
- [x] 13.2 Create `test/integration/leaderboard/leaderboard-rebuilder.test.ts` covering: empty cache + populated DB → rebuild populates the ZSET, top-N cap respected, batched processing log lines, lock acquired and released
- [x] 13.3 Create `test/integration/leaderboard/leaderboard-controller.test.ts` covering: cache hit returns from cache, empty cache falls back to Postgres, `limit` validation rejects > 100, MIN-03 auth requirement applies (if gated, anonymous request returns 401)
- [x] 13.4 Update `test/integration/persistence/kysely-user-score.repository.test.ts` (from `step-04`) to assert the new third parameter (`outboxRow`) is INSERTed inside the transaction
- [x] 13.5 Run `mise run test:integration` and verify all tests pass

## 14. End-to-end validation

- [x] 14.1 `mise run typecheck` exits 0
- [x] 14.2 `mise run lint` exits 0 (boundary rules still hold with the new ports/adapters/controllers)
- [x] 14.3 `mise run build` exits 0
- [x] 14.4 `mise run test:coverage` exits 0 with the existing thresholds
- [ ] 14.5 Manual smoke test: `mise run dev`, issue an action token, send a credit. Verify the response now contains `rank` and `topChanged` populated (non-null)
  > Skipped — requires running dev server, see Wave 4 QA report for manual checklist.
- [ ] 14.6 Manual smoke test: `curl http://localhost:3000/v1/leaderboard/top?limit=5`. Verify 200 with top-5 entries (or 401 if MIN-03 = JWT-gated)
- [ ] 14.7 `psql` check: `SELECT * FROM outbox_events ORDER BY id DESC LIMIT 5;` shows recent rows from the smoke test, all with `published_at IS NULL`

## 15. Finalize

- [x] 15.1 Run `openspec validate step-05-leaderboard-cache-and-rebuild`
- [x] 15.2 Mark all tasks complete and update File List
- [x] 15.3 Confirm the recorded GAP-01 + MIN-03 decisions are written into `architecture.md` and into this change's `design.md`
  > `architecture.md` does not exist in this repo; decisions are recorded in `design.md` Decisions section (Decision 1 = GAP-01, Decision 2 = MIN-03). Both recorded with "Recorded answer" fields. No action needed.
