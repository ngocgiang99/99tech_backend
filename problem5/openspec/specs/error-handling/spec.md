# error-handling

## Purpose

Defines the end-to-end contract for how the Resources API classifies, logs, and exposes errors. The shape of every error response is fixed by an allowlist (`{error: {code, message, requestId, details?, errorId?}}`); the server-side log entry for the same error carries a rich metadata payload (request id, route pattern, sanitized headers, body shape, cause chain, stack) so an operator can diagnose any incident from logs alone. A per-error `errorId` UUID correlates the public response with its log entry — a user reports the id from a 5xx, and the engineer pipes the JSON logs through `jq 'select(.errorId == "...")'` to find the request without re-running it.

The design takes an **allowlist posture for the public response** (built from scratch by `toPublicResponse`, never copied from the underlying error object) and a **denylist posture for header scrubbing** (sensitive header names are redacted before logging). This combination prevents structural leaks (allowlist) AND header-value leaks (denylist) without requiring an exhaustive enumeration of either. An integration test (`tests/integration/errors/leak.test.ts`) actively scans error responses for leak indicators (`pg`, `kysely`, `SELECT `, `node_modules`, …) as a belt-and-braces guard against regressions where someone splices unsafe data into `message`. Postgres errors are translated into `AppError` subclasses at the data-access boundary (`src/infrastructure/db/error-mapper.ts`), so the service layer only ever sees typed errors; the middleware's job is reduced to wrapping any remaining unknown error in `InternalError`, logging, and formatting the response.

## Requirements

### Requirement: Error Class Hierarchy

The service SHALL provide a single `AppError` base class and SHALL provide typed subclasses covering every domain and infrastructure error the HTTP layer can produce. Every subclass SHALL carry a stable `code`, an HTTP `status`, a safe public `message`, and optional structured `details`.

The required subclasses are: `ValidationError`, `NotFoundError`, `ConflictError`, `BadRequestError`, `UnprocessableEntityError`, `RateLimitError`, `DependencyError`, and `InternalError`.

#### Scenario: ValidationError carries field-level details

- **WHEN** a Zod validation fails
- **THEN** the thrown `ValidationError` has `code = "VALIDATION"`, `status = 400`, `message` describing the validation failure, and `details` as an array of `{path, code, message}` entries

#### Scenario: NotFoundError has no details

- **WHEN** a repository lookup misses
- **THEN** the thrown `NotFoundError` has `code = "NOT_FOUND"`, `status = 404`, and no `details` field (because `details` would only communicate "the id is not in the database", which is already implied by the status)

#### Scenario: DependencyError marks an upstream failure

- **WHEN** a Redis or Postgres call fails in a way that is retriable
- **THEN** the thrown `DependencyError` has `code = "DEPENDENCY_UNAVAILABLE"`, `status = 503`, and `message = "Upstream dependency is temporarily unavailable"`

#### Scenario: InternalError is the fallback for unknown errors

- **WHEN** an unknown error type is thrown inside a handler
- **THEN** the error handler wraps it in an `InternalError` with `code = "INTERNAL_ERROR"`, `status = 500`, and a generic `message = "Internal server error"`
- **AND** the original error is preserved on the `cause` field for logging purposes
- **AND** the original error is never exposed in the public response

### Requirement: Stable Error Code Enum

Error `code` values SHALL be drawn from a fixed, documented set. The set is part of the public API contract: clients can rely on these strings never changing. New codes MAY be added; existing codes MAY NOT be removed or renamed without a deprecation cycle.

The initial set is: `VALIDATION`, `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE_ENTITY`, `RATE_LIMIT`, `DEPENDENCY_UNAVAILABLE`, `INTERNAL_ERROR`.

#### Scenario: Every code maps to exactly one HTTP status

- **WHEN** the enum is inspected
- **THEN** each code has a single associated HTTP status code in the error-code-to-status mapping
- **AND** no two codes share a status without reason (multiple codes on 400 are fine because they distinguish validation from malformed JSON from other bad requests)

#### Scenario: Code values are UPPER_SNAKE_CASE strings

