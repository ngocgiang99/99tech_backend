## Context

Change 1 produced a running Express service that does nothing interesting. This change implements the actual product: a CRUD API for the `Resource` entity. Everything downstream — the Redis cache, the test suite, the benchmarks, the architecture docs — depends on the API contract and database schema this change locks in. If we get the shape wrong here, Change 3's cache will leak abstractions into Change 2's handlers, Change 4's tests will duplicate setup, and Change 5's benchmarks will benchmark the wrong thing.

Two constraints drive the shape of this change:

1. **Performance is not an afterthought.** The service's stated targets are 10k GET RPS and 100 write RPS. The database is the primary bottleneck risk. Poor index selection, offset pagination, or cursor-less `LIMIT` scans will make the cache layer in Change 3 irrelevant because the miss path will collapse under load. We pick indexes and a pagination strategy that survive the benchmark.

2. **The service boundary must be cache-friendly.** The controller/service/repository split exists so that Change 3 can inject a cache layer between service and repository without touching HTTP code or spec behavior. This is why the controller is thin and the service is the only layer that calls the repository.

## Goals / Non-Goals

**Goals:**

- Ship a complete CRUD contract (`POST`, `GET list`, `GET one`, `PATCH`, `DELETE`) that matches the spec scenarios exactly, with Zod validation on every inbound body and query.
- Use Postgres indexes and keyset pagination so the list endpoint is O(index-seek) regardless of page depth.
- Separate controller, service, and repository layers so Change 3 can inject a cache at the service boundary without rewriting handlers.
- Produce a migration that can be run idempotently via `pnpm db:migrate` both on the host (via mise) and inside the api container.
- Extend the existing `HealthCheckRegistry` with a `db` check instead of inventing a parallel mechanism.

**Non-Goals:**

- Read caching of any kind. Change 3 adds the cache.
- Full-text search on `name` (the user explicitly dropped `q` from the filter set).
- Soft deletes / `deletedAt` column. Deletes are hard.
- Optimistic concurrency control (`If-Match`/ETag). The brief doesn't require it and we have no writers competing under the benchmark (100 writes/s is low).
- Bulk create / bulk update / bulk delete endpoints.
- Authentication and authorization. Out of scope for the brief.
- Audit log of changes.

## Decisions

### Decision 1: Kysely (not Prisma, Drizzle, or raw `pg`)

Confirmed with the user. Kysely gives us type-safe query building that stays close to SQL, which matters when we tune queries for the benchmark (adding `EXPLAIN ANALYZE`, forcing an index hint, rewriting a filter to hit the GIN index). Prisma's query planner is opaque and adds a runtime layer; Drizzle's DSL is more opinionated and less familiar to most reviewers; raw `pg` loses all type safety.

**Alternatives considered:**

- *Prisma*: Great DX for greenfield features, but the generated client and its runtime add cost at 10k RPS, and query-level tuning is harder.
- *Drizzle*: Close competitor; the call is mostly taste. Kysely wins for us because it's "types on top of SQL," which is closer to what we'll actually debug under load.
- *Raw `pg`*: Fastest, but losing types defeats the point of TypeScript.

### Decision 2: Keyset pagination, not offset

Offset pagination (`LIMIT 20 OFFSET 10000`) forces Postgres to scan and discard 10,000 rows for every deep-page request. At 10k RPS with a non-trivial distribution of page requests, this collapses. Keyset pagination (`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20`) is O(index-seek) regardless of page depth.

The cursor is the base64-encoded JSON of the last row's `(createdAt, id)` tuple. We base64 it so clients treat it as opaque and cannot be tempted to parse or mutate it.

**Alternatives considered:**

- *Offset pagination*: Simpler, universally understood. Rejected on performance grounds.
- *Raw timestamp cursor*: Exposes implementation detail; clients might try to skip pages by forging timestamps. Rejected.
- *Server-side cursor in a session*: Stateful, doesn't scale horizontally, breaks with restarts.

### Decision 3: Indexes on the `resources` table

The list endpoint's filter set and sort order imply the following indexes:

- `PRIMARY KEY (id)` — implicit.
- `INDEX (created_at DESC, id DESC)` — covers the default `ORDER BY` and the keyset predicate.
- `INDEX (type)` — covers `?type=`.
- `INDEX (status)` — covers `?status=`.
- `INDEX (owner_id)` — covers `?ownerId=`.
- `GIN INDEX (tags)` — covers `?tag=x&tag=y` via `tags @> ARRAY['x','y']`.

Filter combinations are rare enough that a composite index per combination would bloat storage and write cost (we have 100 write RPS; writes are cheap today and must stay cheap). Single-column indexes plus the planner's bitmap-and strategy is the right trade-off for this workload.

We deliberately do **not** add an index on `name` because we dropped text search.

**Alternatives considered:**

- *No indexes beyond the primary key*: Fine at 0 rows, dies at 10k rows with 10k RPS.
- *Composite index per filter combination*: 5+ indexes for a handful of combos; write amplification.
- *`pg_trgm` index on `name`*: Only needed if we had `q`. Dropped with `q`.

### Decision 4: Repository / Service / Controller layering

