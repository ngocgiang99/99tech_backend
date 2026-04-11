# scoreboard-quality

## Purpose

Build-time and test-time quality gates for the scoreboard module. Owns the ESLint boundary configuration (hexagonal layer enforcement), Jest unit and integration configs (with coverage thresholds), the Testcontainers-backed integration test suite, and the operational runbook collection under `docs/runbooks/`.

## Requirements

### Requirement: ESLint enforces hexagonal layer boundaries

The ESLint configuration SHALL include `eslint-plugin-boundaries` with element types matching `README.md §11.2`: `domain`, `application`, `infrastructure`, `interface`, `shared`. The plugin's boundary rule SHALL fire `error` (not warn) on any import that violates the dependency graph: domain depends on nothing, application depends only on domain, infrastructure depends on application + domain, interface depends on application, shared is universal.

#### Scenario: Domain importing from @nestjs fails lint
- **GIVEN** a file at `src/scoreboard/domain/foo.ts` with `import { Injectable } from '@nestjs/common';`
- **WHEN** `mise run lint` is run
- **THEN** the lint exits non-zero
- **AND** the error message names the offending file and the violated boundary rule

#### Scenario: Application importing from infrastructure fails lint
- **GIVEN** a file at `src/scoreboard/application/commands/foo.ts` with `import { KyselyUserScoreRepository } from '../../infrastructure/persistence/kysely/...';`
- **WHEN** `mise run lint` is run
- **THEN** the lint exits non-zero with a boundary violation
- **AND** the dev is told to depend on the port (`UserScoreRepository` from `domain/ports/`) instead

#### Scenario: Infrastructure importing from interface fails lint
- **GIVEN** an infrastructure file importing from `src/scoreboard/interface/`
- **WHEN** lint runs
- **THEN** the boundary check fires (interface should depend on infrastructure, not the reverse)

#### Scenario: Current Epic 1 codebase passes lint
- **WHEN** `mise run lint` is run on the in-tree code
- **THEN** zero warnings, zero errors
- **AND** the CI pipeline fails any future PR that introduces a violation

### Requirement: Jest coverage threshold enforced at ≥80% global, 100% for domain

`mise run test:coverage` SHALL run Jest with a global `coverageThreshold` of 80% (lines, branches, functions, statements). Additionally, the domain layer (`src/scoreboard/domain/**/*.ts`) SHALL have a per-directory threshold of 100% (lines, branches, functions, statements). The build SHALL fail if either threshold is unmet.

#### Scenario: Coverage above threshold passes
- **GIVEN** unit tests covering ≥80% of `src/` (domain at 100%)
- **WHEN** `mise run test:coverage` is run
- **THEN** Jest reports coverage and exits 0

#### Scenario: Coverage drops below threshold fails the build
- **GIVEN** a deliberate change that drops coverage to 75%
- **WHEN** `mise run test:coverage` is run in CI
- **THEN** Jest exits non-zero
- **AND** the failure message names the offending threshold (e.g. "lines: 75% < 80%")

#### Scenario: Domain coverage below 100% fails the build
- **GIVEN** a domain change with one uncovered branch
- **WHEN** `mise run test:coverage` is run
- **THEN** the per-directory threshold for `src/scoreboard/domain/**/*.ts` fails
- **AND** the failure message names the directory and the missing percentage

### Requirement: Testcontainers integration suite for persistence and rate-limit adapters

The system SHALL provide an integration test suite under `test/integration/` that uses `@testcontainers/postgresql` and `@testcontainers/redis` to verify infrastructure adapters against real services. The suite is run via `mise run test:integration`. Test isolation is per-suite (each test file gets a fresh container).

#### Scenario: KyselyUserScoreRepository round-trip works against real Postgres
- **GIVEN** a Testcontainers Postgres started by the suite
- **WHEN** the repository's `credit()` method is called
- **THEN** the row is persisted in `score_events`
- **AND** `findByUserId()` returns the rehydrated aggregate

