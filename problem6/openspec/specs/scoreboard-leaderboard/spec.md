# scoreboard-leaderboard

## Purpose

The hot read path for the top-N leaderboard. Owns the `LeaderboardCache` port (defined in `scoreboard-domain`), the `RedisLeaderboardCache` adapter (Redis ZSET semantics per ADR-16 bit-pack encoding), the `LeaderboardRebuilder` (cold rebuild from Postgres for NFR-09 < 60s recovery), the boot-time `OnApplicationBootstrap` rebuild hook with readiness gating, and the `GET /v1/leaderboard/top` REST controller. Establishes the read contract that `step-06`'s SSE controller will reuse for its initial snapshot.

## Requirements

### Requirement: GAP-01 tie-breaking strategy is decided and recorded

The system SHALL record the chosen tie-breaking strategy as a new ADR amendment in `_bmad-output/planning-artifacts/architecture.md` (e.g. `ADR-16`) AND inline in this change's `design.md`. The chosen option SHALL drive every encoding/decoding line in `RedisLeaderboardCache`. The ZSET behavior SHALL be deterministic and verifiable in integration tests against the real Redis.

#### Scenario: Decision is recorded before implementation begins
- **WHEN** `/opsx:apply` reaches Task 1 of this change
- **THEN** the workflow halts and prompts the user to choose between bit-pack, two-ZSETs, or read-time reconciliation
- **AND** the chosen option is written into `architecture.md` ADR-16 with rationale (or noted in `design.md` if `architecture.md` does not exist in the repo)
- **AND** `design.md` "Recorded answer" field is updated
- **AND** any `openGaps` reference to GAP-01 is marked "resolved"

#### Scenario: Encoding matches the decision
- **GIVEN** the recorded decision is bit-pack with the canonical formula `encoded = score * SCORE_SHIFT + (MAX_TS - updatedAtSeconds)` where `SCORE_SHIFT = 2^32` and `MAX_TS = SCORE_SHIFT - 1`
- **WHEN** `RedisLeaderboardCache.upsert(userId, 100, t)` is called
- **THEN** the value sent to `ZADD leaderboard:global` is `100 * SCORE_SHIFT + (MAX_TS - tSeconds)`
- **AND** subsequent `getTop()` decodes back to `{ userId, score: 100, updatedAt: t }` (lossless within precision range)
- **AND** the precision range is documented (lossless for `score <= 2_097_151`; ordering still correct above that up to the domain cap of `1_000_000_000`)

### Requirement: RedisLeaderboardCache implements upsert / getTop / getRank

The `RedisLeaderboardCache` adapter SHALL implement the `LeaderboardCache` port with three methods: `upsert(userId, score, updatedAt)`, `getTop(n)`, and `getRank(userId)`. The semantics SHALL respect the GAP-01 decision.

#### Scenario: upsert adds or updates a member with the encoded score
- **GIVEN** an empty `leaderboard:global` ZSET
- **WHEN** `cache.upsert('u1', 100, t1)` is called
- **THEN** the ZSET has one member `'u1'` with the encoded score
- **AND** a subsequent `cache.upsert('u1', 150, t2)` updates the SAME member to the new encoded score (no duplicate)

#### Scenario: getTop returns members in descending score order
- **GIVEN** the ZSET has members `[u1: 100, u2: 200, u3: 50]`
- **WHEN** `cache.getTop(3)` is called
- **THEN** the result is `[{ userId: 'u2', score: 200, ... }, { userId: 'u1', score: 100, ... }, { userId: 'u3', score: 50, ... }]`

#### Scenario: getTop respects ties per the GAP-01 decision
- **GIVEN** two users with the same score but different `updated_at` (`u1: 100 at t1`, `u2: 100 at t2`, `t1 < t2`)
- **WHEN** `cache.getTop(2)` is called
- **THEN** `u1` (earlier `updated_at`) ranks higher than `u2`
- **AND** the ordering matches the recorded GAP-01 contract

#### Scenario: getRank returns 1-indexed rank or null
- **GIVEN** the ZSET has 5 members with `u3` ranked third
- **WHEN** `cache.getRank('u3')` is called
- **THEN** the result is `3` (1-indexed)
- **AND** `cache.getRank('u-not-present')` returns `null`

### Requirement: LeaderboardRebuilder repopulates the ZSET from Postgres

