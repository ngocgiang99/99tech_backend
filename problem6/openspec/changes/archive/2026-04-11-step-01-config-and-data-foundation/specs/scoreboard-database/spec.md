## ADDED Requirements

### Requirement: Kysely is the sole typed query builder for Postgres

The system SHALL use Kysely (with the `pg` driver) as the only TypeScript query builder for Postgres. Raw `pg.Pool.query()` calls SHALL NOT appear in any application or domain code; the only allowed `pg` usage is the pool construction inside the `DatabaseModule` factory.

#### Scenario: Database factory builds Kysely from ConfigService
- **WHEN** the app boots and `DatabaseModule` is initialised
- **THEN** the module constructs a `pg.Pool` using `configService.get('DATABASE_URL')`
- **AND** wraps it in a `Kysely<DB>` instance where `DB` is the type imported from `src/database/types.generated.ts`
- **AND** the `Database` token resolves to that single `Kysely<DB>` instance everywhere it is injected

#### Scenario: Direct pg.Pool usage outside DatabaseModule is forbidden
- **WHEN** the codebase is grepped with `grep -r "from 'pg'" src/ --include="*.ts" | grep -v "src/database/"`
- **THEN** zero matches are returned

### Requirement: First migration creates score_events and user_scores per README §6.1

The first Kysely migration SHALL create exactly two tables matching `README.md §6.1`: `score_events` (the append-only audit table) and `user_scores` (the current-total projection). The migration SHALL NOT create `outbox_events` — that table belongs to a later change in Epic 2.

#### Scenario: score_events table has the correct columns and constraints
- **WHEN** `mise run db:migrate` is run against an empty Postgres
- **THEN** a table `score_events` exists with columns `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `user_id UUID NOT NULL`, `action_id UUID NOT NULL`, `delta INTEGER NOT NULL CHECK (delta > 0)`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- **AND** the table has a unique constraint `uq_score_events_action` on `(action_id)`
- **AND** the table has an index `idx_score_events_user_created` on `(user_id, created_at DESC)`

#### Scenario: user_scores table has the correct columns and constraints
- **WHEN** `mise run db:migrate` is run
- **THEN** a table `user_scores` exists with columns `user_id UUID PRIMARY KEY`, `total_score BIGINT NOT NULL DEFAULT 0 CHECK (total_score >= 0)`, `last_action_id UUID`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- **AND** the table has an index `idx_user_scores_total_updated` on `(total_score DESC, updated_at ASC)`

#### Scenario: outbox_events is NOT created in this migration
- **WHEN** `mise run db:migrate` is run
- **THEN** querying `information_schema.tables` for `outbox_events` returns zero rows
- **AND** the migration file does not reference `outbox_events`

#### Scenario: UNIQUE(action_id) prevents duplicate inserts
- **WHEN** two `INSERT INTO score_events (user_id, action_id, delta) VALUES (...)` statements are run with the same `action_id`
- **THEN** the second insert fails with a Postgres unique violation error (SQLSTATE `23505`)
- **AND** only the first row is persisted

### Requirement: Migration runner is invokable via mise tasks

The system SHALL expose `mise run db:migrate` (apply migrations), `mise run db:migrate:make <name>` (create a new migration file), and `mise run db:migrate:down` (roll back the most recent migration) as the developer interface to the migration runner. These tasks already exist in `mise.toml` and SHALL work end-to-end against the running Postgres container.

#### Scenario: db:migrate applies pending migrations
- **WHEN** `mise run db:migrate` is run on a database with no migrations applied
- **THEN** the task exits 0
- **AND** all pending migration files (sorted lexically by filename) are applied in order
- **AND** `kysely_migration` table exists tracking applied migrations

#### Scenario: db:migrate is idempotent when nothing is pending
- **WHEN** `mise run db:migrate` is run a second time immediately after a successful first run
- **THEN** the task exits 0
- **AND** no migration files are re-applied
- **AND** the database state is unchanged

#### Scenario: db:migrate:down rolls back the most recent migration
- **WHEN** `mise run db:migrate:down` is run after a successful `db:migrate`
- **THEN** the most recent migration's `down()` function executes
- **AND** the tables created by that migration are dropped
- **AND** subsequent `db:migrate` re-applies the migration cleanly

### Requirement: kysely-codegen produces a committed types file

The system SHALL provide `mise run db:codegen` to regenerate `src/database/types.generated.ts` from the live schema. The generated file SHALL be committed to the repository so that `mise run typecheck` works without a live Postgres connection.

#### Scenario: db:codegen produces types matching the migrated schema
- **WHEN** the migration has been applied AND `mise run db:codegen` is run
- **THEN** `src/database/types.generated.ts` exists
- **AND** the file exports a `DB` type containing `score_events` and `user_scores` keys
- **AND** the `ScoreEvents` type has fields matching the migration columns (`id`, `user_id`, `action_id`, `delta`, `created_at`)
- **AND** the `UserScores` type has fields matching the migration columns (`user_id`, `total_score`, `last_action_id`, `updated_at`)

#### Scenario: db:codegen is deterministic (same schema → same file)
- **WHEN** `mise run db:codegen` is run twice in a row against the same migrated schema
- **THEN** the second run produces a `types.generated.ts` byte-identical to the first
- **AND** `git diff src/database/types.generated.ts` shows no changes

#### Scenario: Generated types file is tracked in git
- **WHEN** `git ls-files src/database/types.generated.ts` is run
- **THEN** the file appears in the output (not gitignored)
- **AND** the file's content matches the current migrated schema

### Requirement: Kysely instance is injectable via NestJS DI

The `Database` token SHALL be injectable into any provider via `@Inject('Database')`, and the resolved value SHALL be a `Kysely<DB>` instance built from `ConfigService`.

#### Scenario: Provider receives the typed Kysely instance via constructor injection
- **WHEN** a provider declares `constructor(@Inject('Database') private readonly db: Kysely<DB>)`
- **THEN** NestJS DI resolves the injection without error
- **AND** `this.db.selectFrom('user_scores').selectAll().execute()` typechecks against the `DB` type from `types.generated.ts`

#### Scenario: There is exactly one pg.Pool per Node process
- **WHEN** the app boots and multiple modules consume the `Database` token
- **THEN** all consumers receive the same `Kysely<DB>` instance (same memory address)
- **AND** the underlying `pg.Pool` was constructed exactly once during `DatabaseModule.forRootAsync()` initialization
