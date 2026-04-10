## Why

The project scaffold (`s01-add-project-scaffold`) is in place but the service does not yet do what the brief asks: expose a CRUD API for a persisted resource. Without this change there is nothing for the caching layer, the test suite, the benchmarks, or the architecture docs to talk about. This is the change that makes the service actually useful.

We also want the CRUD layer to be honest about the performance targets in the brief (10k GET RPS, 100 write RPS). Shipping "naive CRUD" that will fall over under a benchmark is pointless — we'd just have to rewrite it in Change 5. So this change bakes in the choices that matter under load: keyset pagination, explicit indexes, prepared statements via Kysely, and a repository/service/controller separation that the cache layer in Change 3 can plug into without rewriting.

## What Changes

- Introduce a `resources` Postgres table with UUID primary key, `jsonb` metadata, `text[]` tags, `created_at`/`updated_at` timestamps, and indexes that the list endpoint depends on (keyset `(created_at DESC, id DESC)`, GIN on `tags`, B-tree on `type`, `status`, `owner_id`).
- Introduce a migration tool (Kysely migrations via `kysely-ctl`) and an initial migration creating the table and indexes.
- Introduce a Kysely client wired to the shared Postgres pool (`pg` driver) and register its readiness check into the health registry from Change 1.
- Introduce `src/modules/resources/` containing: Kysely-typed table definition, repository, service, Zod request/response schemas, controller, and router.
- Introduce five HTTP endpoints exposing the CRUD contract:
  - `POST   /resources`            — create
  - `GET    /resources`            — list with filters and keyset pagination
  - `GET    /resources/:id`        — read by id
  - `PATCH  /resources/:id`        — partial update
  - `DELETE /resources/:id`        — delete
- Introduce a consistent error taxonomy (`BadRequest`, `NotFound`, `Conflict`, `Validation`) mapped to HTTP status codes through the existing error handler.
- Introduce an `updated_at` trigger (or app-level set on every write) so concurrent updates cannot leave the timestamp stale.

## Capabilities

### New Capabilities

- `resources-management`: The domain contract for the `Resource` entity — what it is, how it can be created, listed, read, updated, and deleted, and which query parameters the list endpoint honors.

### Modified Capabilities

- `project-bootstrap`: The health registry SHALL gain a `db` check that confirms Postgres is reachable. This is a spec-level change to the existing health requirement because the set of checks contributing to readiness is now non-empty.

## Impact

- **New files**: `src/db/client.ts`, `src/db/schema.ts` (Kysely table types), `migrations/0001_create_resources.ts`, `src/modules/resources/{schema,repository,service,controller,router}.ts`, `src/lib/errors.ts`, `kysely.config.ts`.
- **Modified files**: `src/http/app.ts` (mount resources router), `src/index.ts` (construct Kysely client, register `db` health check and shutdown hook), `package.json` (add `kysely`, `pg`, `kysely-ctl` dev dep), `.env.example` (document any new vars), `docker-compose.yml` (ensure `DATABASE_URL` points at the compose postgres), `README.md` (document `pnpm db:migrate`).
- **New dependencies**: `kysely`, `pg`; dev: `kysely-ctl`, `@types/pg`.
- **APIs exposed**: Five new endpoints under `/resources`. The list endpoint returns `{data: Resource[], nextCursor: string | null}`.
- **Systems affected**: Postgres schema — one new table with five indexes; Kysely-generated type definitions consumed by the repository.
- **Breaking changes**: None (the scaffold change had no CRUD to break).