```
HTTP request
   ↓
controller (zod validation → calls service, translates errors to HTTP)
   ↓
service (business rules, wraps repository in a narrow interface)
   ↓
repository (Kysely queries only; no HTTP or logging concerns)
   ↓
Postgres
```

The cache layer in Change 3 will wrap the **repository interface**, not the service. Decorating the repository means the service is blind to whether a cache exists, and both branches (cache hit, cache miss) return the same shape. This is the cleanest seam for the dependency inversion we'll need in Change 3.

**Alternatives considered:**

- *Skip the service layer, let the controller call the repository*: Saves one file but forces cache logic into either the controller (ugly) or the repository (mixing concerns).
- *Fat service with embedded SQL*: No type safety on queries, harder to test.

### Decision 5: `metadata` update is replace, not deep merge

PATCH semantics for JSON documents are notoriously ambiguous (see JSON Merge Patch vs. JSON Patch). We pick the less-clever option: `PATCH /resources/:id` with `{"metadata": {...}}` replaces the entire `metadata` object. Clients that want to merge can `GET`, modify, and `PATCH` the merged result themselves.

We codify this in the spec so there is no ambiguity at review time.

**Alternatives considered:**

- *Deep merge*: Powerful but produces surprising behavior (how do you delete a key?).
- *JSON Patch (RFC 6902)*: More expressive, but overkill for the brief.

### Decision 6: UUID generation in Postgres, not the app

We use `gen_random_uuid()` (from `pgcrypto`, available by default in Postgres 13+) so that the database is the single source of truth for id creation. Generating ids in the app first means the app and the DB disagree on truth during an insert; generating them in the DB means the `RETURNING id` clause gives us the canonical value and we never have to worry about app-side rand sources.

**Alternatives considered:**

- *App-side `crypto.randomUUID()`*: Works, but introduces a subtle concurrency risk if two app processes generate the same UUID (cryptographically unlikely but philosophically messy).

### Decision 7: `updatedAt` maintained in the app, not via trigger

Triggers are invisible, easy to forget during migrations, and make local testing of the repository layer harder (you have to touch the DB to observe the trigger's effect). Setting `updatedAt = now()` inside the repository's update method is explicit, testable, and one line.

**Alternatives considered:**

- *Postgres trigger `BEFORE UPDATE` that sets `updated_at = now()`*: Works, but opaque.

### Decision 8: Error taxonomy lives in `src/lib/errors.ts`, mapped by the error handler

Each domain error class extends a base `AppError` carrying `status`, `code`, and `message`. The error-handling middleware from Change 1 already funnels errors through one function; this change teaches it to recognize `AppError` and translate it. All other errors stay `500 Internal Server Error`.

## Risks / Trade-offs

- **[Risk: Keyset cursor becomes invalid if a client sorts by `name` then switches to `-createdAt`]** → Mitigation: The cursor encodes the sort key used to generate it. If the sort changes, the server rejects the cursor with a `VALIDATION` error and forces the client to start over. This is documented in the spec scenario "Invalid cursor."
- **[Risk: Tag AND semantics (`?tag=x&tag=y`) is unusual — many APIs use OR]** → Mitigation: AND matches the expectation that filters are intersections. Documented explicitly in the spec.
- **[Risk: Dropping `q` means the list endpoint has no "find by name" affordance]** → Mitigation: Explicit decision by the user. If needed later, a `pg_trgm` index can be added without changing the endpoint shape.
- **[Risk: `metadata jsonb` has no schema, so clients can send anything up to 16 KB]** → Mitigation: Enforce the 16 KB limit at validation time, reject anything larger with `VALIDATION`. The 16 KB cap protects the index and network but keeps the field useful.
- **[Risk: At 10k RPS, even `SELECT ... WHERE id = $1` can saturate a single Postgres connection pool]** → Mitigation: This change documents the risk and sets `max_connections` accordingly in the compose config, but the real fix (pgbouncer or the Redis cache) lands in Change 3. Change 2 is not expected to hit 10k RPS alone; Change 2 + Change 3 together are.
- **[Risk: Migration tooling (`kysely-ctl`) is less battle-tested than `node-pg-migrate`]** → Mitigation: We write migrations in TypeScript (which both support), keep the migration logic trivial (one CREATE TABLE, five CREATE INDEX, one function for `gen_random_uuid` extension), and treat the migration tool as replaceable if it misbehaves.

## Migration Plan

1. **Startup order**: `pnpm db:migrate` runs before `pnpm start` in local dev. In docker-compose, the api container's entrypoint script runs `node dist/db/migrate.js up` before `node dist/index.js`.
2. **Idempotency**: Kysely migrations record applied migrations in a `kysely_migrations` table; re-running is a no-op.
3. **Rollback**: Each migration file exports both `up` and `down`. The initial migration's `down` drops the `resources` table. (We will not actually execute `down` in practice, but writing it keeps the discipline.)
4. **Existing data**: None (greenfield).

## Open Questions

- **Should we cap `tags.length` at 32 or higher?** Defaulting to 32 for the spec. Easy to relax later.
- **Should PATCH be idempotent-ish (same body, same result) or truly idempotent (no-op if unchanged)?** Going with idempotent-ish: `updatedAt` always bumps on a PATCH even if no field changed. Rationale: bumping `updatedAt` makes cache invalidation in Change 3 simpler.
