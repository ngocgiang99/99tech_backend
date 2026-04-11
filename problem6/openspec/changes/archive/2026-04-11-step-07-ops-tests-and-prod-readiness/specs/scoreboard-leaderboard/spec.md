## ADDED Requirements

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
