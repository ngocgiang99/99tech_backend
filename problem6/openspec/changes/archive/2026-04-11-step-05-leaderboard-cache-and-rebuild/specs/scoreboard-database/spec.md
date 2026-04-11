## ADDED Requirements

### Requirement: Migration 0002 adds outbox_events table

The system SHALL provide migration `0002_create_outbox_events.ts` that creates the `outbox_events` table and the partial index `idx_outbox_unpublished`. After this migration runs, `mise run db:codegen` SHALL be re-run and the regenerated `types.generated.ts` SHALL be committed.

#### Scenario: Migration 0002 applies cleanly after migration 0001
- **GIVEN** migration 0001 has been applied (from step-01)
- **WHEN** `mise run db:migrate` is run with migration 0002 in place
- **THEN** the migration runner detects 0002 as pending
- **AND** applies it
- **AND** exits 0
- **AND** `outbox_events` table now exists alongside `score_events` and `user_scores`

#### Scenario: types.generated.ts is regenerated and committed
- **GIVEN** migration 0002 has been applied
- **WHEN** `mise run db:codegen` is run
- **THEN** `src/database/types.generated.ts` is updated to include the `outbox_events` table
- **AND** `git status` shows the regenerated file as modified
- **AND** the file is staged and committed as part of this change
