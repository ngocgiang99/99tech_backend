# scoreboard-observability

## Purpose

Cross-cutting observability infrastructure for the scoreboard module. Owns the Pino logger factory, Fastify request-ID hook, global `HttpExceptionFilter`, Prometheus metrics registry (prom-client), and OpenTelemetry tracing bootstrap. Establishes the contract that every controller writes structured logs, every error follows the standard envelope format, and every critical operation is measurable + traceable.

## Requirements

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

### Requirement: logWithMetadata helper exists for non-HTTP error paths

The system SHALL provide a `logWithMetadata(logger, level, err, context?)` helper at `src/scoreboard/shared/resilience/log-with-metadata.ts` that emits the same structured error log payload as the HTTP exception filter, for use in non-HTTP contexts (background workers, JetStream message handlers, bootstrap code, shutdown hooks, scheduled jobs). This helper SHALL depend on the `scoreboard-errors` primitives (`wrapUnknown`, `buildErrorMetadata`) introduced by the `restructure-error-handling-for-observability` change; it is not applicable until that change has been applied.

The helper SHALL coerce any thrown value (not just `Error` instances) into a typed `DomainError` via `wrapUnknown()`, build a metadata payload via `buildErrorMetadata()` using a synthetic background-request stub (method `'BACKGROUND'`, route `'__background'` or the caller-supplied `context.source`), and emit a single structured log entry at the requested level (`'warn' | 'error' | 'fatal'`). The optional `context` parameter SHALL be merged into the log entry as sibling fields alongside the metadata object so callers can attach job-specific dimensions like `{ job: 'outbox-publish', aggregateId: '...' }` without polluting the request-shaped metadata fields.

#### Scenario: Background error is logged with full metadata and context
- **GIVEN** a background `OutboxPublisher` encounters `new Error('publish failed')`
- **WHEN** `logWithMetadata(logger, 'error', err, { job: 'outbox-publish', aggregateId: 'abc' })` is called
- **THEN** `logger.error` is called exactly once
- **AND** the first argument contains a metadata object with `errorClass: 'InternalError'`, `message: 'publish failed'`, `stack: ...`, `method: 'BACKGROUND'`
- **AND** the first argument also contains the context fields `job: 'outbox-publish'` and `aggregateId: 'abc'` as top-level sibling keys

#### Scenario: Unknown thrown value is coerced via wrapUnknown
- **GIVEN** a bootstrap failure throws the string `'config parse error'`
- **WHEN** `logWithMetadata(logger, 'fatal', 'config parse error')` is called
- **THEN** `logger.fatal` is called (or `logger.error` if the logger does not support `fatal`)
- **AND** the metadata's `errorClass` is `'InternalError'`
- **AND** the metadata's `cause` chain contains an entry derived from the thrown string

#### Scenario: Helper works without a Fastify request in scope
- **GIVEN** a caller inside a NATS message handler (no active HTTP request)
- **WHEN** `logWithMetadata(logger, 'error', err)` is called
- **THEN** the helper succeeds
- **AND** the metadata's `method` is `'BACKGROUND'`
- **AND** the metadata's `route` is `'__background'` (no `context.source` was supplied)
- **AND** the metadata's `headers`, `query`, `body` fields are present but empty or null

#### Scenario: context.source overrides the synthetic route
- **GIVEN** a caller supplies `context: { source: 'jetstream-subscriber' }`
- **WHEN** `logWithMetadata()` runs
- **THEN** the metadata's `route` is `'jetstream-subscriber'`

#### Scenario: Helper uses the same wrapUnknown branches as the HTTP filter
- **GIVEN** the helper is invoked with a pg-shaped error (e.g. a raw `pg` unique-violation with `code: '23505'`)
- **WHEN** `logWithMetadata(logger, 'error', pgErr)` runs
- **THEN** the metadata's `errorClass` is `'ConflictError'` (delegated via `mapDbError`)
- **AND** the metadata's `pgCode` is `'23505'`

#### Scenario: Helper is defined at the expected file path
- **WHEN** the source tree is inspected
- **THEN** `src/scoreboard/shared/resilience/log-with-metadata.ts` exists
- **AND** it is exported from `src/scoreboard/shared/resilience/index.ts`
- **AND** it imports `wrapUnknown` and `buildErrorMetadata` from `src/scoreboard/shared/errors` (the barrel defined by `restructure-error-handling-for-observability`)

