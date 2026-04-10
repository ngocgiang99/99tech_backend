## MODIFIED Requirements

### Requirement: Error Response Shape

All error responses SHALL share exactly the shape `{error: {code, message, requestId, details?, errorId?}}` and SHALL NOT contain any additional fields. The HTTP status SHALL be the status mapped from the error `code` via the stable code-to-status mapping defined in the `error-handling` capability.

The fields are exhaustively enumerated:

- `code`: one of the stable error codes (`VALIDATION`, `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE_ENTITY`, `RATE_LIMIT`, `DEPENDENCY_UNAVAILABLE`, `INTERNAL_ERROR`); always present.
- `message`: a human-readable string of at most 200 characters that is safe for public exposure; always present; longer underlying messages are truncated with `"..."`.
- `requestId`: the request correlation id echoed from the inbound `X-Request-Id` header (or generated if absent); always present.
- `details`: present ONLY for `VALIDATION` errors; an array of `{path: string, code: string, message: string}` entries, one per validation failure.
- `errorId`: present ONLY for 5xx responses; a UUID correlating the response with the dev-log entry for the same error.

No other fields are permitted. The `message` field SHALL NOT contain implementation-specific information, including but not limited to: stack frames, file paths, SQL fragments, library or class names, internal identifiers, raw exception text, or values from offending rows.

#### Scenario: Validation error shape

- **WHEN** a request body fails Zod validation
- **THEN** the response body matches the shared error shape
- **AND** `code` is `"VALIDATION"`
- **AND** `details` is an array of field-level `{path, code, message}` entries
- **AND** no `errorId` field is present

#### Scenario: Not-found error shape

- **WHEN** a request targets an id that does not exist
- **THEN** the response body matches the shared error shape
- **AND** `code` is `"NOT_FOUND"`
- **AND** `requestId` matches the `X-Request-Id` response header
- **AND** no `details` or `errorId` fields are present

#### Scenario: 500 error shape and leak check

- **WHEN** the error handler is triggered for an unexpected error on any `/resources` endpoint
- **THEN** the response body matches the shared error shape
- **AND** `code` is `"INTERNAL_ERROR"`
- **AND** `message` is the generic string `"Internal server error"`
- **AND** `errorId` is a UUID that matches the dev-log entry
- **AND** the response body contains no stack traces, SQL, file paths, library names, or class names

#### Scenario: Conflict error from unique violation

- **WHEN** a `POST /resources` triggers a unique constraint violation in Postgres
- **THEN** the infrastructure error mapper translates the pg error (code `23505`) to `ConflictError`
- **AND** the response status is `409 Conflict`
- **AND** the response body is `{"error": {"code": "CONFLICT", "message": "Resource already exists", "requestId": "..."}}`
- **AND** the response body does NOT leak the constraint name, column name, or offending value
