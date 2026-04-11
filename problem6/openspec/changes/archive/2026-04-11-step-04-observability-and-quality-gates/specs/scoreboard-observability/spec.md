## ADDED Requirements

### Requirement: Structured JSON logs via Pino with request-ID propagation

The system SHALL emit structured JSON log lines via Pino. Every HTTP request SHALL produce at least one log line containing `ts`, `level`, `msg`, `requestId`, `route`, `latencyMs`, `statusCode`. Secret-bearing fields SHALL be redacted.

#### Scenario: Request without inbound X-Request-Id gets a fresh ULID
- **GIVEN** a request with no `X-Request-Id` header
- **WHEN** the Fastify `onRequest` hook runs
- **THEN** a fresh ULID is generated and stored as `request.requestId`
- **AND** the response header `X-Request-Id` echoes that ULID
- **AND** the request log line includes the same `requestId` value

#### Scenario: Request with inbound X-Request-Id is honored
- **GIVEN** a request with header `X-Request-Id: 01HXKQGZJP3T7BV1WMYE9YAR8K`
- **WHEN** the hook runs
- **THEN** `request.requestId` equals the inbound value
- **AND** the response header echoes the same value (no overwrite)

#### Scenario: Log line contains all required fields
- **WHEN** a request completes (success or error)
- **THEN** the emitted log line has at minimum the fields `ts`, `level`, `msg`, `requestId`, `route`, `latencyMs`, `statusCode`
- **AND** if a `userId` is available (set by `JwtGuard`), the log line includes `userId` (hashed for privacy)

#### Scenario: Pino redacts authorization headers and action tokens
- **GIVEN** a request with header `Authorization: Bearer <jwt>` and body containing an `actionToken` field
- **WHEN** the request is logged
- **THEN** the JWT and the `actionToken` value do NOT appear in any log line
- **AND** their positions are replaced with `[REDACTED]` (or omitted entirely)

#### Scenario: Logger redacts ACTION_TOKEN_SECRET if accidentally referenced
- **GIVEN** code that accidentally tries to log `config.get('ACTION_TOKEN_SECRET')`
- **WHEN** the log line is built
- **THEN** Pino's redaction config strips the value before serialization

### Requirement: Global error filter normalizes every error to the standard envelope

The system SHALL register a single global exception filter that catches every unhandled error escaping a controller and produces an HTTP response with body `{ error: { code, message, requestId, hint } }`. Domain errors SHALL map to specific HTTP codes; unexpected errors SHALL become `500 INTERNAL_ERROR` with no stack trace leaked to the client.

#### Scenario: Domain error InvalidArgumentError becomes 400
- **GIVEN** a handler that throws `new InvalidArgumentError('delta out of range')`
- **WHEN** the global filter handles the error
- **THEN** the response is `400`
- **AND** the body is `{ "error": { "code": "INVALID_ARGUMENT", "message": "delta out of range", "requestId": "<id>", "hint": "<optional hint>" } }`

#### Scenario: Unexpected Error becomes 500 with generic message
- **GIVEN** a handler that throws `new Error('database connection lost')`
- **WHEN** the global filter handles the error
- **THEN** the response is `500`
- **AND** the body is `{ "error": { "code": "INTERNAL_ERROR", "message": "Internal server error", "requestId": "<id>" } }`
- **AND** the body does NOT contain the original "database connection lost" message
- **AND** the body does NOT contain a stack trace
- **AND** the original error IS logged server-side at `error` level with the stack trace

#### Scenario: Error response X-Request-Id matches body.error.requestId
- **WHEN** any error response is built by the global filter
- **THEN** the `X-Request-Id` response header equals `body.error.requestId`
- **AND** both equal the request's `requestId` set by the Fastify hook

#### Scenario: Error taxonomy mapping is complete
- **WHEN** the filter processes each domain error type
- **THEN** `InvalidArgumentError → 400`
- **AND** `NotFoundError → 404`
- **AND** `ConflictError → 409`
- **AND** `UnauthorizedError → 401`
- **AND** `ForbiddenError → 403`
- **AND** any other Error → 500

### Requirement: Prometheus metrics registry covers the write path

The system SHALL register Prometheus metric instances for every metric listed in `architecture.md §12.1` and increment/observe them at the appropriate points in the request lifecycle. The registry SHALL be accessible to the `/metrics` endpoint controller (which lands in `step-07`).

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

### Requirement: OpenTelemetry tracing initialized before NestJS imports

The system SHALL initialize the OpenTelemetry SDK in `tracing.bootstrap.ts`, called as the FIRST statement in `main.ts` (before any framework imports). When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, traces SHALL be exported via OTLP. When unset, the SDK SHALL be a no-op (no exporter registered).

#### Scenario: Tracing init runs before AppModule import
- **WHEN** `main.ts` is read
- **THEN** the FIRST executable line is `await initTracing()` (or `initTracing()` if synchronous)
- **AND** all other imports (`AppModule`, `NestFactory`) come after

#### Scenario: OTel is no-op when endpoint is unset
- **GIVEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is unset
- **WHEN** `initTracing()` runs
- **THEN** no exporter is registered
- **AND** no error is raised
- **AND** the application boots normally (logs may indicate "tracing disabled")

#### Scenario: Custom spans are created for key operations
- **GIVEN** OTel is enabled
- **WHEN** a request goes through the guard chain
- **THEN** spans named `jwt.verify`, `action-token.verify`, `idempotency.check`, `db.tx` exist in the resulting trace
- **AND** the spans have the request's `traceparent` as a parent (if inbound)

#### Scenario: Auto-instrumentation patches pg and fastify
- **GIVEN** OTel is enabled
- **WHEN** Postgres queries run via Kysely
- **THEN** spans appear automatically with names like `pg.query`
- **AND** the spans include the query SQL (with parameters redacted) as an attribute