`LeaderboardRebuilder.rebuild()` SHALL read the top-N (default 10000, configurable via `LEADERBOARD_REBUILD_TOP_N`) users from `user_scores` ordered by `total_score DESC, updated_at ASC` and write them to `leaderboard:global` via batched `ZADD`. Batches SHALL be ≤ 1000 rows per `MULTI`/`EXEC` block. The encoding used by the rebuilder SHALL be identical to the one used by `RedisLeaderboardCache.upsert()` (i.e. share the same `encodeScore()` helper) so that ZSET entries written by the rebuilder decode and tie-break consistently with live upserts.

#### Scenario: Rebuild populates an empty ZSET from a populated Postgres
- **GIVEN** an empty `leaderboard:global` ZSET and a populated `user_scores` table with 50 users
- **WHEN** `rebuilder.rebuild()` is called
- **THEN** the ZSET has 50 members
- **AND** every member's encoded score matches the corresponding `user_scores` row using the canonical `encodeScore()` helper (not an inline duplicate formula)
- **AND** `rebuilder.rebuild()` returns `{ usersProcessed: 50, elapsedMs: <number> }`

#### Scenario: Rebuild respects the top-N cap
- **GIVEN** a `user_scores` table with 15000 users and `LEADERBOARD_REBUILD_TOP_N=10000`
- **WHEN** `rebuilder.rebuild()` is called
- **THEN** the ZSET has exactly 10000 members
- **AND** the 10000 members are the top 10000 by `total_score DESC, updated_at ASC`

#### Scenario: Rebuild logs progress every 1000 rows
- **WHEN** rebuilder processes a 5000-user dataset
- **THEN** at least 5 progress log lines appear at `info` level
- **AND** each log line includes `{ processed, total, elapsedMs }`

### Requirement: Boot-time rebuild on empty cache

On `OnApplicationBootstrap`, the system SHALL check `ZCARD leaderboard:global`. If the result is 0, the rebuilder SHALL run and the readiness flag (`readinessService.leaderboardReady`) SHALL be `false` until the rebuild completes. If the result is > 0, no rebuild runs and the flag is set to `true` immediately.

#### Scenario: Empty cache triggers rebuild on boot
- **GIVEN** an empty `leaderboard:global` ZSET when the app starts
- **WHEN** `OnApplicationBootstrap` runs
- **THEN** `readinessService.leaderboardReady` is `false`
- **AND** `rebuilder.rebuild()` is called
- **AND** when the rebuild completes, `readinessService.leaderboardReady` becomes `true`

#### Scenario: Populated cache skips rebuild on boot
- **GIVEN** the ZSET has 100 members when the app starts
- **WHEN** `OnApplicationBootstrap` runs
- **THEN** the rebuild is skipped
- **AND** `readinessService.leaderboardReady` is `true` immediately
- **AND** a log line indicates "cache already populated, skipping rebuild"

#### Scenario: Concurrent boot rebuilds are deduplicated via Redis lock
- **GIVEN** 3 API instances boot simultaneously with an empty cache
- **WHEN** all three try to rebuild
- **THEN** exactly one acquires the Redis lock `leaderboard:rebuild:lock` (or all three start, see ZCARD become non-zero, and skip)
- **AND** none of the rebuilds run twice
- **AND** all three readiness flags become `true` after the first rebuild completes

#### Scenario: Rebuild errors do not crash the process
- **GIVEN** a transient Postgres failure during a boot rebuild
- **WHEN** the rebuilder catches the error
- **THEN** the error is logged at `error` level
- **AND** `readinessService.leaderboardReady` remains `false`
- **AND** the process does NOT exit (the operator can manually trigger rebuild later)

### Requirement: GET /v1/leaderboard/top returns the top-N

The system SHALL expose `GET /v1/leaderboard/top?limit=10` that returns `{ entries: [...], generatedAt }`. The `limit` query parameter SHALL default to 10, max 100, min 1. The endpoint reads from `RedisLeaderboardCache.getTop(limit)` wrapped in the per-instance `Singleflight<TopEntry[]>`. If the Redis call succeeds (including returning an empty array), the response SHALL emit `X-Cache-Status: hit`. If the Redis call throws (connection error, timeout, max retries), the endpoint SHALL fall back to a direct Postgres query and emit `X-Cache-Status: miss`. The `X-Cache-Status` header is informational — it supports k6 load-test threshold assertions on cache hit rate and MUST NOT be relied on by production clients.

#### Scenario: Happy path returns the cached top-10 with hit header
- **GIVEN** the cache has 50 members
- **WHEN** `GET /v1/leaderboard/top?limit=10` is called with a valid JWT
- **THEN** the response is `200` with `{ entries: [{ rank: 1, userId, score, updatedAt }, ...10 items], generatedAt }`
- **AND** the entries are in descending rank order (1, 2, 3, ...)
- **AND** the response header `X-Cache-Status` is `hit`