### Requirement: Local observability stack boots via compose.override.yml under the observability profile

The repository SHALL provide a local Prometheus + Grafana pair configured to scrape the dev server's `/metrics` endpoint and render a committed dashboard. The stack SHALL be opt-in via Compose's `--profile observability` mechanism so default `docker compose up` behavior is unchanged. The services SHALL live in the existing `compose.override.yml` (not in `docker-compose.yml`, which remains SHA-256-pinned as a canonical scaffold file). The services SHALL bind to `127.0.0.1` only (never `0.0.0.0`) so the stack is unreachable from other machines on the developer's network.

#### Scenario: Default compose up ignores the observability services
- **GIVEN** the repository with the updated `compose.override.yml`
- **WHEN** the developer runs `docker compose up` without any profile flag
- **THEN** only the canonical services (postgres, redis, nats) start
- **AND** prometheus and grafana remain stopped

#### Scenario: The observability profile starts prometheus and grafana
- **WHEN** the developer runs `docker compose --profile observability up -d prometheus grafana`
- **THEN** both containers start within 10 seconds
- **AND** the containers reach healthy state (per their built-in healthchecks or a successful bind to their port)

#### Scenario: Prometheus host port is 59090 and loopback-bound
- **WHEN** the prometheus service is inspected
- **THEN** its host port mapping is `127.0.0.1:59090:9090`
- **AND** the service is NOT reachable from `http://<host-lan-ip>:59090`
- **AND** the service IS reachable from `http://localhost:59090` on the developer's machine

#### Scenario: Grafana host port is 53000 and loopback-bound
- **WHEN** the grafana service is inspected
- **THEN** its host port mapping is `127.0.0.1:53000:3000`
- **AND** the service is NOT reachable from outside the developer's machine

#### Scenario: docker-compose.yml is unchanged
- **WHEN** the SHA-256 hash of `docker-compose.yml` is computed
- **THEN** the hash is identical to its pre-change value
- **AND** the file contains no `prometheus` or `grafana` service entries

### Requirement: Prometheus scrape configuration targets the host dev server

The `infra/local/prometheus/prometheus.yml` file SHALL define one scrape job named `scoreboard-api` with at least one static target of `host.docker.internal:3000` for the host-bound dev loop. A second static target `problem6-api:3000` MAY be included to cover the containerized dev loop via compose-network DNS; Prometheus marks whichever target is unreachable as DOWN so each becomes self-diagnosing. The prometheus service in `compose.override.yml` SHALL include an `extra_hosts: ["host.docker.internal:host-gateway"]` directive so the hostname resolves on Linux as well as Docker Desktop (macOS/Windows). The scrape interval SHALL be 5 seconds.

#### Scenario: Scrape job targets the host dev server
- **WHEN** `infra/local/prometheus/prometheus.yml` is inspected
- **THEN** it contains a `scrape_configs` entry named `scoreboard-api`
- **AND** at least one static target is `host.docker.internal:3000`
- **AND** the scrape interval is `5s`

#### Scenario: Prometheus can resolve host.docker.internal on Linux
- **GIVEN** a Linux developer running `mise run dev` on the host (API on port 3000)
- **WHEN** `mise run obs:up` starts the prometheus container
- **THEN** the container resolves `host.docker.internal` to the Docker host gateway IP
- **AND** the prometheus UI at `http://localhost:59090/targets` shows the `scoreboard-api` target as UP within 15 seconds

#### Scenario: Prometheus shows the target as DOWN when the dev server is not running
- **GIVEN** the API is NOT running on the host
- **WHEN** the prometheus UI's targets page is opened
- **THEN** the `scoreboard-api` target is displayed as DOWN
- **AND** the "Last Scrape" column shows a connection error
- **AND** the stack itself does NOT crash or exit

#### Scenario: Dual targets are discriminated by the source label
- **GIVEN** the scrape config includes both `host.docker.internal:3000` and `problem6-api:3000`
- **WHEN** the targets page is inspected
- **THEN** each target carries a distinct `source` label (`host` vs `compose`) so operators can tell at a glance which scrape path produced which series
- **AND** at least one of the two is UP whenever problem6-api is running anywhere

