## 1. Database Schema and Migration Tooling

- [ ] 1.1 Add runtime dependencies `kysely` and `pg`, dev dependency `kysely-ctl`, and regenerate the lockfile
- [ ] 1.2 Create `kysely.config.ts` pointing at `migrations/` and reading `DATABASE_URL` from env
- [ ] 1.3 Create `src/db/schema.ts` exporting the Kysely `Database` type with a `resources` table interface
- [ ] 1.4 Create `migrations/0001_create_resources.ts` with `up` that creates the `pgcrypto` extension (for `gen_random_uuid`), the `resources` table, and the five indexes, and `down` that drops everything in reverse order
- [ ] 1.5 Add `pnpm db:migrate`, `pnpm db:migrate:down`, and `pnpm db:reset` scripts
- [ ] 1.6 Verify `pnpm db:migrate` runs successfully against the compose Postgres and creates the expected indexes (`\d+ resources` inside `psql`)

## 2. Database Client and Health Check

- [ ] 2.1 Create `src/db/client.ts` exporting a `createDb(config)` factory that builds a `pg.Pool` with `max` derived from an env var, wraps it in a Kysely instance, and returns both
- [ ] 2.2 Create `src/db/health.ts` exporting a `dbHealthCheck(db)` function that runs `SELECT 1` with a 1-second timeout and returns `{status: "up"|"down", error?: string}`
- [ ] 2.3 Modify `src/index.ts` to construct the Kysely client, register `db` with the `HealthCheckRegistry`, and push `pool.end()` onto the shutdown hook list
- [ ] 2.4 Verify `curl /healthz` includes `checks.db: {status: "up"}` when Postgres is running and `checks.db: {status: "down"}` when Postgres is stopped

## 3. Domain Module — Resources

- [ ] 3.1 Create `src/lib/errors.ts` with `AppError` base class and `ValidationError`, `NotFoundError`, `ConflictError` subclasses carrying `status` and `code`
- [ ] 3.2 Modify `src/middleware/error-handler.ts` to recognize `AppError` and translate it to the spec's error response shape
- [ ] 3.3 Create `src/modules/resources/schema.ts` with Zod schemas for `CreateResourceInput`, `UpdateResourceInput`, `ListResourcesQuery`, and `Resource` response, exporting inferred TypeScript types
- [ ] 3.4 Create `src/modules/resources/repository.ts` with a `ResourceRepository` interface and a Kysely-backed implementation: `create`, `findById`, `list (filters, cursor, limit, sort)`, `update`, `delete`
- [ ] 3.5 Implement keyset cursor encoding/decoding in `src/modules/resources/cursor.ts` (base64 JSON of `{createdAt, id, sort}`) with validation that the sort in the cursor matches the request sort
- [ ] 3.6 Create `src/modules/resources/service.ts` with a `ResourceService` that accepts a `ResourceRepository`, enforces business rules, and throws typed errors
- [ ] 3.7 Create `src/modules/resources/controller.ts` with pure Express handlers that parse inputs via Zod, call the service, and return responses
- [ ] 3.8 Create `src/modules/resources/router.ts` assembling `POST /`, `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` and mounting them at `/resources`
- [ ] 3.9 Modify `src/http/app.ts` to mount the resources router

## 4. List Query Implementation

- [ ] 4.1 In the repository `list` method, build filter WHERE clauses dynamically: `type`, `status IN (...)`, `tags @> ARRAY[...]`, `owner_id`, `created_at >= $`, `created_at < $`
- [ ] 4.2 Apply the keyset cursor predicate as a tuple comparison matching the current sort order
- [ ] 4.3 Apply sort and `LIMIT limit + 1` so we can detect whether another page exists; slice the extra row and use it to compute `nextCursor`
- [ ] 4.4 Verify with manual `curl` tests that filters compose correctly (type + status + tag + cursor all together)

## 5. Validation and Error Handling

- [ ] 5.1 Verify all Zod schemas reject unknown fields (`.strict()`) and enforce length limits from the spec
- [ ] 5.2 Verify the error handler produces `{error: {code, message, requestId, details?}}` for every error class
- [ ] 5.3 Add a defensive JSON body size limit (e.g. `express.json({limit: "64kb"})`) that rejects oversized payloads with `VALIDATION`

## 6. Docker Compose Updates

- [ ] 6.1 Ensure `DATABASE_URL` in `.env.example` and `docker-compose.yml` points at the compose Postgres via its service name
- [ ] 6.2 Ensure the api container runs `db:migrate` on startup before launching the server (entrypoint script)
- [ ] 6.3 Verify `docker compose down -v && docker compose up` brings up a fresh stack where migrations apply and `/healthz` shows `db: up`

## 7. README and Documentation

- [ ] 7.1 Update `README.md` with a "First request" section showing a `curl -X POST /resources` example and a sample response
- [ ] 7.2 Document the filter query parameters and the keyset cursor contract in README

## 8. Validation

- [ ] 8.1 Run `pnpm check` and confirm lint + typecheck pass
- [ ] 8.2 Run manual end-to-end tests against a fresh `docker compose up`: create → list → get → update → delete → get (404)
- [ ] 8.3 Run `EXPLAIN ANALYZE` on a list query with `type`, `status`, `tag`, and `cursor` filters and confirm the planner uses the expected indexes
- [ ] 8.4 Run `openspec validate s02-add-resources-crud` and confirm zero errors
