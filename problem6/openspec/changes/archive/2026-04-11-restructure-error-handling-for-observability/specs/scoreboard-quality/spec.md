## ADDED Requirements

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