#### Scenario: Empty cache is still a hit (no fallback, consistent empty state)
- **GIVEN** the cache has 0 members AND Redis is reachable (the ZREVRANGE call succeeds with an empty reply)
- **WHEN** the endpoint is called with `limit=10` and a valid JWT
- **THEN** the response is `200` with `{ entries: [], generatedAt }`
- **AND** the response header `X-Cache-Status` is `hit`
- **AND** the Postgres fallback query is NOT executed

#### Scenario: Redis failure falls back to Postgres with miss header
- **GIVEN** Redis is unreachable (the ZREVRANGE call throws a transport error)
- **AND** `user_scores` has 5 users
- **WHEN** the endpoint is called with `limit=10` and a valid JWT
- **THEN** the response is `200` with the top 5 users (sorted by `total_score DESC, updated_at ASC`)
- **AND** the response shape is identical to the cache-hit path
- **AND** the response header `X-Cache-Status` is `miss`

#### Scenario: limit exceeds max is rejected
- **WHEN** `GET /v1/leaderboard/top?limit=1000` is called
- **THEN** the response is `400 INVALID_REQUEST`
- **AND** the error envelope's `message` indicates `limit` must be ≤ 100

#### Scenario: limit below min is rejected
- **WHEN** `GET /v1/leaderboard/top?limit=0` is called
- **THEN** the response is `400 INVALID_REQUEST`

#### Scenario: MIN-03 — endpoint is JWT-gated
- **GIVEN** the recorded MIN-03 decision is option (b) JWT-gated
- **WHEN** `GET /v1/leaderboard/top` is called WITHOUT an `Authorization` header
- **THEN** the response is `401 UNAUTHENTICATED`
- **AND** the controller is decorated with `@UseGuards(JwtGuard)`
- **AND** any `openGaps` reference to MIN-03 is marked "resolved"

#### Scenario: Concurrent callers for the same limit share one Redis round-trip
- **GIVEN** 100 concurrent requests for `GET /v1/leaderboard/top?limit=10` arriving in the same 10ms window
- **WHEN** the singleflight-wrapped cache is invoked
- **THEN** Redis `ZREVRANGE leaderboard:global 0 9 WITHSCORES` is executed exactly once
- **AND** all 100 responses return successfully with the same entries
- **AND** all 100 responses carry `X-Cache-Status: hit`

### Requirement: Coalescing window queries LeaderboardCache.getTop(10) for diff check

The outbox coalescing window SHALL call `LeaderboardCache.getTop(10)` once per window to determine the current top-10. The publisher SHALL cache the LAST PUBLISHED top-10 in memory and only emit `scoreboard.leaderboard.updated` if the current and last differ.

#### Scenario: Coalesced window publishes only on top-10 change
- **GIVEN** the cached "last published top-10" matches the current `LeaderboardCache.getTop(10)` result
- **WHEN** the coalescing window closes
- **THEN** no `scoreboard.leaderboard.updated` message is published
- **AND** the cached "last published top-10" remains unchanged

#### Scenario: Top-10 change publishes once per window
- **GIVEN** the cached top-10 differs from the current `getTop(10)`
- **WHEN** the window closes
- **THEN** ONE `scoreboard.leaderboard.updated` message is published with the current top-10
- **AND** the cached "last published top-10" is updated to the current

### Requirement: Cold-rebuild benchmark verifies < 60s budget on 10M rows (MIN-02)

The system SHALL provide `scripts/benchmark-rebuild.ts` that verifies `LeaderboardRebuilder.rebuild()` completes within the NFR-09 budget on a realistic dataset. Running with `--rows 10000000` SHALL show the elapsed time is < 60 seconds. Running with the default 100000 rows SHALL also pass and is the fast-iteration check.

#### Scenario: 10M-row rebuild completes in < 60s
- **GIVEN** a Postgres seeded with 10M rows in `user_scores`
- **WHEN** the benchmark script runs `rebuilder.rebuild()`
- **THEN** the elapsed time is < 60000 ms
- **AND** the script logs `{ usersProcessed: 10000000, elapsedMs: <number> }`
- **AND** the script's exit code is 0 (success)

#### Scenario: First-deploy checklist references the benchmark
- **WHEN** `problem6/README.md §16.1` (Initial Deployment) is read
- **THEN** it includes a step instructing the operator to run `scripts/benchmark-rebuild.ts --rows 10000000` once against real infrastructure to verify NFR-09
- **AND** the step is documented as "one-time per deployment to a new environment"
