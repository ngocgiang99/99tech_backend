## ADDED Requirements

### Requirement: Typed DomainError hierarchy exists under src/scoreboard/shared/errors

The system SHALL expose a `DomainError` abstract base class under `src/scoreboard/shared/errors/domain-error.ts` that extends NestJS's `HttpException`. The base class SHALL carry a stable machine-readable `code: ErrorCode` property, an optional structured `details: unknown` property, and an optional `cause: unknown` property. The system SHALL provide exactly ten concrete subclasses: `ValidationError`, `BadRequestError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`, `RateLimitError`, `DependencyUnavailableError`, `InternalError`. Each subclass SHALL map 1:1 with an `ErrorCode` tuple member and set the HTTP status from a single `ERROR_CODE_META` table.

#### Scenario: Each subclass sets the correct code, status, and default message
- **GIVEN** the ten concrete `DomainError` subclasses
- **WHEN** each is constructed with no arguments
- **THEN** `err.code` equals the corresponding `ErrorCode` string (e.g. `ValidationError → 'VALIDATION'`)
- **AND** `err.getStatus()` equals the status from `ERROR_CODE_META[err.code].status`
- **AND** `err.message` equals `ERROR_CODE_META[err.code].defaultMessage`

#### Scenario: DomainError extends HttpException so NestJS guards can throw it
- **GIVEN** a NestJS guard that throws `new ForbiddenError('token expired')`
- **WHEN** the guard runs inside a `@UseGuards` chain
- **THEN** the thrown value `instanceof HttpException` is true
- **AND** the thrown value `instanceof DomainError` is true
- **AND** the thrown value `instanceof ForbiddenError` is true
- **AND** `request.handler` is never reached (guard short-circuits the request)

#### Scenario: ValidationError carries a structured details payload
- **GIVEN** `new ValidationError('delta out of range', { field: 'delta', max: 100 })`
- **WHEN** the error is inspected
- **THEN** `err.code` is `'VALIDATION'`
- **AND** `err.getStatus()` is `400`
- **AND** `err.details` is `{ field: 'delta', max: 100 }`

#### Scenario: Cause chain is preserved when an error wraps another
- **GIVEN** `const inner = new Error('socket closed')`
- **AND** `new DependencyUnavailableError('redis read failed', { cause: inner })`
- **WHEN** the error's cause chain is walked
- **THEN** `err.cause` is `inner`
- **AND** `err.cause.message` is `'socket closed'`

### Requirement: ERROR_CODE_META is the single source of truth for code-to-status mapping

The `error-codes.ts` module SHALL export a readonly `ERROR_CODES` tuple containing every valid code string, a derived `ErrorCode` type (via `typeof ERROR_CODES[number]`), and an `ERROR_CODE_META: Record<ErrorCode, { status, defaultMessage }>` table. Every subclass in the `DomainError` hierarchy SHALL derive its status from this table; no subclass SHALL hard-code a status in its constructor.

#### Scenario: The ten codes are exactly the supported set
- **WHEN** `ERROR_CODES` is inspected
- **THEN** it contains exactly these ten strings in this order: `VALIDATION`, `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE_ENTITY`, `RATE_LIMIT`, `TEMPORARILY_UNAVAILABLE`, `INTERNAL_ERROR`

#### Scenario: Each code has a canonical HTTP status
- **WHEN** `ERROR_CODE_META` is read
- **THEN** the status for each code is: `VALIDATION→400`, `BAD_REQUEST→400`, `UNAUTHENTICATED→401`, `FORBIDDEN→403`, `NOT_FOUND→404`, `CONFLICT→409`, `UNPROCESSABLE_ENTITY→422`, `RATE_LIMIT→429`, `TEMPORARILY_UNAVAILABLE→503`, `INTERNAL_ERROR→500`

#### Scenario: Adding a new code breaks the TypeScript build until all subclasses are updated
- **GIVEN** a developer adds a new entry `'NEW_CODE'` to the `ERROR_CODES` tuple
- **WHEN** `tsc` runs
- **THEN** the build fails with a missing-key error on `ERROR_CODE_META` until the new entry is added to the table
- **AND** the exhaustiveness check prevents shipping an unmapped code

### Requirement: wrapUnknown coerces any thrown value to a DomainError

