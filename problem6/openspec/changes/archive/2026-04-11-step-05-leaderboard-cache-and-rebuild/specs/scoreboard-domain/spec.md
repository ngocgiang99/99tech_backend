## ADDED Requirements

### Requirement: LeaderboardCache port lives in the domain layer

The system SHALL define a `LeaderboardCache` port at `src/scoreboard/domain/ports/leaderboard-cache.ts` as an `interface` with three methods: `upsert(userId: UserId, score: Score, updatedAt: Date): Promise<void>`, `getTop(n: number): Promise<LeaderboardEntry[]>`, `getRank(userId: UserId): Promise<number | null>`. The port SHALL NOT import any framework or infrastructure symbols.

#### Scenario: Port file imports nothing framework-y
- **WHEN** `grep -r "from '@nestjs\\|from '(kysely\\|pg\\|ioredis\\|nats)'" src/scoreboard/domain/ports/leaderboard-cache.ts` is run
- **THEN** zero matches are returned

#### Scenario: LeaderboardEntry is a domain type with rank, userId, score, updatedAt
- **WHEN** the port file is read
- **THEN** it exports a `LeaderboardEntry` interface with at minimum `{ rank: number, userId: string, score: number, updatedAt: Date }`

#### Scenario: getRank is 1-indexed and nullable
- **WHEN** the interface is read
- **THEN** `getRank` returns `Promise<number | null>` where `1` is the top-ranked user and `null` means the user is not in the cache
