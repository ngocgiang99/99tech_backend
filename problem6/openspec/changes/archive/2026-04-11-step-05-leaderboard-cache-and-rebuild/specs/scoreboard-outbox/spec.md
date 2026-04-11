## ADDED Requirements

### Requirement: outbox_events table exists with the documented schema

The system SHALL provide a Kysely migration `0002_create_outbox_events.ts` that creates the `outbox_events` table per `README.md §6.1` (lines 250–259). The table SHALL have columns `id BIGSERIAL PRIMARY KEY`, `aggregate_id UUID NOT NULL`, `event_type TEXT NOT NULL`, `payload JSONB NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `published_at TIMESTAMPTZ`. It SHALL have a partial index `idx_outbox_unpublished (id) WHERE published_at IS NULL`.

#### Scenario: Migration creates the table with all columns
- **WHEN** `mise run db:migrate` is run after the new migration is added
- **THEN** the table `outbox_events` exists in the `scoreboard` database
- **AND** all six columns are present with the correct types
- **AND** `id` is a `BIGSERIAL` primary key

#### Scenario: Partial index supports unpublished-row scans
- **WHEN** `\d outbox_events` is run via `psql`
- **THEN** the partial index `idx_outbox_unpublished` exists with definition `(id) WHERE published_at IS NULL`

#### Scenario: Generated types include outbox_events
- **WHEN** `mise run db:codegen` is run after migration
- **THEN** `src/database/types.generated.ts` includes a `outbox_events` key in the `DB` type
- **AND** the `OutboxEvents` type has fields `{ id: number, aggregate_id: string, event_type: string, payload: unknown, created_at: Date, published_at: Date | null }` (or the codegen's equivalent)

### Requirement: Handler writes outbox row inside the same transaction as score_events

`IncrementScoreHandler.execute()` SHALL ensure that the `outbox_events` INSERT happens inside the SAME `BEGIN…COMMIT` block as the `score_events` INSERT and the `user_scores` upsert. If the transaction rolls back (e.g. unique constraint violation), neither `score_events` nor `outbox_events` rows are persisted.

#### Scenario: Successful credit writes all three tables atomically
- **GIVEN** an existing `user_scores` row with `total_score = 10`
- **WHEN** `handler.execute({ delta: 5, ... })` is called
- **THEN** within ONE transaction: `score_events` gets a row, `user_scores.total_score` becomes 15, `outbox_events` gets a row with `event_type = 'scoreboard.score.credited'` and `payload = { userId, actionId, delta: 5, newTotal: 15, occurredAt }`

#### Scenario: Rollback also rolls back the outbox row
- **GIVEN** a credit attempt with a duplicate `action_id`
- **WHEN** the transaction fails on the `score_events` UNIQUE violation
- **THEN** no row is added to `outbox_events`
- **AND** no row is added to `user_scores`

#### Scenario: Outbox row payload is well-formed JSON
- **GIVEN** a successful credit
- **WHEN** the outbox row is inspected
- **THEN** the `payload` column is a valid JSONB value
- **AND** parsing it yields `{ userId, actionId, delta, newTotal, occurredAt }` with the same field types as the `score_events` row
