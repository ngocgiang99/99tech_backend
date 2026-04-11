## MODIFIED Requirements

### Requirement: Global error filter normalizes every error to the standard envelope

The system SHALL register a single global exception filter that catches every unhandled error escaping a controller and produces an HTTP response with body `{ error: { code, message, requestId, details?, errorId? } }`. The filter SHALL delegate to the `scoreboard-errors` primitives in exactly this order: (1) idempotency guard on `reply.raw.headersSent`; (2) `wrapUnknown(exception)` to coerce any thrown value into a typed `DomainError`; (3) fresh `errorId` UUID generated per-error; (4) `buildErrorMetadata(appErr, request, errorId)` produces the structured log payload; (5) structured Pino-compatible log entry at `warn` (<500) or `error` (≥500) level, with the metadata object as the first argument to the logger; (6) increment `scoreboard_errors_total{code, status}`; (7) `toPublicResponse(appErr, requestId, status >= 500 ? errorId : null)` builds the envelope; (8) `reply.status(status).send(body)`. The filter SHALL NOT contain any `instanceof` branches — all classification logic lives in `wrapUnknown()`.

Domain errors SHALL map to specific HTTP codes via the `ERROR_CODE_META` table. Unexpected errors SHALL become `500` with `code: 'INTERNAL_ERROR'` and `message: 'Internal server error'` (generic message always — NEVER the wrapped error's raw message). No stack trace, cause chain, or internal field SHALL appear in the public response body. The full error detail SHALL be logged server-side with the same `errorId` that appears in the response.

Redis infrastructure errors (ioredis transport failures detected by pattern matching on name/message) SHALL be caught inside `wrapUnknown()` and surfaced as `DependencyUnavailableError` → `503 TEMPORARILY_UNAVAILABLE`. This preserves the GAP-03 fail-CLOSED contract established by step-07 DECISION-1.

#### Scenario: ValidationError becomes 400 with code VALIDATION
- **GIVEN** a handler that throws `new ValidationError('delta out of range', { field: 'delta', max: 100 })`
- **WHEN** the global filter handles the error
- **THEN** the response is `400`
- **AND** the body is `{ "error": { "code": "VALIDATION", "message": "delta out of range", "requestId": "<id>", "details": { "field": "delta", "max": 100 } } }`
- **AND** the body does NOT contain `errorId` (errorId is 5xx-only)
- **AND** the body does NOT contain a `hint` field (the old `hint: null` field is removed in this change)

#### Scenario: Unexpected Error becomes 500 with generic message and errorId
- **GIVEN** a handler that throws `new Error('database password: hunter2')`
- **WHEN** the global filter handles the error
- **THEN** the response is `500`
- **AND** `body.error.code` is `'INTERNAL_ERROR'`
- **AND** `body.error.message` is exactly `'Internal server error'`
- **AND** `body.error.errorId` is a valid UUID v4 string
- **AND** `body.error.requestId` is the request's requestId
- **AND** the body does NOT contain the substring `'hunter2'`
- **AND** the body does NOT contain a stack trace
- **AND** the body does NOT contain a `cause` field
- **AND** the server-side log entry contains the same `errorId`, the original error message, the stack, the walked cause chain, and the request context

#### Scenario: Error response X-Request-Id matches body.error.requestId
- **WHEN** any error response is built by the global filter
- **THEN** the `X-Request-Id` response header equals `body.error.requestId`
- **AND** both equal the request's `requestId` set by the Fastify hook

#### Scenario: Error taxonomy mapping is complete
- **WHEN** the filter processes each `DomainError` subclass
- **THEN** `ValidationError → 400 / VALIDATION`
- **AND** `BadRequestError → 400 / BAD_REQUEST`
- **AND** `UnauthenticatedError → 401 / UNAUTHENTICATED`
- **AND** `ForbiddenError → 403 / FORBIDDEN`
- **AND** `NotFoundError → 404 / NOT_FOUND`
- **AND** `ConflictError → 409 / CONFLICT`
- **AND** `UnprocessableEntityError → 422 / UNPROCESSABLE_ENTITY`
- **AND** `RateLimitError → 429 / RATE_LIMIT`
- **AND** `DependencyUnavailableError → 503 / TEMPORARILY_UNAVAILABLE`
- **AND** `InternalError → 500 / INTERNAL_ERROR`
- **AND** any other `Error` passed through `wrapUnknown()` becomes `InternalError → 500 / INTERNAL_ERROR`

#### Scenario: Redis infrastructure error preserves the fail-CLOSED contract
- **GIVEN** an ioredis `MaxRetriesPerRequestError` thrown from inside `ActionTokenGuard` or any Redis-touching call
- **WHEN** the filter handles the error
- **THEN** `wrapUnknown()` converts it to a `DependencyUnavailableError`
- **AND** the response status is `503`
- **AND** `body.error.code` is `'TEMPORARILY_UNAVAILABLE'`
- **AND** the server-side log entry records the original ioredis error in the walked `cause` chain

#### Scenario: Structured log payload contains all 14 metadata fields
- **GIVEN** a `ValidationError` thrown from a POST /v1/scores:increment request
- **WHEN** the filter logs the error
- **THEN** the log payload object (first argument to `logger.error()` or `logger.warn()`) contains exactly these fields: `errorId`, `errorClass`, `code`, `status`, `message`, `stack`, `pgCode?`, `cause[]`, `requestId`, `method`, `route`, `headers` (scrubbed), `query`, `body.{size, contentType}`, `userAgent`, `remoteAddr`, `timestamp`
- **AND** the body content is NOT present (only `body.size` and `body.contentType`)
- **AND** the raw `authorization` header value is NOT present (replaced with `'[redacted]'`)

#### Scenario: scoreboard_errors_total is incremented on every error
- **GIVEN** the filter processes a `ConflictError`
- **WHEN** the filter completes
- **THEN** `scoreboard_errors_total{code="CONFLICT", status="409"}` is incremented by 1

### Requirement: Prometheus metrics registry covers the write path

The system SHALL register Prometheus metric instances for every metric listed in `architecture.md §12.1` and increment/observe them at the appropriate points in the request lifecycle. The registry SHALL be accessible to the `/metrics` endpoint controller (which lands in `step-07`). The registry SHALL include a `scoreboard_errors_total` counter with labels `{code, status}`, incremented by the global error filter on every caught error.

#### Scenario: scoreboard_http_requests_total is incremented per request
- **GIVEN** the metric is registered as a `Counter` with labels `[method, route, status]`
- **WHEN** any request completes
- **THEN** the counter is incremented with the matching labels

#### Scenario: scoreboard_score_increment_total has the result label
- **WHEN** the score-increment handler completes
- **THEN** `scoreboard_score_increment_total` is incremented with `{result: 'committed' | 'idempotent' | 'rejected'}`

#### Scenario: scoreboard_action_token_verify_total has the outcome label
- **WHEN** `ActionTokenGuard` runs
- **THEN** `scoreboard_action_token_verify_total` is incremented with `{outcome: 'ok' | 'forged' | 'expired' | 'user_mismatch' | 'consumed'}`

#### Scenario: scoreboard_rate_limit_hits_total tracks allowed vs rejected
- **WHEN** `RateLimitGuard` runs
- **THEN** `scoreboard_rate_limit_hits_total` is incremented with `{outcome: 'allowed' | 'rejected'}`

#### Scenario: scoreboard_http_request_duration_seconds is observed for every request
- **WHEN** any request completes
- **THEN** the histogram observes the duration with labels `{method, route}`

#### Scenario: scoreboard_errors_total has bounded cardinality
- **WHEN** the metric is inspected
- **THEN** the `code` label is restricted to the `ErrorCode` union (10 values)
- **AND** the `status` label is restricted to the statuses in `ERROR_CODE_META` (9 distinct statuses)
- **AND** the label combinations SHALL NOT include per-user, per-action, or per-route dimensions