#### Scenario: Duplicate action_id surfaces as IdempotencyViolationError against real Postgres
- **GIVEN** the repository against a real Postgres
- **WHEN** `credit()` is called twice with the same `actionId`
- **THEN** the second call throws `IdempotencyViolationError`
- **AND** the unique constraint violation is caught and translated by the repository

#### Scenario: Redis idempotency store SETNX behaves correctly
- **GIVEN** a Testcontainers Redis
- **WHEN** `SET NX EX` is called twice with the same key
- **THEN** the first call returns OK, the second returns null (loss)
- **AND** after the TTL elapses, a third call returns OK again

#### Scenario: RedisTokenBucket admits and rejects per the algorithm
- **GIVEN** a Testcontainers Redis with the Lua script loaded
- **WHEN** `bucket.consume(userId)` is called beyond the bucket capacity
- **THEN** early calls return `{allowed: true}`
- **AND** calls beyond capacity return `{allowed: false, retryAfterMs: <positive>}`
- **AND** after `SCRIPT FLUSH` followed by another consume call, the bucket recovers via EVAL fallback (NOSCRIPT recovery)

### Requirement: Operational runbooks live under docs/runbooks/

Operational runbooks (operator-facing prose for incident response and routine procedures) SHALL live under `problem6/docs/runbooks/` as Markdown files. Each runbook SHALL have a numbered procedure, prerequisites, and a "Verification" step.

#### Scenario: action-token-rotation.md exists with the documented procedure
- **WHEN** `problem6/docs/runbooks/action-token-rotation.md` is opened
- **THEN** the file documents a 4-step procedure: (1) deploy with both `ACTION_TOKEN_SECRET` and `ACTION_TOKEN_SECRET_PREV` set, (2) deploy with primary rotated to a new secret while keeping old as prev, (3) wait for the 5-minute rollover window to close, (4) deploy with prev removed
- **AND** the runbook has a "Verification" section explaining how to test the dual-secret behavior with curl
- **AND** the rollover window length is explicitly 5 minutes (= `ACTION_TOKEN_TTL_SECONDS`)

#### Scenario: Runbook references GAP-05 explicitly
- **WHEN** `action-token-rotation.md` is opened
- **THEN** it contains a reference to `architecture.md` `openGaps` GAP-05
- **AND** indicates that this runbook resolves the gap

### Requirement: JwtGuard unit tests cover HS256 verification

The unit test suite SHALL include `test/unit/auth/jwt.guard.test.ts` covering: valid HS256 token sets userId, expired token rejected, missing Authorization header rejected, alg=none rejected, alg=RS256 rejected (algorithm allowlist), tampered signature rejected, wrong-secret rejected, iss/aud claims ignored. Tests sign tokens directly with `jose.SignJWT(...).sign(new TextEncoder().encode(secret))` — no JWKS HTTP server, no RSA keypair generation. The previous `test/unit/auth/jwks-cache.test.ts` is removed because the `JwksCache` adapter no longer exists.

#### Scenario: Test file exists with the documented coverage
- **WHEN** `test/unit/auth/jwt.guard.test.ts` is read
- **THEN** the file contains test cases for each of the 8 scenarios listed above
- **AND** every test signs its JWT inline with `jose.SignJWT` and an HS256 secret
- **AND** no test imports or references `JwksCache` (which has been deleted)

#### Scenario: Tests run as part of the unit test suite
- **WHEN** `mise run test` is run
- **THEN** `jwt.guard.test.ts` is executed
- **AND** all 8 test cases pass
- **AND** the file's line coverage is 100%

### Requirement: Error subsystem primitives have exhaustive unit test coverage

The `scoreboard-errors` capability (living at `src/scoreboard/shared/errors/`) SHALL have dedicated unit tests covering every primitive: the `DomainError` hierarchy, `scrubHeaders`, `buildErrorMetadata`, `mapDbError`, `toPublicResponse`, and `wrapUnknown`. Each primitive SHALL achieve 100% line and branch coverage, enforced by the existing `scoreboard-quality` coverage thresholds applied to `src/scoreboard/shared/errors/**/*.ts` as a per-directory rule. Tests SHALL live under `test/unit/shared/errors/` and mirror the file layout of the source.

