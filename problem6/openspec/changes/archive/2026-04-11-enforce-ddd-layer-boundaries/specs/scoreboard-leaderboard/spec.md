## MODIFIED Requirements

### Requirement: GET /v1/leaderboard/top returns the top-N

The system SHALL expose `GET /v1/leaderboard/top?limit=10` that returns `{ entries: [...], generatedAt }`. The `limit` query parameter SHALL default to 10, max 100, min 1. The endpoint SHALL delegate to `GetLeaderboardTopHandler` (an application-layer query handler living at `src/scoreboard/application/queries/get-leaderboard-top.handler.ts`). The handler SHALL try `RedisLeaderboardCache.getTop(limit)` first (which is itself wrapped in a per-instance `Singleflight<TopEntry[]>`); on success, the handler returns `{ source: 'hit', entries }`. On any throw from the cache, the handler SHALL call `UserScoreRepository.findTopN(limit)` and return `{ source: 'miss', entries }`. The controller SHALL emit `X-Cache-Status: hit` when the handler's `source` is `'hit'` and `X-Cache-Status: miss` when `source` is `'miss'`. The controller SHALL NOT directly invoke the Kysely `Database` handle or construct ad-hoc SQL queries; all data access goes through the handler.

The `X-Cache-Status` header is informational — it supports k6 load-test threshold assertions on cache hit rate and MUST NOT be relied on by production clients.

#### Scenario: Happy path returns the cached top-10 with hit header
- **GIVEN** the cache has 50 members
- **WHEN** `GET /v1/leaderboard/top?limit=10` is called with a valid JWT
- **THEN** `GetLeaderboardTopHandler.execute(10)` is invoked
- **AND** the handler returns `{ source: 'hit', entries: [10 items] }`
- **AND** the response is `200` with `{ entries: [{ rank: 1, userId, score, updatedAt }, ...10 items], generatedAt }`
- **AND** the entries are in descending rank order (1, 2, 3, ...)
- **AND** the response header `X-Cache-Status` is `hit`

#### Scenario: Empty cache is still a hit (no fallback, consistent empty state)
- **GIVEN** the cache has 0 members AND Redis is reachable (the ZREVRANGE call succeeds with an empty reply)
- **WHEN** the endpoint is called with `limit=10` and a valid JWT
- **THEN** the handler returns `{ source: 'hit', entries: [] }`
- **AND** the response is `200` with `{ entries: [], generatedAt }`
- **AND** the response header `X-Cache-Status` is `hit`
- **AND** `UserScoreRepository.findTopN(10)` is NOT called

#### Scenario: Redis failure falls back to Postgres with miss header
- **GIVEN** Redis is unreachable (the ZREVRANGE call throws a transport error)
- **AND** `user_scores` has 5 users
- **WHEN** the endpoint is called with `limit=10` and a valid JWT
- **THEN** the handler catches the cache throw
- **AND** calls `UserScoreRepository.findTopN(10)` which returns 5 entries sorted `total_score DESC, updated_at ASC`
- **AND** the handler returns `{ source: 'miss', entries: [5 items] }`
- **AND** the controller returns `200` with `{ entries: [...5 items], generatedAt }`
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
- **WHEN** the handler invokes the singleflight-wrapped cache
- **THEN** Redis `ZREVRANGE leaderboard:global 0 9 WITHSCORES` is executed exactly once
- **AND** all 100 responses return successfully with the same entries
- **AND** all 100 responses carry `X-Cache-Status: hit`

#### Scenario: LeaderboardController does NOT import Database or Kysely directly
- **WHEN** `src/scoreboard/interface/http/controllers/leaderboard.controller.ts` is inspected
- **THEN** it does NOT contain `from '.*database'` imports
- **AND** it does NOT contain `selectFrom('user_scores')` or any other Kysely query-builder call
- **AND** its only constructor dependencies are `GetLeaderboardTopHandler` and the built-in NestJS primitives

### Requirement: GetLeaderboardTopHandler is the application-layer query handler

The system SHALL provide `GetLeaderboardTopHandler` at `src/scoreboard/application/queries/get-leaderboard-top.handler.ts`. The handler SHALL be a `@Injectable()` class with one public method: `execute(limit: number): Promise<GetLeaderboardTopResult>` where `GetLeaderboardTopResult = { source: 'hit' | 'miss'; entries: TopEntry[] }`. The handler SHALL receive `LeaderboardCache` and `UserScoreRepository` via DI injection. On a cache hit, it returns `source: 'hit'`; on any cache throw, it returns `source: 'miss'` after calling the repository fallback.

#### Scenario: Handler returns hit when cache succeeds
- **GIVEN** a mock `LeaderboardCache.getTop(10)` resolving to `[10 entries]`
- **WHEN** `handler.execute(10)` is called
- **THEN** the result is `{ source: 'hit', entries: [10 entries] }`
- **AND** the repository's `findTopN` is NOT called

#### Scenario: Handler returns miss when cache throws
- **GIVEN** a mock `LeaderboardCache.getTop(10)` rejecting with any error
- **AND** a mock `UserScoreRepository.findTopN(10)` resolving to `[5 entries]`
- **WHEN** `handler.execute(10)` is called
- **THEN** the result is `{ source: 'miss', entries: [5 entries] }`

#### Scenario: Handler propagates repository errors when both fail
- **GIVEN** a mock `LeaderboardCache.getTop(10)` that throws
- **AND** a mock `UserScoreRepository.findTopN(10)` that also throws
- **WHEN** `handler.execute(10)` is called
- **THEN** the repository error propagates up to the caller
- **AND** the controller's `wrapUnknown` path surfaces it as a 500 or 503 per the error type

#### Scenario: Handler is registered in ScoreboardModule
- **WHEN** `ScoreboardModule` is inspected
- **THEN** `GetLeaderboardTopHandler` is in the `providers` list
- **AND** it is exported if referenced by other modules (otherwise kept module-local)
