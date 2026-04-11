# metrics-observability

## Purpose

Defines the contract for how the Resources API exposes Prometheus metrics: which metrics it publishes, what labels are allowed, how cardinality is controlled, and how the endpoint is exposed. The goal is that an operator can scrape the service, correlate what the load generator observes from the outside (see `performance-benchmarking`) with what the service observes from the inside, and answer "is it behaving correctly, right now, under real load?" without reading logs.

The design leans on `prom-client` as the canonical Node.js Prometheus client and the industry baseline exposition format. Cardinality discipline is first-class: every label value the service emits comes from a service-controlled allowlist, so a careless label cannot turn a 50-metric registry into a 50,000-series registry. The `/metrics` endpoint sits on the main HTTP port (documented production guidance: bind to an internal interface or run on a separate port) and is gated behind a `METRICS_ENABLED` kill switch so instrumentation cost can be benchmarked in isolation.

## Requirements

### Requirement: Metrics Endpoint

The service SHALL expose `GET /metrics` which returns Prometheus exposition-format text describing the current state of every registered metric. The endpoint SHALL respect the `METRICS_ENABLED` configuration flag and SHALL return a 404 when metrics are disabled.

#### Scenario: Metrics endpoint returns Prometheus text format

- **WHEN** a client issues `GET /metrics` against a running service with `METRICS_ENABLED=true`
- **THEN** the response status is `200 OK`
- **AND** the `Content-Type` is `text/plain; version=0.0.4; charset=utf-8`
- **AND** the response body parses as valid Prometheus exposition format
- **AND** the body contains at least one line for `http_request_duration_seconds`, `http_requests_total`, and `process_cpu_user_seconds_total`

#### Scenario: Metrics endpoint is disabled via flag

- **WHEN** a client issues `GET /metrics` against a service started with `METRICS_ENABLED=false`
- **THEN** the response status is `404 Not Found`
- **AND** no metric collection runs in the background

#### Scenario: Metrics endpoint excludes the scraper's own request

- **WHEN** Prometheus scrapes `/metrics`
- **THEN** the request itself is NOT recorded in `http_request_duration_seconds`
- **AND** the next scrape does not show the previous scrape's own contribution

### Requirement: HTTP Request Duration Histogram

The service SHALL record every inbound HTTP request as an observation in a `http_request_duration_seconds` histogram labeled by `method`, `route` (Express matched route pattern, sub-router mount point prefix included), and `status_code`.

#### Scenario: Successful GET on a matched route

- **WHEN** a client calls `GET /resources/{id}` and the server returns `200 OK`
- **THEN** the histogram records one observation with labels `method="GET"`, `route="/resources/:id"`, `status_code="200"`
- **AND** the observed value is the request duration in seconds

#### Scenario: Request that does not match any route

- **WHEN** a client calls `GET /nonexistent`
- **THEN** the histogram records one observation with `route="__unmatched"` (a constant sentinel), not the raw URL
- **AND** the label cardinality contribution is bounded regardless of how many distinct unmatched URLs are requested

#### Scenario: Request that fails inside a handler

- **WHEN** a request handler throws and the error handler returns `500 Internal Server Error`
- **THEN** the histogram records the observation with `status_code="500"`
- **AND** the observation is recorded exactly once (not duplicated by the error middleware)

### Requirement: HTTP Request Counter

The service SHALL increment `http_requests_total{method,route,status_code}` for every request, regardless of success or failure, using the same label set as the duration histogram.

#### Scenario: Counter increments per request

- **WHEN** N sequential requests are issued to the same `(method, route, status_code)` combination
- **THEN** `http_requests_total{...}` for that combination increases by exactly N

#### Scenario: Counter labels match histogram labels

- **WHEN** the two metrics are queried
- **THEN** the label sets are identical so a Prometheus user can compute `rate(http_request_duration_seconds_count[1m])` and `rate(http_requests_total[1m])` and get the same value

### Requirement: Cache Operation Metrics

The cached repository layer SHALL emit a counter `cache_operations_total{operation,result}` and a histogram `cache_operation_duration_seconds{operation}` for every interaction with Redis. The `operation` label is drawn from `{get, set, del, incr}` and the `result` label from `{hit, miss, error}`.

#### Scenario: Successful cache hit on detail read

- **WHEN** `GET /resources/{id}` is served from the cache
- **THEN** `cache_operations_total{operation="get",result="hit"}` increases by 1
- **AND** `cache_operation_duration_seconds{operation="get"}` records the Redis round-trip time

#### Scenario: Cache miss on detail read

- **WHEN** `GET /resources/{id}` misses the cache and falls through to Postgres
- **THEN** `cache_operations_total{operation="get",result="miss"}` increases by 1
- **AND** `cache_operations_total{operation="set",result="hit"}` increases by 1 (for the populate-on-miss write)

#### Scenario: Write invalidates cache

- **WHEN** a successful `PATCH /resources/{id}` is processed
- **THEN** `cache_operations_total{operation="del",result="hit"}` increases by 1 (the detail key deletion)
- **AND** `cache_operations_total{operation="incr",result="hit"}` increases by 1 (the list version bump)