#### Scenario: Every DomainError subclass has a construction test
- **WHEN** `test/unit/shared/errors/domain-error.test.ts` is run
- **THEN** each of the ten subclasses has at least one `it(...)` verifying: (a) `err.code` equals the expected string, (b) `err.getStatus()` equals the expected HTTP status, (c) `err.message` defaults to the `ERROR_CODE_META` default when no argument is passed, (d) `err instanceof HttpException` is true, (e) `err instanceof DomainError` is true

#### Scenario: Header scrubber covers every default denylist entry
- **WHEN** `test/unit/shared/errors/scrub-headers.test.ts` is run
- **THEN** there is at least one test per default denylist entry (authorization, cookie, set-cookie, x-api-key, action-token)
- **AND** at least one test for case-insensitive matching
- **AND** at least one test for the `extraDenylist` parameter

#### Scenario: mapDbError covers every mapped SQLSTATE code
- **WHEN** `test/unit/shared/errors/map-db-error.test.ts` is run
- **THEN** there is at least one test per handled SQLSTATE code: `23505`, `23502`, `23503`, `22001`, `40P01`, `57014`, `53300`
- **AND** at least one test for an unknown pg code falling through to `InternalError`
- **AND** at least one test for a non-pg value falling through to `InternalError`
- **AND** at least one test verifying `pgCode` is non-enumerable (not visible to `JSON.stringify`)

#### Scenario: toPublicResponse enforces the InternalError leak guarantee
- **WHEN** `test/unit/shared/errors/to-public-response.test.ts` is run
- **THEN** there is at least one test proving that `toPublicResponse(new InternalError('secret data'), ...)` returns a body whose `error.message` equals the generic default, NOT `'secret data'`
- **AND** at least one test proving that the `details` field appears ONLY for `ValidationError`
- **AND** at least one test proving that the `errorId` field appears ONLY when the caller passes a non-null `errorId`
- **AND** at least one test verifying message truncation at 200 bytes with `'...'` suffix

#### Scenario: wrapUnknown handles every branch of the priority chain
- **WHEN** `test/unit/shared/errors/wrap-unknown.test.ts` is run
- **THEN** there is a test for each of the seven branches: (1) `DomainError` pass-through, (2) `HttpException` conversion by status, (3) `ZodError` wrapping, (4) pg-shaped error via `mapDbError`, (5) Redis infrastructure error via pattern match, (6) generic `Error` wrapping, (7) non-`Error` value wrapping

### Requirement: HttpExceptionFilter has integration test coverage for end-to-end orchestration

`test/unit/interface/http/error-filter.test.ts` SHALL exercise the full filter pipeline for at least one error in each of the ten `DomainError` subclasses plus the Redis fail-CLOSED path. Each test SHALL assert: (a) the HTTP response status, (b) the response body shape, (c) the log entry was emitted at the correct level, (d) the `scoreboard_errors_total` counter was incremented with the correct labels. The filter SHALL be tested in isolation with mocks for the logger and the counter — no real Redis, no real Postgres, no real HTTP stack.

#### Scenario: Filter emits the correct log level by status
- **GIVEN** a `ValidationError` (400) and a `InternalError` (500)
- **WHEN** each is processed by the filter
- **THEN** the `ValidationError` log entry is at level `warn`
- **AND** the `InternalError` log entry is at level `error`

#### Scenario: Filter increments the errors counter with the correct labels
- **GIVEN** a mock `errorsTotal` counter
- **WHEN** a `ConflictError` is processed by the filter
- **THEN** `counter.inc` is called exactly once with `{ code: 'CONFLICT', status: '409' }`

#### Scenario: Filter is idempotent when reply.raw.headersSent is true
- **GIVEN** a Fastify reply whose `raw.headersSent` is already true
- **WHEN** the filter runs
- **THEN** no log entry is emitted
- **AND** no counter is incremented
- **AND** no response is sent
