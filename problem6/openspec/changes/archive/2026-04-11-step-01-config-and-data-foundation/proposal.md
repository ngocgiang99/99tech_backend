## Why

Before any business logic can be written for the scoreboard module, two foundations must exist: a **single typed gateway** for reading environment variables (so the app fails fast on misconfiguration and there is exactly one `process.env` access point) and a **typed Postgres data layer** wired through Kysely with the v1 source-of-truth schema (`score_events`, `user_scores`) and committed generated types. Every subsequent change in the module assumes both exist; shipping them together unblocks the domain, repository, handler, controller, and observability work that follows.

## What Changes

- Add `src/config/` module that loads, validates, and freezes environment variables through a `zod` schema covering every variable documented in `README.md §13.3`. Expose a strongly-typed `ConfigService.get(key)` (no `string | undefined`).
- Make `src/config/` the **only** location in `src/` allowed to read `process.env`. Enforced by lint convention and a grep check (`grep -r "process\.env" src/ --include="*.ts" | grep -v "src/config/"` returns nothing).
- Fail fast on missing or malformed env vars: process exits with non-zero code and logs the offending key(s) with the zod issue path before NestJS finishes booting.
- Add `kysely-ctl` configuration and the first migration file under `src/database/migrations/` that creates `score_events` (with `UNIQUE(action_id)` and `(user_id, created_at DESC)` index) and `user_scores` (with `(total_score DESC, updated_at ASC)` index) per `README.md §6.1`. **Explicitly defers** `outbox_events` to a later change in Epic 2.
- Wire `kysely-codegen` to regenerate `src/database/types.generated.ts` after migrations. Commit the generated file to the repo (per architecture step "Code Structure").
- Provide a Kysely database factory in `src/database/` that builds the `pg` pool from `ConfigService` (no direct env reads) and exposes a `Database` instance for downstream adapters (Story 1.6 onwards) to inject.
- Add `mise run db:migrate` and `mise run db:codegen` task definitions if they don't already work end-to-end against the running Postgres container from change `step-00` (the existing `mise.toml` has the task stubs but they have never been exercised against a real schema).

## Capabilities

### New Capabilities

- `scoreboard-config`: Single typed gateway for reading environment configuration. Validates the full env-var contract from `README.md §13.3` via zod, fails fast on misconfiguration, and exposes a strongly-typed `ConfigService.get(key)` to the rest of the application. Forbids direct `process.env` access anywhere outside `src/config/`.
- `scoreboard-database`: Typed Postgres data layer via Kysely. Owns the migration runner (`kysely-ctl`), the v1 schema (`score_events` + `user_scores`, deferring `outbox_events`), the codegen pipeline (`kysely-codegen` → `src/database/types.generated.ts`), and the `Database` factory that builds the `pg` pool from `ConfigService`.

### Modified Capabilities

_(none — first change in `problem6/`, no existing capability specs to delta)_

## Impact

**New code**:
- `src/config/{config.module.ts, config.service.ts, schema.ts, index.ts}` (~150 LOC)
- `src/database/{database.module.ts, database.factory.ts, kysely.config.ts, types.generated.ts}` (~120 LOC, plus generated types)
- `src/database/migrations/0001_create_score_events_and_user_scores.ts` (~50 LOC, Kysely migration)

**Modified code**:
- `src/app.module.ts` — import `ConfigModule` (global) and `DatabaseModule`
- `src/scoreboard/scoreboard.module.ts` — import `DatabaseModule` (will be consumed by Story 1.6's repository in change `step-02`)

**New dependencies** (added to `package.json` `dependencies`):
- `zod` (env schema validation)
- `kysely` (typed query builder)
- `pg` (Postgres driver)

**New dev dependencies** (added to `package.json` `devDependencies`):
- `kysely-ctl` (migration runner)
- `kysely-codegen` (type generator)
- `@types/pg`

**Configuration**:
- `kysely.config.ts` at `problem6/` root or `src/database/` (decision in design.md)
- `problem6/.env` must contain `DATABASE_URL` matching the running Postgres container (see `step-00`'s `.env.example` and `compose.override.yml` host port `55432`)

**Runtime contracts established for downstream changes**:
- `ConfigService.get('DATABASE_URL')` returns `string` (consumed by every Kysely-backed adapter from change `step-02` onwards)
- `Database` (Kysely instance) is injectable via NestJS DI (consumed by `step-02`'s `KyselyUserScoreRepository`)
- The schema in `types.generated.ts` is the contract that `step-02`'s repository writes against — any schema change must trigger a re-run of `mise run db:codegen` and a commit of the regenerated file

**Out of scope** (deferred to later changes):
- `outbox_events` table — belongs to `step-05` (leaderboard cache + outbox)
- Any application or domain code (`src/scoreboard/{domain,application}`) — belongs to `step-02`
- Any HTTP controllers, guards, or auth — belongs to `step-03`
- Integration tests against a real Postgres via Testcontainers — belongs to `step-04` (observability + quality gates)
