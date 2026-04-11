## MODIFIED Requirements

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