The `wrap-unknown.ts` module SHALL export a `wrapUnknown(exception: unknown): DomainError` function that converts any thrown value into a typed `DomainError`. The function SHALL apply the following priority chain: (1) if already a `DomainError`, return as-is; (2) if a `ZodError`, wrap in `ValidationError` with the issues as details; (3) if a pg-shaped error, delegate to `mapDbError()`; (4) if an `Error` whose shape matches the Redis infrastructure error patterns, wrap in `DependencyUnavailableError` with the original as cause; (5) if any other NestJS `HttpException`, convert to the matching `DomainError` subclass by status code; (6) if any other `Error`, wrap in `InternalError` with the original as cause; (7) any other thrown value, wrap in `InternalError` with the stringified value as cause.

#### Scenario: DomainError pass-through
- **GIVEN** `const err = new ValidationError('bad')`
- **WHEN** `wrapUnknown(err)` runs
- **THEN** the return value is `err` (same reference)

#### Scenario: ZodError is wrapped in ValidationError with issues as details
- **GIVEN** a `ZodError` with two issues
- **WHEN** `wrapUnknown(zodErr)` runs
- **THEN** the return value is a `ValidationError`
- **AND** `err.details` contains the two issues
- **AND** `err.message` is a human-readable summary of the issues

#### Scenario: Redis infrastructure error becomes DependencyUnavailableError
- **GIVEN** `new Error('Reached the max retries per request. ECONNREFUSED')`
- **WHEN** `wrapUnknown(err)` runs
- **THEN** the return value is a `DependencyUnavailableError`
- **AND** `err.code` is `'TEMPORARILY_UNAVAILABLE'`
- **AND** `err.cause` is the original error (so the log captures the ioredis details)

#### Scenario: NestJS ForbiddenException becomes ForbiddenError
- **GIVEN** `new ForbiddenException('scope mismatch')` from `@nestjs/common`
- **WHEN** `wrapUnknown(err)` runs
- **THEN** the return value is a `ForbiddenError`
- **AND** `err.code` is `'FORBIDDEN'`
- **AND** `err.message` preserves `'scope mismatch'`

#### Scenario: Unknown value (non-Error) becomes InternalError
- **GIVEN** a thrown string `'unexpected'`
- **WHEN** `wrapUnknown('unexpected')` runs
- **THEN** the return value is an `InternalError`
- **AND** `err.cause` is the string `'unexpected'` (preserved as-is)

### Requirement: buildErrorMetadata produces a structured log payload for every error

The `error-metadata.ts` module SHALL export `buildErrorMetadata(err, request, errorId)` returning an `ErrorMetadata` object. The object SHALL contain exactly these fields: `errorId`, `errorClass`, `code`, `status`, `message`, `stack`, `pgCode` (optional), `cause` (CauseEntry array, max depth 5), `requestId`, `method`, `route`, `headers` (scrubbed), `query` (capped at 2048 bytes), `body` (`{size, contentType}` only — NEVER body content), `userAgent`, `remoteAddr`, `timestamp` (ISO-8601). The function SHALL call `scrubHeaders()` on the raw headers before inclusion. The function SHALL never include raw request body content.

#### Scenario: Metadata includes all required fields for a ValidationError
- **GIVEN** a `ValidationError` thrown from a POST /v1/scores:increment request with `content-length: 47`, `content-type: application/json`
- **WHEN** `buildErrorMetadata()` runs
- **THEN** the result contains `errorClass: 'ValidationError'`, `code: 'VALIDATION'`, `status: 400`
- **AND** `method: 'POST'`, `route: '/v1/scores:increment'`
- **AND** `body.size: 47`, `body.contentType: 'application/json'`
- **AND** `headers` does NOT contain the raw `authorization` value
- **AND** `headers.authorization` is `'[redacted]'`
- **AND** `body` does NOT contain the request body content

#### Scenario: Cause chain is walked to depth 5
- **GIVEN** an error chain `E1 → cause: E2 → cause: E3 → cause: E4 → cause: E5 → cause: E6`
- **WHEN** `buildErrorMetadata()` runs
- **THEN** `metadata.cause` has exactly 5 entries (E2 through E6) — NOTE: the top-level error is captured as `errorClass`, cause walking starts from `err.cause`
- **AND** the 6th level is NOT included
- **AND** each entry has exactly `{class, message}` (no stack, no nested cause)