#### Scenario: Redis is unreachable during a cache operation

- **WHEN** a cache operation fails because Redis is down
- **THEN** `cache_operations_total{operation="...",result="error"}` increases by 1
- **AND** the error label does not leak the exception message as a label value
- **AND** the request still succeeds via the Postgres fallback path

### Requirement: Database Metrics

The data access layer SHALL emit `db_query_duration_seconds{operation}` histogram, `db_pool_size{state}` gauge, and `db_query_errors_total{operation,error_class}` counter. The `operation` label for query metrics is drawn from `{select, insert, update, delete}` (non-CRUD root operation nodes are skipped). The `state` label for the pool gauge is drawn from `{total, idle, waiting}`, which matches the three fields exposed by `pg.Pool` — there is no synthetic `active` state.

#### Scenario: SELECT query records duration

- **WHEN** the repository issues a SELECT (for example during `GET /resources/{id}` on a cache miss)
- **THEN** `db_query_duration_seconds{operation="select"}` records one observation
- **AND** the recorded value includes the full SQL round-trip including network time

#### Scenario: Insert records duration

- **WHEN** the repository issues an INSERT (for `POST /resources`)
- **THEN** `db_query_duration_seconds{operation="insert"}` records one observation
- **AND** `db_pool_size` is a registered gauge with label values drawn from the `{total, idle, waiting}` allowlist, sampled every 5 seconds by a background collector

#### Scenario: Database error is recorded

- **WHEN** a Postgres error occurs (for example a unique constraint violation)
- **THEN** `db_query_errors_total{operation="insert",error_class="unique_violation"}` increases by 1
- **AND** the `error_class` label is drawn from a fixed allowlist of Postgres error classes; any other error class is recorded as `"other"`

### Requirement: Domain Metrics

The service SHALL emit a counter `resources_operations_total{operation,outcome}` for every successful or failed CRUD operation at the domain layer. The `operation` label is drawn from `{create, read, list, update, delete}` and the `outcome` label from `{success, not_found, validation_error, error}`.

#### Scenario: Successful create

- **WHEN** a client successfully creates a resource via `POST /resources`
- **THEN** `resources_operations_total{operation="create",outcome="success"}` increases by 1

#### Scenario: Get for unknown id

- **WHEN** a client calls `GET /resources/{id}` for an id that does not exist
- **THEN** `resources_operations_total{operation="read",outcome="not_found"}` increases by 1
- **AND** `http_requests_total{method="GET",route="/resources/:id",status_code="404"}` also increases by 1 (both metrics co-exist; one is domain-scoped, the other is HTTP-scoped)

#### Scenario: List operation

- **WHEN** a client calls `GET /resources` with any filter combination
- **THEN** `resources_operations_total{operation="list",outcome="success"}` increases by 1 on success

### Requirement: Default Node.js Metrics

The service SHALL collect default Node.js runtime metrics (CPU, resident memory, heap, event loop lag, garbage collection, open file descriptors) via `prom-client.collectDefaultMetrics` when `METRICS_DEFAULT_METRICS` is `true`.

#### Scenario: Default metrics are present in output

- **WHEN** `GET /metrics` is called on a running service with the default flag enabled
- **THEN** the response body contains `process_cpu_user_seconds_total`, `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, and `nodejs_eventloop_lag_seconds`

#### Scenario: Default metrics can be disabled

- **WHEN** the service is started with `METRICS_DEFAULT_METRICS=false`
- **THEN** the response body contains only custom metrics and no `process_*` or `nodejs_*` series

### Requirement: Cardinality Guards on Labels

Metric label values SHALL be drawn from a bounded set controlled by the service; request-supplied values (URL paths, header values, error messages) SHALL NOT become label values directly. Unrecognized values SHALL be collapsed to a sentinel like `"other"` or `"__unmatched"`.

#### Scenario: Path parameter is not used as a label value

- **WHEN** a client issues thousands of requests to `GET /resources/{different-uuid}`
- **THEN** the `route` label for all of them is `/resources/:id`, not the resolved URL
- **AND** the cardinality of `http_request_duration_seconds` remains bounded by the number of routes times methods times HTTP status codes

#### Scenario: Unknown error class is collapsed

- **WHEN** a Postgres error occurs with an unrecognized class
- **THEN** `db_query_errors_total{error_class="other"}` is incremented instead of creating a new series for the novel error string

### Requirement: Configuration Flags

The service SHALL accept `METRICS_ENABLED` (boolean, default `true`) and `METRICS_DEFAULT_METRICS` (boolean, default `true`) via the configuration loader, and SHALL refuse to start if either is set to a non-boolean value.

#### Scenario: Default configuration collects everything

- **WHEN** the service starts without setting either flag
- **THEN** metrics collection is enabled AND default Node.js metrics are collected

#### Scenario: Custom metrics only

- **WHEN** the service starts with `METRICS_ENABLED=true` and `METRICS_DEFAULT_METRICS=false`
- **THEN** custom metrics are collected and exposed
- **AND** default Node.js metrics are NOT collected
