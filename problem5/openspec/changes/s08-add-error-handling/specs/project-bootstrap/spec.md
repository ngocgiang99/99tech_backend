## MODIFIED Requirements

### Requirement: Central Error Handler

The service SHALL funnel all uncaught errors from request handlers through a single error-handling middleware that:

1. Wraps any non-`AppError` throwable via `wrapUnknown` so downstream logic can rely on a typed error.
2. Generates a fresh `errorId` UUID for every error.
3. Emits a single structured log entry at `warn` level for 4xx statuses and `error` level for 5xx statuses, including the full dev-log metadata payload defined in the `error-handling` capability.
4. Returns a public response body matching the minimal allowlist shape defined in the `error-handling` capability.
5. Never allows stack traces, SQL fragments, file paths, library names, or the raw `error.message` of an unmapped error to appear in the response body.

#### Scenario: Handler throws an unexpected error

- **WHEN** a request handler throws a non-`AppError` error
- **THEN** the middleware wraps it in `InternalError` with the original attached as `cause`
- **AND** the middleware logs the error at `error` level with the full metadata payload including stack and sanitized headers
- **AND** the response status is `500 Internal Server Error`
- **AND** the response body is `{"error": {"code": "INTERNAL_ERROR", "message": "Internal server error", "requestId": "...", "errorId": "..."}}`
- **AND** the `errorId` in the response equals the `errorId` in the log entry

#### Scenario: Handler throws a known HTTP error

- **WHEN** a request handler throws an `AppError` subclass with a 4xx status
- **THEN** the middleware skips the `wrapUnknown` step (the error is already typed)
- **AND** the middleware logs the error at `warn` level with the full metadata payload
- **AND** the response status matches the error's `status` field
- **AND** the response body contains the error's `code`, `message`, `requestId`, and (for `ValidationError`) `details`
- **AND** the response body does NOT contain an `errorId` field (4xx is the client's fault; no need for server-side correlation)

#### Scenario: Sensitive request headers are scrubbed before logging

- **WHEN** a request with an `Authorization` header errors out
- **THEN** the log entry's `headers.authorization` value is `"[REDACTED]"`
- **AND** the raw header value does not appear anywhere in the log output
- **AND** the public response body does not contain the header value or its redaction marker
