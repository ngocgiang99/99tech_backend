## 1. Dependency and Configuration

- [ ] 1.1 Add runtime dependency `prom-client` and regenerate `pnpm-lock.yaml`
- [ ] 1.2 Verify transitive dependency footprint with `pnpm why prom-client` and confirm it stays at `prom-client` + `tdigest`
- [ ] 1.3 Extend `src/config/env.ts` with `METRICS_ENABLED` (boolean, default `true`) and `METRICS_DEFAULT_METRICS` (boolean, default `true`); update Zod schema to coerce from `"true"`/`"false"` strings
- [ ] 1.4 Update `.env.example` with both new variables and their defaults

## 2. Metrics Registry Module

- [ ] 2.1 Create `src/observability/metrics-registry.ts` exporting a `MetricsRegistry` class that holds a single `prom-client.Registry` instance
- [ ] 2.2 In `MetricsRegistry`, expose factories for: `httpRequestDurationSeconds` (Histogram), `httpRequestsTotal` (Counter), `cacheOperationsTotal` (Counter), `cacheOperationDurationSeconds` (Histogram), `dbQueryDurationSeconds` (Histogram), `dbPoolSize` (Gauge), `dbQueryErrorsTotal` (Counter), `resourcesOperationsTotal` (Counter)
- [ ] 2.3 Encode label name allowlists as `as const` tuples so a reviewer can grep the valid label sets
- [ ] 2.4 Add `collectDefaultMetrics()` toggled by `METRICS_DEFAULT_METRICS`
- [ ] 2.5 Expose `render(): Promise<string>` that serializes the registry to Prometheus text format

## 3. HTTP Instrumentation Middleware

- [ ] 3.1 Create `src/observability/http-metrics.ts` exporting `createHttpMetricsMiddleware(registry)` that returns an Express middleware
- [ ] 3.2 The middleware records a `process.hrtime.bigint()` timestamp on request entry, attaches a `res.on("finish")` listener, and on finish computes the duration in seconds and observes the histogram + increments the counter
- [ ] 3.3 The `route` label is derived from `req.route?.path ?? "__unmatched"`, NOT from `req.originalUrl`
- [ ] 3.4 The `status_code` label is derived from `res.statusCode` as a string (not a number) so it joins correctly with other labels
- [ ] 3.5 The middleware skips `/metrics` itself (so scrape requests are not reflected in the HTTP histogram)

## 4. Cache Instrumentation

- [ ] 4.1 Modify `CachedResourceRepository` constructor to accept a `MetricsRegistry`
- [ ] 4.2 Around every `GET` to Redis, record `cache_operations_total{operation="get",result="hit"|"miss"|"error"}` and `cache_operation_duration_seconds{operation="get"}`
- [ ] 4.3 Around every `SET` to Redis, record `cache_operations_total{operation="set"}` (result always `hit` on success, `error` on failure)
- [ ] 4.4 Around every `DEL` to Redis, record `cache_operations_total{operation="del"}`
- [ ] 4.5 Around every `INCR` (list version bump), record `cache_operations_total{operation="incr"}`
- [ ] 4.6 Verify cache metrics update correctly via a unit test (mocked registry) that asserts counter call counts for each scenario

## 5. Database Instrumentation

- [ ] 5.1 Create `src/observability/kysely-metrics-plugin.ts` implementing Kysely's `KyselyPlugin` interface with `transformQuery` (start timer) and `transformResult` (stop timer, observe histogram)
- [ ] 5.2 Map the query node's `kind` to the `operation` label: `SelectQueryNode` → `select`, `InsertQueryNode` → `insert`, `UpdateQueryNode` → `update`, `DeleteQueryNode` → `delete`
- [ ] 5.3 On query error, increment `db_query_errors_total{operation, error_class}` using the `error_class_allowlist` set (translate pg error codes to named classes: `23505` → `unique_violation`, `23502` → `not_null_violation`, `40P01` → `deadlock`, etc.); unknown codes map to `"other"`
- [ ] 5.4 Register the plugin on the Kysely client in `src/db/client.ts`
- [ ] 5.5 Create `src/observability/db-pool-gauge.ts` that starts a `setInterval` (5s) reading `pool.totalCount`, `pool.idleCount`, `pool.waitingCount` and updating the `db_pool_size` gauge; expose a `stop()` method for the shutdown hook

## 6. Domain Instrumentation

