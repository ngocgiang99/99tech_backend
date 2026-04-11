## ADDED Requirements

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