- **WHEN** any error is emitted
- **THEN** its `code` is a non-empty UPPER_SNAKE_CASE string matching the regex `^[A-Z][A-Z0-9_]*$`
- **AND** it is one of the codes in the documented set

### Requirement: Dev-Log Metadata Payload

Every error that reaches the error handler SHALL produce a single structured log entry containing a metadata payload rich enough to diagnose the incident without re-running the request. The payload SHALL include: error class, message, stack trace, `cause` chain, `errorId` (UUID), `requestId`, HTTP method, Express route pattern, sanitized request headers, query string (sanitized), request body size in bytes (NOT content), response status, response duration in milliseconds, user-agent, remote address, and ISO-8601 timestamp.

#### Scenario: Unhandled error produces a rich log entry

- **WHEN** an unhandled error reaches the error-handling middleware
- **THEN** the log line is at level `error` (for 5xx) or `warn` (for 4xx)
- **AND** the log line is valid JSON
- **AND** the JSON object contains every field from the metadata payload
- **AND** the `stack` field contains the full stack trace
- **AND** the `cause` field is an array (possibly empty) of `{class, message}` entries walking the `Error.cause` chain

#### Scenario: Log entry includes the errorId that appears in the response

- **WHEN** a 500 is emitted
- **THEN** the `errorId` field in the log entry matches the `errorId` field in the response body
- **AND** a support engineer can grep the logs by `errorId` from a user's error report

#### Scenario: Log entry does not contain sensitive data

- **WHEN** a request with an `Authorization: Bearer abc123` header errors out
- **THEN** the log entry's `headers.authorization` field is `"[REDACTED]"`
- **AND** the raw token does not appear anywhere in the log output

### Requirement: Sensitive-Data Scrubber

The service SHALL provide a scrubber that replaces the values of sensitive request headers with `"[REDACTED]"` before logging. The denylist SHALL include at minimum: `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`, `Proxy-Authorization`, and SHALL be extensible via configuration.

#### Scenario: Denylisted header is redacted

- **WHEN** a request with `Cookie: session=abc` is logged
- **THEN** the logged `headers.cookie` value is `"[REDACTED]"`

#### Scenario: Header name matching is case-insensitive

- **WHEN** a client sends `authorization` (lowercase) or `AUTHORIZATION` (uppercase)
- **THEN** the scrubber recognizes it as denylisted and redacts it

#### Scenario: Custom header added to the denylist via config

- **WHEN** `LOG_SCRUBBER_EXTRA_HEADERS=x-internal-secret,x-jwt` is set and a request with `X-Internal-Secret: xyz` errors
- **THEN** the logged `headers.x-internal-secret` value is `"[REDACTED]"`

#### Scenario: Body content is never logged

- **WHEN** an error occurs on a `POST /resources` with a body
- **THEN** the log entry contains `body.size` (in bytes) and `body.contentType` (MIME)
- **AND** the log entry does NOT contain the raw body bytes or a parsed object thereof

### Requirement: Minimal Public Error Response

Every HTTP error response SHALL match exactly the shape `{error: {code, message, requestId, details?, errorId?}}` and SHALL NOT include any additional fields. The `message` field SHALL NOT contain implementation-specific information (stack frames, file paths, SQL fragments, library names, class names, internal identifiers, raw exception text, or values from the offending row).

The fields are governed by the following rules:

- `code` is one of the stable error codes; always present.
- `message` is a bounded-length (≤ 200 chars), human-readable string safe for public exposure; always present.
- `requestId` is the request's correlation id echoed from `X-Request-Id`; always present.
- `details` is present ONLY for `VALIDATION` errors and contains an array of `{path: string, code: string, message: string}` entries, one per validation failure.
- `errorId` is present ONLY for 5xx responses and is the UUID that correlates the response with the dev log entry.

#### Scenario: 500 response does not leak internal details

- **WHEN** an unhandled Postgres exception bubbles up (for example, because the Postgres pool is exhausted)
- **THEN** the response body is `{"error": {"code": "INTERNAL_ERROR", "message": "Internal server error", "requestId": "...", "errorId": "..."}}`
- **AND** the body does NOT contain `pg`, `kysely`, any SQL fragment, any stack frame, any file path, or the original exception message

