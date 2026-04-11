## ADDED Requirements

### Requirement: GAP-01 tie-breaking strategy is decided and recorded

The system SHALL record the chosen tie-breaking strategy as a new ADR amendment in `_bmad-output/planning-artifacts/architecture.md` (e.g. `ADR-16`) AND inline in this change's `design.md`. The chosen option SHALL drive every encoding/decoding line in `RedisLeaderboardCache`. The ZSET behavior SHALL be deterministic and verifiable in integration tests against the real Redis.

#### Scenario: Decision is recorded before implementation begins
- **WHEN** `/opsx:apply` reaches Task 1 of this change
- **THEN** the workflow halts and prompts the user to choose between bit-pack, two-ZSETs, or read-time reconciliation
- **AND** the chosen option is written into `architecture.md` ADR-16 with rationale
- **AND** `design.md` "Recorded answer" field is updated
- **AND** `architecture.md` `openGaps` GAP-01 is marked "resolved"

#### Scenario: Encoding matches the decision
- **GIVEN** the recorded decision is bit-pack with formula `encoded = score * 2^32 - updated_at_seconds`
- **WHEN** `RedisLeaderboardCache.upsert(userId, 100, 1700000000)` is called
- **THEN** the value sent to `ZADD leaderboard:global` is `100 * 2^32 - 1700000000`
- **AND** subsequent `getTop()` decodes back to `{ userId, score: 100, updatedAt: 1700000000 }`

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

`LeaderboardRebuilder.rebuild()` SHALL read the top-N (default 10000, configurable via `LEADERBOARD_REBUILD_TOP_N`) users from `user_scores` ordered by `total_score DESC, updated_at ASC` and write them to `leaderboard:global` via batched `ZADD`. Batches SHALL be ≤ 1000 rows per `MULTI`/`EXEC` block.

#### Scenario: Rebuild populates an empty ZSET from a populated Postgres
- **GIVEN** an empty `leaderboard:global` ZSET and a populated `user_scores` table with 50 users
- **WHEN** `rebuilder.rebuild()` is called
- **THEN** the ZSET has 50 members
- **AND** every member's encoded score matches the corresponding `user_scores` row
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

### Requirement: GET /v1/leaderboard/top returns the top-N

The system SHALL expose `GET /v1/leaderboard/top?limit=10` that returns `{ entries: [...], generatedAt }`. The `limit` query parameter SHALL default to 10, max 100. The endpoint reads from `RedisLeaderboardCache.getTop(limit)`. On empty cache, it falls back to a direct Postgres query.

#### Scenario: Happy path returns the cached top-10
- **GIVEN** the cache has 50 members
- **WHEN** `GET /v1/leaderboard/top?limit=10` is called
- **THEN** the response is `200` with `{ entries: [{ rank: 1, userId, score, updatedAt }, ...10 items], generatedAt }`
- **AND** the entries are in descending rank order (1, 2, 3, ...)

#### Scenario: Empty cache falls back to Postgres
- **GIVEN** the cache has 0 members AND `user_scores` has 5 users
- **WHEN** the endpoint is called with `limit=10`
- **THEN** the response is `200` with the top 5 users (sorted by `total_score DESC, updated_at ASC`)
- **AND** the response shape is identical to the cache-hit path
- **AND** the response header includes `X-Cache-Status: miss-fallback`

#### Scenario: limit exceeds max is rejected
- **WHEN** `GET /v1/leaderboard/top?limit=1000` is called
- **THEN** the response is `400 INVALID_REQUEST`
- **AND** the error envelope's `message` indicates `limit` must be ≤ 100

#### Scenario: MIN-03 decision determines auth requirement
- **WHEN** `/opsx:apply` reaches Task 12 (the controller wiring)
- **THEN** the workflow halts and prompts for the MIN-03 decision: public, JWT-gated, or scoped JWT
- **AND** the controller is decorated accordingly: no `@UseGuards`, `@UseGuards(JwtGuard)`, or `@UseGuards(JwtGuard, ScopedJwtGuard)`
- **AND** `architecture.md` `openGaps` MIN-03 is marked "resolved"