### Requirement: Grafana auto-provisions the datasource and dashboard on boot

The grafana service SHALL mount `infra/local/grafana/provisioning/` read-only at `/etc/grafana/provisioning/`. The provisioning directory SHALL contain a `datasources/prometheus.yml` file that defines a Prometheus datasource with `uid: prometheus` pointing at `http://prometheus:9090` (compose-network DNS), and a `dashboards/dashboards.yml` provider config that loads any JSON file from `/var/lib/grafana/dashboards/`. The dashboard JSON files themselves SHALL be mounted from `infra/local/grafana/dashboards/` read-only at `/var/lib/grafana/dashboards/`. Grafana SHALL NOT have a persistent volume for `/var/lib/grafana` — all state is ephemeral and the committed JSON is the source of truth.

#### Scenario: Datasource is provisioned on first boot
- **GIVEN** a fresh grafana container boot
- **WHEN** the Grafana UI is opened at `http://localhost:53000`
- **THEN** the Prometheus datasource is present in Configuration → Data sources
- **AND** no manual UI setup was required
- **AND** clicking "Test" on the datasource returns a success response

#### Scenario: Dashboard is loaded on first boot
- **GIVEN** the `scoreboard-overview.json` file exists in `infra/local/grafana/dashboards/`
- **WHEN** the Grafana UI is opened
- **THEN** the `Scoreboard Overview` dashboard is visible in the Dashboards list
- **AND** no manual import step was required
- **AND** clicking the dashboard title opens it with all panels rendering

#### Scenario: Dashboard edits are lost on container restart
- **GIVEN** a running grafana container with a user-edited dashboard
- **WHEN** the operator runs `mise run obs:down && mise run obs:up`
- **THEN** the dashboard reverts to the committed `scoreboard-overview.json` content
- **AND** any unsaved UI changes are discarded
- **AND** this behavior is documented in `infra/local/README.md`

### Requirement: Committed dashboard renders panels for all scoreboard metrics

`infra/local/grafana/dashboards/scoreboard-overview.json` SHALL contain exactly 8 panels organized into 4 rows (HTTP traffic, Write path, Rate limit & errors, Process). Every metric registered in `src/shared/metrics/write-path-metrics.ts` SHALL have at least one corresponding panel. Panel queries SHALL use `rate()` with a 1-minute window for counters and `histogram_quantile()` for duration histograms. Each panel's `datasource.uid` SHALL be the literal string `"prometheus"` matching the provisioned datasource's uid (NOT the `__inputs` / `${DS_PROMETHEUS}` template-variable pattern, which Grafana only substitutes on UI-driven imports and leaves untouched under file-based provisioning). The dashboard SHALL expose a Grafana dashboard variable `percentile` (type `custom`, options `p50 / p95 / p99`, default `p95`) and the HTTP request duration panel SHALL use `histogram_quantile($percentile, ...)` so operators can switch percentiles at runtime from a dropdown at the top of the dashboard.

#### Scenario: All 8 metric names are referenced in the dashboard
- **WHEN** `scoreboard-overview.json` is grep'd for metric names
- **THEN** it contains at least one query referencing each of: `scoreboard_http_requests_total`, `scoreboard_http_request_duration_seconds`, `scoreboard_score_increment_total`, `scoreboard_action_token_verify_total`, `scoreboard_rate_limit_hits_total`, `scoreboard_rate_limit_failed_closed_total`, `scoreboard_process_start_time_seconds`, `scoreboard_errors_total`

#### Scenario: Panels group into the expected rows
- **WHEN** the dashboard is inspected
- **THEN** row 1 is "HTTP traffic" with 2 panels
- **AND** row 2 is "Write path" with 2 panels
- **AND** row 3 is "Rate limit & errors" with 3 panels
- **AND** row 4 is "Process" with 1 panel

#### Scenario: Every panel uses the literal prometheus datasource uid
- **WHEN** the dashboard JSON is inspected
- **THEN** every non-row panel has `datasource.uid == "prometheus"` and `datasource.type == "prometheus"`
- **AND** the JSON has no top-level `__inputs` block (the import-flow template pattern is absent)
- **AND** the JSON has no occurrence of the literal string `${DS_PROMETHEUS}`