#### Scenario: Validation response contains only path-level details

- **WHEN** a client posts a body that fails Zod validation on two fields
- **THEN** the response is `{"error": {"code": "VALIDATION", "message": "Request validation failed", "requestId": "...", "details": [{"path": "name", "code": "too_small", "message": "..."}, {"path": "type", "code": "invalid_type", "message": "..."}]}}`
- **AND** `details` contains exactly two entries
- **AND** no other fields are present

#### Scenario: 4xx response omits errorId

- **WHEN** a client requests an id that does not exist
- **THEN** the 404 response body is `{"error": {"code": "NOT_FOUND", "message": "Resource not found", "requestId": "..."}}`
- **AND** the response does NOT contain an `errorId` field
- **AND** the log entry is at level `warn`, not `error`

#### Scenario: message length is bounded

- **WHEN** a `ValidationError` has a long underlying message
- **THEN** the public `message` is truncated to 200 characters and ends with `"..."`
- **AND** the full message is preserved in the log payload

### Requirement: Infrastructure Error Mapper

The data access layer SHALL translate Postgres errors into `AppError` subclasses using the `pg` error code field. Unknown codes SHALL map to `InternalError` so the service layer never sees raw `pg` exceptions.

#### Scenario: Unique violation maps to ConflictError

- **WHEN** an `INSERT` fails with pg code `23505`
- **THEN** the repository throws `ConflictError` with `code = "CONFLICT"` and `status = 409`
- **AND** the raw pg error is attached as the `cause`

#### Scenario: Not-null violation maps to ValidationError

- **WHEN** an `INSERT`/`UPDATE` fails with pg code `23502`
- **THEN** the repository throws `ValidationError` with `status = 400`
- **AND** the `details` array indicates which column is null

#### Scenario: Deadlock maps to DependencyError

- **WHEN** a transaction fails with pg code `40P01` (deadlock detected)
- **THEN** the repository throws `DependencyError` with `status = 503`
- **AND** the public `message` is a generic "Upstream dependency is temporarily unavailable"

#### Scenario: Unknown pg code maps to InternalError

- **WHEN** a pg error with a code not in the mapping is thrown
- **THEN** the repository wraps it in an `InternalError` with the raw error as `cause`
- **AND** the log entry records the original pg code in its metadata

### Requirement: All Thrown Errors Use the Taxonomy

No application code SHALL throw a raw `Error` or a non-`AppError` subclass across the module boundary. Any place that needs to bail out MUST use one of the typed subclasses or MUST wrap with `wrapUnknown(error)` before rethrowing.

#### Scenario: Repository propagates typed errors only

- **WHEN** the repository encounters an unexpected error path
- **THEN** the error it throws is an `AppError` subclass
- **AND** a unit test inspects the error's prototype chain and asserts it extends `AppError`

#### Scenario: Service propagates typed errors only

- **WHEN** the service layer throws
- **THEN** the thrown value is an `AppError` subclass
- **AND** `instanceof AppError` returns `true`

### Requirement: Integration Test — Response Leak Check

The integration test suite SHALL include a dedicated test that forces each major error path to fire and asserts the response body matches the minimal allowlist and does NOT contain any of a denylist of leak indicators: `"at /"`, `"pg"`, `"kysely"`, `"ioredis"`, `"node_modules"`, `"stack"`, `"SELECT "`, `"INSERT "`, `"UPDATE "`, `"DELETE "`.

#### Scenario: Validation error response has no leak indicators

- **WHEN** a POST with an invalid body is made in the integration suite
- **THEN** the response body is inspected against the denylist
- **AND** none of the denylist substrings appear in the body

#### Scenario: Forced 500 response has no leak indicators

- **WHEN** the integration suite uses a test-only seam (for example, by stopping Postgres mid-test or by injecting a failing repository) to force a 500 response
- **THEN** the response body is inspected against the denylist
- **AND** none of the denylist substrings appear in the body
- **AND** the body contains an `errorId` that matches the log entry captured during the test
