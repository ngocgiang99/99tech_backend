# project-bootstrap

## Purpose

Defines how the service starts up, loads configuration, exposes a health
endpoint, logs requests, and shuts down cleanly. This is the contract between
operators/tooling (container orchestrators, health probes, log aggregators)
and the running process.

## Requirements

### Requirement: Typed Configuration Loader

The service SHALL load all runtime configuration from environment variables through a Zod schema and SHALL refuse to start if any required variable is missing or fails validation.

#### Scenario: All required environment variables are present and valid

- **WHEN** the process starts with every required variable set to a valid value
- **THEN** the configuration loader returns a typed config object
- **AND** the process continues to HTTP bootstrap

#### Scenario: A required environment variable is missing

- **WHEN** the process starts without `DATABASE_URL` (or any other required variable)
- **THEN** the configuration loader writes a human-readable error to `stderr` naming the missing variable
- **AND** the process exits with a non-zero status code
- **AND** no HTTP listener is opened

#### Scenario: An environment variable has an invalid value

- **WHEN** `PORT` is set to a non-numeric value
- **THEN** the configuration loader writes a Zod validation error identifying the offending field
- **AND** the process exits with a non-zero status code

### Requirement: Structured JSON Logger

The service SHALL emit all logs as structured JSON on `stdout` with a monotonic timestamp, a log level, and a message, and SHALL attach a per-request child logger carrying a `requestId` field to every incoming HTTP request.

#### Scenario: A log entry is produced during startup

- **WHEN** the service logs an informational message during bootstrap
- **THEN** the line on `stdout` is valid JSON
- **AND** the JSON object contains `level`, `time`, and `msg` keys

#### Scenario: A log entry is produced inside a request handler

- **WHEN** a request handler emits a log using the request-scoped logger
- **THEN** the JSON log line contains a `requestId` field equal to the inbound request id

### Requirement: Health Endpoint

The service SHALL expose `GET /healthz` which reports liveness and readiness and SHALL return an appropriate HTTP status code for each state. Readiness SHALL include a `db` check that runs a lightweight query (`SELECT 1`) against the Postgres pool and a `cache` check that issues `PING` against the Redis client. Each check reports `"up"` on success or `"down"` with an error reason on failure.

#### Scenario: Service is live and ready

- **WHEN** a client issues `GET /healthz` while all upstream dependencies are reachable
- **THEN** the response status is `200 OK`
- **AND** the JSON body contains `{"status": "ok", "checks": {...}}`
- **AND** every entry in `checks` has status `"up"`
- **AND** `checks.db` and `checks.cache` are both present and report `"up"`

#### Scenario: Service is live but not ready

- **WHEN** a client issues `GET /healthz` while at least one upstream dependency is unreachable
- **THEN** the response status is `503 Service Unavailable`
- **AND** the JSON body contains `{"status": "degraded", "checks": {...}}`
- **AND** the unreachable dependency's entry has status `"down"` with an error reason

#### Scenario: Liveness-only probe during bootstrap

- **WHEN** a client issues `GET /healthz?probe=liveness` before readiness checks are wired up
- **THEN** the response status is `200 OK`
- **AND** the body reports only liveness

#### Scenario: Database is unreachable

- **WHEN** Postgres is stopped while the service is running
- **THEN** `GET /healthz` returns `503 Service Unavailable`
- **AND** `checks.db` is `{"status": "down", "error": "..."}`
- **AND** `GET /healthz?probe=liveness` still returns `200 OK`

#### Scenario: Redis is unreachable

- **WHEN** Redis is stopped while the service is running
- **THEN** `GET /healthz` returns `503 Service Unavailable`
- **AND** `checks.cache` is `{"status": "down", "error": "..."}`
- **AND** `GET /healthz?probe=liveness` still returns `200 OK`
- **AND** resource GET requests continue to succeed (served from Postgres) with `X-Cache: MISS`

### Requirement: Request Identification

The service SHALL assign every inbound HTTP request a `requestId`, using an inbound `X-Request-Id` header when supplied and generating a UUID otherwise, and SHALL echo the id back in the `X-Request-Id` response header.

#### Scenario: Inbound request has no X-Request-Id header

- **WHEN** a client sends a request without `X-Request-Id`
- **THEN** the middleware generates a UUID v4
- **AND** the generated id is attached to the request object and child logger
- **AND** the same id appears in the `X-Request-Id` response header

#### Scenario: Inbound request provides X-Request-Id

- **WHEN** a client sends a request with `X-Request-Id: abc-123`
- **THEN** the middleware reuses `abc-123` as the request id
- **AND** the response header echoes `X-Request-Id: abc-123`

### Requirement: Graceful Shutdown

The service SHALL intercept `SIGTERM` and `SIGINT`, stop accepting new connections, drain in-flight requests within a configurable timeout, close upstream clients, and then exit with status `0`.

#### Scenario: Service receives SIGTERM with no in-flight requests

- **WHEN** the process receives `SIGTERM`
- **THEN** the HTTP listener stops accepting new connections
- **AND** the process exits with code `0` within the shutdown timeout

#### Scenario: Service receives SIGTERM with in-flight requests

- **WHEN** the process receives `SIGTERM` while one or more requests are still being served
- **THEN** the HTTP listener stops accepting new connections immediately
- **AND** the in-flight requests are allowed to complete
- **AND** the process exits with code `0` once all in-flight requests finish or the shutdown timeout elapses

#### Scenario: Shutdown timeout exceeded

- **WHEN** in-flight requests have not completed within the configured shutdown timeout
- **THEN** the process force-exits with a non-zero status code
- **AND** a warning log entry records the forced shutdown

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