- [ ] 6.1 Modify `src/modules/resources/controller.ts` to accept a `MetricsRegistry`
- [ ] 6.2 In each controller method, increment `resources_operations_total{operation, outcome}` on success, validation error, not-found, and unexpected error branches
- [ ] 6.3 Add unit tests asserting each outcome branch increments the expected counter

## 7. /metrics Route

- [ ] 7.1 Create `src/http/routes/metrics.ts` exporting a router that handles `GET /metrics`, calls `registry.render()`, and responds with `Content-Type: text/plain; version=0.0.4; charset=utf-8`
- [ ] 7.2 When `METRICS_ENABLED=false`, do not mount the route (rather than mounting a 404 handler)
- [ ] 7.3 Mount the route in `src/http/app.ts` before the resources router so it takes priority

## 8. Wiring

- [ ] 8.1 In `src/index.ts` (or the `createApp(deps)` factory from `s04-add-test-suite`), construct the `MetricsRegistry`, pass it to the HTTP middleware, the cached repository, the Kysely plugin, and the controller
- [ ] 8.2 Push `metricsRegistry.clear()` and `dbPoolGauge.stop()` onto the shutdown hook list
- [ ] 8.3 Verify `pnpm dev` still starts cleanly and `curl /metrics` returns valid Prometheus text

## 9. Docker Compose Profile

- [ ] 9.1 Add a `prometheus` service to `docker-compose.yml` under `profiles: [metrics]` using the `prom/prometheus:latest` image (or a pinned version)
- [ ] 9.2 Create `deploy/prometheus/prometheus.yml` with a single `scrape_configs` job targeting `api:${PORT}/metrics` at 5-second interval
- [ ] 9.3 Mount `deploy/prometheus/prometheus.yml` into the container as a read-only bind volume
- [ ] 9.4 Create a named volume `prometheus-data` so scrape history survives compose restarts
- [ ] 9.5 Expose Prometheus UI on `http://localhost:9090`
- [ ] 9.6 Verify `docker compose --profile metrics up -d` brings up all four containers and the Prometheus UI shows `api` as an `UP` target

## 10. Tests (Follow-Up Hooks into s04-add-test-suite)

- [ ] 10.1 Add `tests/unit/observability/metrics-registry.test.ts` verifying each metric factory produces the right name, labels, and type
- [ ] 10.2 Add `tests/unit/observability/http-metrics.test.ts` verifying the middleware records the matched route pattern, not the raw URL
- [ ] 10.3 Add `tests/integration/metrics.test.ts` that issues a handful of requests against the test app and `curl`s `/metrics`, asserting the expected metric series appear and the counters have plausible values
- [ ] 10.4 Add a cardinality assertion test that makes N requests to different UUIDs on `/resources/:id` and asserts the resulting `http_request_duration_seconds` series count is bounded (does NOT scale with N)

## 11. README Polish

- [ ] 11.1 Add an "Observability" section to `README.md` documenting `/metrics`, the `METRICS_ENABLED` flag, the compose `metrics` profile, and a one-liner for querying Prometheus
- [ ] 11.2 Document the production consideration: bind `/metrics` to an internal interface, firewall it, or run it on a separate port
- [ ] 11.3 Add a short PromQL cheat sheet (3–5 example queries) for common questions: cache hit rate, p99 latency per route, error rate, DB pool utilization

## 12. Architecture.md Follow-Up (cross-change)

- [ ] 12.1 Add a task note to `s06-add-architecture-docs/tasks.md` (if not already landed) to extend `Architecture.md` with a "Metrics" section documenting the metric catalog, or if `s06` has landed, directly extend `Architecture.md` in this change
- [ ] 12.2 Update the container diagram in `Architecture.md` with the `MetricsRegistry` and the `/metrics` endpoint

## 13. Validation

- [ ] 13.1 Run `pnpm check` and confirm lint + typecheck pass
- [ ] 13.2 Run `pnpm test` and confirm both unit and integration layers pass
- [ ] 13.3 Start the stack, curl `/metrics`, and confirm the output parses as valid Prometheus text (use `promtool check metrics` or `promtool parse`)
- [ ] 13.4 Run `pnpm bench:smoke` and verify the metrics endpoint shows non-zero counters afterwards
- [ ] 13.5 Run `openspec validate s07-add-prometheus-metrics` and confirm zero errors