#### Scenario: Percentile dashboard variable swaps the latency panel live
- **GIVEN** the dashboard is open and `Percentile` is set to `p95`
- **WHEN** the operator changes the dropdown to `p99`
- **THEN** the `Request duration by route` panel re-queries with `histogram_quantile(0.99, ...)`
- **AND** the panel title updates to include `(p99)` via the `${percentile}` variable substitution
- **AND** switching back to `p50` updates both the query and the title again

#### Scenario: Errors panel renders "No data" before the error-restructure change ships
- **GIVEN** `scoreboard_errors_total` is not yet emitted (the `restructure-error-handling-for-observability` change has not been applied)
- **WHEN** the errors panel is inspected in Grafana
- **THEN** the panel legend shows "No data"
- **AND** the dashboard itself does NOT show an error
- **AND** the other 7 panels render their data normally

#### Scenario: Metric rename breaks the panel loudly
- **GIVEN** a refactor renames `scoreboard_score_increment_total` to `scoreboard_credits_total` without updating the dashboard
- **WHEN** the dashboard is opened
- **THEN** the "Score increments by result" panel shows "No data"
- **AND** the review of the rename PR catches the drift by inspecting the dashboard

### Requirement: mise tasks manage the observability stack lifecycle

`mise.toml` SHALL define four tasks under the `obs:` prefix: `obs:up` (starts prometheus + grafana), `obs:down` (stops them), `obs:logs` (follows their logs), `obs:reload` (hot-reloads the Prometheus config). The tasks SHALL use the existing `docker compose --profile observability` pattern and SHALL NOT affect the canonical `infra:up` / `infra:down` tasks.

#### Scenario: obs:up starts both containers
- **WHEN** `mise run obs:up` is executed
- **THEN** `docker compose --profile observability up -d prometheus grafana` is run
- **AND** both containers are in the running state

#### Scenario: obs:down stops only the observability services
- **GIVEN** the full stack is running including observability
- **WHEN** `mise run obs:down` is executed
- **THEN** only prometheus and grafana stop
- **AND** postgres, redis, and nats continue running

#### Scenario: obs:reload hot-reloads the Prometheus config
- **GIVEN** a running prometheus container and an edited `infra/local/prometheus/prometheus.yml`
- **WHEN** `mise run obs:reload` is executed
- **THEN** a POST is made to `http://localhost:59090/-/reload`
- **AND** the new config is active without restarting the container
- **AND** the previous in-memory time series are preserved

#### Scenario: obs:logs follows both containers
- **WHEN** `mise run obs:logs` is executed
- **THEN** `docker compose --profile observability logs -f prometheus grafana` runs
- **AND** the terminal streams both containers' stdout

### Requirement: Documentation captures the local-only scope and the DO-NOT-COPY warning

`infra/local/README.md` SHALL document what the local observability stack is, how it's wired, how to edit dashboards, and why the anonymous-admin Grafana config MUST NOT be transferred to production IaC. `README.md` (top-level) SHALL link to `infra/local/README.md` from its operations section with a one-paragraph summary.

#### Scenario: infra/local/README.md contains a prominent DO-NOT-COPY warning
- **WHEN** `infra/local/README.md` is inspected
- **THEN** it contains a section warning that `GF_AUTH_ANONYMOUS_ENABLED=true` and the loopback-only port binding are DEV-ONLY settings
- **AND** the section explicitly instructs operators NOT to copy these settings into `infra/helm/` or any production deployment
- **AND** the warning is formatted to stand out (bold, blockquote, or section header)

#### Scenario: infra/local/README.md documents the dashboard edit workflow
- **WHEN** the README is read
- **THEN** it contains a step-by-step description of: open dashboard → edit in UI → Dashboard Settings → JSON Model → copy → paste into `infra/local/grafana/dashboards/scoreboard-overview.json` → commit
- **AND** it explains that UI edits are lost on container restart

#### Scenario: Top-level README links to infra/local/README.md
- **WHEN** `README.md` is inspected
- **THEN** its operations section contains a paragraph pointing at `infra/local/README.md` as the local observability guide
- **AND** the paragraph summarizes the `mise run obs:up` workflow in one sentence
