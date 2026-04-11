# testing-framework

## Purpose

Defines how the project organizes automated tests, how integration tests
get their datastores, what coverage gate exists, and what output formats
the runner supports. The goal is to keep the unit layer fast enough to
bind to save/commit while the integration layer exercises real Postgres
and Redis end-to-end through the full Express stack. Benchmarks are owned
by a separate capability and are deliberately out of scope here.

## Requirements

### Requirement: Two-Layer Test Structure

The project SHALL separate tests into a fast unit layer and a slow-but-realistic integration layer, each with its own Vitest configuration, its own `pnpm` script, and its own directory.

#### Scenario: Developer runs only the unit layer

- **WHEN** a developer runs `pnpm test:unit`
- **THEN** only files under `tests/unit/**/*.test.ts` execute
- **AND** no Docker containers are started
- **AND** the run completes in under 5 seconds on laptop hardware

#### Scenario: Developer runs only the integration layer

- **WHEN** a developer runs `pnpm test:integration`
- **THEN** only files under `tests/integration/**/*.test.ts` execute
- **AND** the run spins up Postgres and Redis containers via Testcontainers
- **AND** the run completes in under 2 minutes on laptop hardware

#### Scenario: Developer runs both layers

- **WHEN** a developer runs `pnpm test`
- **THEN** the unit layer runs first, then the integration layer
- **AND** a failure in either layer causes a non-zero exit code
- **AND** a summary distinguishes unit from integration counts

### Requirement: Unit Test Scope

The unit test layer SHALL cover pure logic that can be exercised without touching a database, a cache, or the network: Zod schema validation, keyset cursor encoding/decoding, cache-key derivation, singleflight behavior, and error-class-to-HTTP-status mapping.

#### Scenario: Zod schema validation unit test

- **WHEN** the unit layer runs
- **THEN** tests assert that the create schema rejects unknown fields
- **AND** tests assert that the list query schema rejects `limit > 100`
- **AND** tests assert that the update schema rejects `id`, `createdAt`, `updatedAt`

#### Scenario: Cursor encoding round-trip

- **WHEN** the unit layer runs
- **THEN** tests assert that `decode(encode(x)) === x` for a range of cursor inputs
- **AND** tests assert that `decode("garbage")` throws a `ValidationError`
- **AND** tests assert that a cursor encoded for sort `-createdAt` is rejected when the request sort is `name`

#### Scenario: Cache key derivation determinism

- **WHEN** the unit layer runs
- **THEN** tests assert that `listKey({type: "a", status: "b"}, 1)` and `listKey({status: "b", type: "a"}, 1)` produce the same key
- **AND** tests assert that `listKey(filters, 1)` and `listKey(filters, 2)` produce different keys
- **AND** tests assert that the key length is bounded regardless of filter count

#### Scenario: Singleflight coalesces concurrent calls

- **WHEN** the unit layer runs
- **THEN** tests assert that N concurrent `singleflight.do(k, fn)` calls result in exactly one `fn` invocation
- **AND** tests assert that the promise is cleared on both resolve and reject
- **AND** tests assert that a rejection propagates to all waiters

### Requirement: Integration Tests Use Real Containers via Testcontainers

The integration test layer SHALL start real Postgres and Redis containers using Testcontainers, run migrations, execute tests against the full Express app via HTTP, and tear containers down after each suite. Database state SHALL be isolated between tests.

#### Scenario: Suite bootstrap

- **WHEN** an integration test suite begins
- **THEN** Testcontainers starts a `postgres:16-alpine` container and a `redis:7-alpine` container
- **AND** migrations run against the Postgres container
- **AND** an Express app is constructed with real clients pointed at the containers
- **AND** the suite's HTTP client (`supertest`) is ready to accept requests

#### Scenario: Database isolation between tests

- **WHEN** a test creates a resource
- **THEN** that resource is not visible to other tests in the same suite
- **AND** test state is reset between tests (either via `TRUNCATE` or per-test schemas)

#### Scenario: Suite teardown

- **WHEN** an integration test suite ends
- **THEN** both containers are stopped and removed
- **AND** no processes, ports, or volumes are left behind

#### Scenario: Docker daemon is not running

- **WHEN** a developer runs `pnpm test:integration` without a Docker daemon
- **THEN** Testcontainers reports a clear error
- **AND** the suite fails fast
- **AND** the README documents the prerequisite

### Requirement: End-to-End HTTP Coverage

The integration layer SHALL exercise every HTTP endpoint defined by `resources-management` via real HTTP calls (not by calling controllers directly), asserting response status, headers, and body against the spec scenarios.

#### Scenario: Create → Get → Update → Delete happy path

- **WHEN** an integration test runs the create/get/update/delete sequence
- **THEN** each step asserts the corresponding spec scenario's outcome
- **AND** the test covers both success and error branches

#### Scenario: List with filters

- **WHEN** an integration test seeds ten resources and runs list queries with varying filter combinations
- **THEN** tests assert that each filter (type, status, tag AND, ownerId, createdAfter/Before, sort, limit, cursor) behaves as the spec describes
- **AND** tests assert keyset pagination across multiple pages

#### Scenario: Cache behavior under writes

- **WHEN** an integration test issues a `GET /resources/{id}` twice, then `PATCH`es the resource, then `GET`s again
- **THEN** the first GET returns `X-Cache: MISS`
- **AND** the second GET returns `X-Cache: HIT`
- **AND** the post-patch GET returns `X-Cache: MISS` (invalidation worked)
- **AND** the response body reflects the update

#### Scenario: List cache invalidation on create

- **WHEN** an integration test GETs a list, creates a new resource, then GETs the list again
- **THEN** the second list response includes the new resource
- **AND** `X-Cache: MISS` on the second list GET (because the version counter bumped)

### Requirement: Coverage Gate

The test runner SHALL enforce a line-coverage threshold of at least 80% on the pure-logic modules included in the unit layer's coverage scope when `pnpm test:coverage` is run, and SHALL fail the build if the threshold is not met. Wiring, repositories, routers, and HTTP handlers are exercised by the integration layer and are deliberately excluded from the coverage include-list.

#### Scenario: Coverage meets the threshold

- **WHEN** a developer runs `pnpm test:coverage`
- **THEN** the runner prints a coverage table
- **AND** the process exits with code `0`
- **AND** an HTML report is written to `coverage/`

#### Scenario: Coverage falls below the threshold

- **WHEN** a developer runs `pnpm test:coverage` after removing a test file
- **THEN** the runner prints which files fell below the threshold
- **AND** the process exits with a non-zero code

### Requirement: Test Output Formats

The test runner SHALL support both a human-readable reporter for local runs (default) and a machine-readable reporter suitable for CI consumption.

#### Scenario: Local developer run

- **WHEN** a developer runs `pnpm test`
- **THEN** output is the default verbose reporter with colored pass/fail

#### Scenario: CI run

- **WHEN** `pnpm test --reporter=junit` is invoked
- **THEN** JUnit XML is written to stdout or a file
- **AND** test counts, durations, and failure messages are present in the XML