#### Scenario: pgCode is attached non-enumerably and captured in metadata
- **GIVEN** an error whose `pgCode` property is `'23505'` (attached by `mapDbError()`)
- **WHEN** `buildErrorMetadata()` runs
- **THEN** `metadata.pgCode` is `'23505'`
- **AND** `pgCode` is NOT visible in `JSON.stringify(err)` (non-enumerable)

#### Scenario: Query is capped at 2KB with "..." suffix
- **GIVEN** a request with a 5000-byte query string
- **WHEN** `buildErrorMetadata()` runs
- **THEN** `metadata.query.length` is exactly `2048 + 3` (`"..."` suffix)
- **AND** the suffix is exactly `"..."`

#### Scenario: Missing content-length produces null body size
- **GIVEN** a request with no `content-length` header
- **WHEN** `buildErrorMetadata()` runs
- **THEN** `metadata.body.size` is `null`

### Requirement: scrubHeaders redacts sensitive headers via a default denylist

The `scrub-headers.ts` module SHALL export `scrubHeaders(headers, extraDenylist?)` that replaces the values of any header name matching the denylist with the string `'[redacted]'`. The default denylist SHALL include `authorization`, `cookie`, `set-cookie`, `x-api-key`, and `action-token`. Matching SHALL be case-insensitive. An optional `extraDenylist` parameter SHALL allow callers to pass additional header names.

#### Scenario: Default denylist redacts authorization, cookie, x-api-key, action-token
- **GIVEN** headers `{ authorization: 'Bearer xyz', cookie: 'session=abc', 'x-api-key': 'k', 'action-token': 'tok', 'content-type': 'application/json' }`
- **WHEN** `scrubHeaders(headers)` runs
- **THEN** the result has `authorization: '[redacted]'`, `cookie: '[redacted]'`, `'x-api-key': '[redacted]'`, `'action-token': '[redacted]'`
- **AND** `content-type` is unchanged as `'application/json'`

#### Scenario: Case-insensitive matching
- **GIVEN** headers `{ Authorization: 'Bearer xyz', COOKIE: 'session=abc' }`
- **WHEN** `scrubHeaders(headers)` runs
- **THEN** both values are `'[redacted]'` regardless of header case

#### Scenario: Extra denylist scrubs additional headers
- **GIVEN** `scrubHeaders(headers, ['x-custom-token'])`
- **WHEN** the headers include `x-custom-token: 'secret'`
- **THEN** `x-custom-token: '[redacted]'` in the result

### Requirement: mapDbError maps Postgres SQLSTATE codes to typed DomainErrors

The `map-db-error.ts` module SHALL export `mapDbError(err: unknown): DomainError` that intercepts Postgres errors via a structural check (`typeof err === 'object' && typeof err.code === 'string' && (err.name === 'error' || err.name === 'DatabaseError')`) and maps the SQLSTATE code to a typed `DomainError`. The function SHALL handle at minimum these seven codes: `23505 → ConflictError`, `23502 → ValidationError`, `23503 → ValidationError`, `22001 → ValidationError`, `40P01 → DependencyUnavailableError`, `57014 → DependencyUnavailableError`, `53300 → DependencyUnavailableError`. Any other pg code SHALL become `InternalError` with the original as `cause`. Any non-pg value SHALL become `InternalError` with the original as `cause`. Every mapped error SHALL have the raw SQLSTATE attached as a non-enumerable `pgCode` property for the metadata builder to consume.

#### Scenario: Unique violation maps to ConflictError with pgCode attached
- **GIVEN** a pg error with `{ code: '23505', name: 'error', detail: 'Key already exists' }`
- **WHEN** `mapDbError()` runs
- **THEN** the result is a `ConflictError`
- **AND** `result.pgCode` is `'23505'` (non-enumerable)
- **AND** `result.cause` is the original pg error
- **AND** `JSON.stringify(result)` does NOT include `pgCode`

#### Scenario: Not-null violation includes column in details
- **GIVEN** a pg error with `{ code: '23502', name: 'error', column: 'user_id' }`
- **WHEN** `mapDbError()` runs
- **THEN** the result is a `ValidationError`
- **AND** `result.details` references the column `user_id`

#### Scenario: Deadlock becomes DependencyUnavailableError
- **GIVEN** a pg error with `{ code: '40P01', name: 'error' }`
- **WHEN** `mapDbError()` runs
- **THEN** the result is a `DependencyUnavailableError`
- **AND** `result.code` is `'TEMPORARILY_UNAVAILABLE'`

