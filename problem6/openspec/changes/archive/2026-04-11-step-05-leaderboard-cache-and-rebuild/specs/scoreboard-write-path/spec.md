## ADDED Requirements

### Requirement: Handler writes outbox row inside the existing transaction

`IncrementScoreHandler.execute()` SHALL be modified to also insert a row into `outbox_events` inside the SAME `BEGIN…COMMIT` block as the `score_events` INSERT and `user_scores` upsert. The repository's `credit()` method (or a new `creditWithOutbox()`) SHALL accept a third parameter for the outbox row.

#### Scenario: All three writes are atomic
- **GIVEN** a credit request with delta=5 for user u1 with prior total 10
- **WHEN** handler.execute runs
- **THEN** the same transaction inserts a `score_events` row, upserts `user_scores` to total=15, AND inserts an `outbox_events` row with `event_type='scoreboard.score.credited'` and `payload` JSONB containing `{userId, actionId, delta, newTotal, occurredAt}`

### Requirement: Handler populates rank and topChanged in the response DTO

`IncrementScoreHandler.execute()` SHALL be modified to call `leaderboardCache.upsert()`, `leaderboardCache.getRank()`, and `leaderboardCache.getTop(10)` AFTER the transaction commits. The response DTO SHALL be `{ userId, newScore, rank: number | null, topChanged: boolean | null }` where `rank` is the user's 1-indexed position (or null on error/cache-down) and `topChanged` is true if the user is now in the top 10 (or null on error).

#### Scenario: Successful flow populates rank and topChanged
- **GIVEN** a successful credit and a populated cache where the user becomes rank 3 in the top 10
- **WHEN** the handler returns
- **THEN** the response is `{ userId, newScore, rank: 3, topChanged: true }`

#### Scenario: User outside top 10 has topChanged false
- **GIVEN** a credit that puts the user at rank 50
- **WHEN** the handler returns
- **THEN** `rank: 50, topChanged: false`

#### Scenario: Cache failure does not fail the request
- **GIVEN** a successful Postgres commit followed by a Redis-down failure during `cache.upsert`
- **WHEN** the handler catches the error
- **THEN** a warning log is emitted with the error
- **AND** the response is `{ userId, newScore, rank: null, topChanged: null }`
- **AND** the HTTP status is 200 (not 500)

#### Scenario: getRank failure after successful upsert still returns 200
- **GIVEN** `cache.upsert` succeeds but `cache.getRank` throws
- **WHEN** the handler catches the second failure
- **THEN** the response is `{ userId, newScore, rank: null, topChanged: null }`
- **AND** the HTTP status is 200
