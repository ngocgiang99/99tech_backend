## 1. Install Dev Dependencies

- [ ] 1.1 Add dev dependencies: `vitest`, `@vitest/coverage-v8`, `supertest`, `@types/supertest`, `testcontainers`, `@testcontainers/postgresql`, `@testcontainers/redis`
- [ ] 1.2 Regenerate `pnpm-lock.yaml` and verify `pnpm install` completes cleanly

## 2. Vitest Configuration

- [ ] 2.1 Create `vitest.config.ts` for the unit layer with `test.include = ['tests/unit/**/*.test.ts']`, `test.environment = 'node'`, and `test.coverage` settings (provider `v8`, include `src/**/*.ts`, exclude `src/**/*.d.ts`, thresholds.lines `80`)
- [ ] 2.2 Create `vitest.config.integration.ts` for the integration layer with `test.include = ['tests/integration/**/*.test.ts']`, longer `testTimeout` and `hookTimeout`, and `test.globalSetup = ['tests/integration/fixtures/containers.ts']`
- [ ] 2.3 Add `pnpm test`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:watch`, `pnpm test:coverage` scripts to `package.json`
- [ ] 2.4 Verify `pnpm test:unit` runs successfully on an empty test tree

## 3. Refactor `src/index.ts` for Testability (if not already done in Change 2)

- [ ] 3.1 Split `src/index.ts` into `src/app.ts` (pure `createApp(deps)` factory that returns an Express instance, accepts a `Deps` object with `db`, `redis`, `config`, `logger`) and `src/index.ts` (entry point that constructs real deps, calls `createApp`, starts listening, registers shutdown)
- [ ] 3.2 Ensure all modules (Postgres repository, Redis cache, service, router) are constructed inside `createApp` from the injected `Deps` — no module-level side effects
- [ ] 3.3 Verify `pnpm check` still passes and `docker compose up` still boots the service

## 4. Unit Test Harness

- [ ] 4.1 Create `tests/helpers/factory.ts` exporting `buildCreateResourceInput(overrides)` and `buildResource(overrides)` factory functions
- [ ] 4.2 Create `tests/unit/modules/resources/schema.test.ts` covering the Zod schemas from Change 2 (create rejects unknown, update rejects server-controlled fields, list rejects `limit > 100`)
- [ ] 4.3 Create `tests/unit/modules/resources/cursor.test.ts` covering encode/decode round-trip, sort-mismatch rejection, and garbage-input rejection
- [ ] 4.4 Create `tests/unit/modules/resources/cache-keys.test.ts` covering key determinism (filter reordering, version increment, length bound)
- [ ] 4.5 Create `tests/unit/cache/singleflight.test.ts` covering concurrent coalescing, reject propagation, and map cleanup
- [ ] 4.6 Create `tests/unit/lib/errors.test.ts` covering `AppError` subclasses and the error-handler's HTTP translation
- [ ] 4.7 Verify `pnpm test:unit` completes in under 5 seconds

## 5. Integration Test Harness

- [ ] 5.1 Create `tests/integration/fixtures/containers.ts` as a Vitest global setup that starts Postgres and Redis containers, runs migrations against the Postgres container, exposes their connection strings via environment variables (`DATABASE_URL`, `REDIS_URL`), and tears them down on global teardown
- [ ] 5.2 Create `tests/integration/fixtures/app.ts` exporting a `createTestApp()` function that reads the test env vars, constructs deps, calls `createApp(deps)`, and returns the Express instance wrapped in a `supertest` agent
- [ ] 5.3 Create `tests/integration/fixtures/db.ts` exporting `resetDatabase()` (TRUNCATE) and `flushCache()` (FLUSHDB) helpers used in `afterEach` hooks
- [ ] 5.4 Verify Testcontainers can pull `postgres:16-alpine` and `redis:7-alpine` and start them on the developer's machine (document the prerequisite in README)

## 6. Integration Tests — Happy Paths

- [ ] 6.1 Create `tests/integration/resources/crud.test.ts` covering:
  - POST creates and returns 201 with Location header
  - GET /:id on the newly created id returns 200 and the correct body
  - PATCH partial updates a single field, bumps updatedAt
  - DELETE returns 204
  - GET /:id after DELETE returns 404
- [ ] 6.2 Create `tests/integration/resources/list.test.ts` covering:
  - Unfiltered list returns newest first
  - Filter by type, status (OR), tag (AND), ownerId, createdAfter/Before
  - Keyset pagination across multiple pages (no duplicates, final page has nextCursor = null)
  - Invalid cursor rejected
  - Invalid limit rejected

## 7. Integration Tests — Error and Edge Cases

- [ ] 7.1 Create `tests/integration/resources/errors.test.ts` covering:
  - Create with unknown field → 400 VALIDATION
  - Create with invalid JSON → 400 VALIDATION
  - Get with non-UUID id → 400 VALIDATION
  - Patch with `id`/`createdAt` in body → 400 VALIDATION
  - Patch on non-existent id → 404 NOT_FOUND
  - Delete on non-existent id → 404 NOT_FOUND
- [ ] 7.2 Create `tests/integration/resources/cache.test.ts` covering:
  - First GET /:id → X-Cache: MISS
  - Second GET /:id → X-Cache: HIT
  - PATCH then GET → X-Cache: MISS (invalidation)
  - CACHE_ENABLED=false → X-Cache: BYPASS on every GET
  - Create → list GET → X-Cache: MISS (list version bumped)

## 8. Health Endpoint Integration Tests

- [ ] 8.1 Create `tests/integration/health.test.ts` covering:
  - GET /healthz returns 200 when both db and cache are up
  - GET /healthz?probe=liveness returns 200 regardless of downstream state
  - (Harder) simulate Postgres down by stopping the container mid-test → assert 503; requires care around Testcontainers lifecycle — if flaky, skip this scenario and cover it at the unit level by mocking the health registry

## 9. Coverage and CI Hooks

- [ ] 9.1 Run `pnpm test:coverage` and record the baseline coverage numbers in the task checklist
- [ ] 9.2 Adjust `vitest.config.ts` exclusions to keep the 80% threshold realistic (exclude `src/index.ts` entry point if necessary)
- [ ] 9.3 Verify the coverage HTML report is written to `coverage/` and is human-readable

## 10. Documentation

- [ ] 10.1 Update `README.md` with a "Running tests" section: `pnpm test` (both), `pnpm test:unit` (fast), `pnpm test:integration` (Docker required), `pnpm test:coverage` (with gate)
- [ ] 10.2 Document the Docker daemon prerequisite for integration tests
- [ ] 10.3 Document how to debug a failing integration test (`pnpm test:integration --reporter=verbose`, inspect the Testcontainers logs)

## 11. Validation

- [ ] 11.1 Run `pnpm test` end-to-end and confirm both layers pass
- [ ] 11.2 Run `pnpm test:coverage` and confirm the 80% threshold is met
- [ ] 11.3 Run `openspec validate s04-add-test-suite` and confirm zero errors