#### Scenario: Unknown pg code becomes InternalError with cause preserved
- **GIVEN** a pg error with `{ code: 'XX999', name: 'error', message: 'strange' }`
- **WHEN** `mapDbError()` runs
- **THEN** the result is an `InternalError`
- **AND** `result.cause` is the original pg error
- **AND** `result.pgCode` is `'XX999'`

#### Scenario: Non-pg value becomes InternalError
- **GIVEN** a thrown string `'something went wrong'`
- **WHEN** `mapDbError('something went wrong')` runs
- **THEN** the result is an `InternalError`
- **AND** `result.cause` is the string

### Requirement: toPublicResponse builds the public envelope via allowlist

The `to-public-response.ts` module SHALL export `toPublicResponse(err, requestId, errorId)` returning `{ status: number, body: { error: {...} } }`. The body SHALL be constructed from scratch — the function SHALL NEVER serialize the `err` object directly. The envelope SHALL include exactly: `code`, `message` (truncated at 200 bytes), `requestId`. It SHALL include `details` only if `err instanceof ValidationError` and `err.details` is defined. It SHALL include `errorId` only if the `errorId` parameter is non-null (the caller passes non-null only for status ≥ 500). For any `err instanceof InternalError`, the function SHALL always replace the message with the generic `ERROR_CODE_META.INTERNAL_ERROR.defaultMessage`, regardless of `err.message`.

#### Scenario: Standard envelope for a ValidationError
- **GIVEN** `new ValidationError('delta out of range', [{ field: 'delta' }])`, `requestId: 'req-123'`, `errorId: null`
- **WHEN** `toPublicResponse()` runs
- **THEN** the result is `{ status: 400, body: { error: { code: 'VALIDATION', message: 'delta out of range', requestId: 'req-123', details: [{ field: 'delta' }] } } }`
- **AND** the body does NOT contain `errorId`
- **AND** the body does NOT contain `stack`
- **AND** the body does NOT contain `cause`

#### Scenario: InternalError message is always replaced by the generic
- **GIVEN** `new InternalError('database password: hunter2')` wrapping a raw pg error
- **WHEN** `toPublicResponse()` runs with `errorId: 'err-uuid'`
- **THEN** the result `body.error.message` is exactly `'Internal server error'`
- **AND** the string `'hunter2'` does NOT appear anywhere in the body
- **AND** `body.error.errorId` is `'err-uuid'`

#### Scenario: Message longer than 200 bytes is truncated with "..."
- **GIVEN** a `ValidationError` with a 500-byte message
- **WHEN** `toPublicResponse()` runs
- **THEN** `body.error.message.length` is exactly `200 + 3`
- **AND** the last three characters are `'...'`

#### Scenario: errorId appears only when caller passes a non-null value
- **WHEN** `toPublicResponse(err, 'req-123', null)` is called
- **THEN** the body does NOT contain `errorId`
- **WHEN** `toPublicResponse(err, 'req-123', 'err-uuid')` is called
- **THEN** the body contains `errorId: 'err-uuid'`

### Requirement: The shared/errors module exposes a stable barrel export

The directory `src/scoreboard/shared/errors/` SHALL contain an `index.ts` barrel file that re-exports the public surface: the `DomainError` base class and every concrete subclass, the `ErrorCode` type and `ERROR_CODES` tuple and `ERROR_CODE_META` table, the `wrapUnknown` function, the `buildErrorMetadata` function and `ErrorMetadata` type, the `scrubHeaders` function and `DEFAULT_HEADER_DENYLIST` constant, the `mapDbError` function, and the `toPublicResponse` function. Callers SHALL import exclusively from the barrel, never from individual files.

#### Scenario: Barrel exports are complete
- **WHEN** `import * as errors from 'src/scoreboard/shared/errors'` is run
- **THEN** `errors` exposes all ten `DomainError` subclasses, the `DomainError` base, the error-code constants, and all six named functions (`wrapUnknown`, `buildErrorMetadata`, `scrubHeaders`, `mapDbError`, `toPublicResponse`, and the `DomainError` class)

#### Scenario: Internal file paths are not imported directly
- **WHEN** grep is run against `src/` for `from '.*shared/errors/(domain-error|error-codes|error-metadata|scrub-headers|map-db-error|to-public-response|wrap-unknown)'`
- **THEN** the result is empty (all imports go through the barrel)
