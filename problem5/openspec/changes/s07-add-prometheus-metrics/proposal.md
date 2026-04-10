## Why

The service can currently only be observed through logs and a single `/healthz` boolean. That's enough to know "is it up," but not "is it behaving correctly, right now, under real load." At the brief's performance target (10k GET RPS, 100 write RPS), the first sign of trouble will not be a 500 — it will be a 20× latency spike on a single endpoint, or a gradual collapse of the cache hit rate, or the Postgres connection pool silently saturating. None of those show up in logs until users start complaining. They all show up cleanly in metrics.

Prometheus is the industry baseline for this. It's pull-based (no agent to run inside the app), text-format metrics are human-readable over `curl`, the client library is mature, and it integrates with every dashboard tool a reviewer might scrape into (Grafana, Datadog, CloudWatch, Victoria Metrics). Shipping Prometheus metrics also gives Change `s05-add-benchmarks-k6` a second signal alongside the k6 client-side measurements — we can correlate what k6 observes from the outside with what the service observes from the inside.

This change must land before or alongside the benchmark runs, because an observability story that arrives after the numbers is a paper exercise. It must land before production-readiness conversations happen, because every production incident starts with "what are the metrics saying."

## What Changes

- Introduce `prom-client` (the canonical Node.js Prometheus client) as a runtime dependency.
- Introduce a central `MetricsRegistry` module that owns the single `prom-client.Registry` instance, exposes a `collectDefaultMetrics()` call with a service-specific label prefix, and exposes factories for the custom metrics listed below.
- Introduce HTTP instrumentation middleware that records `http_request_duration_seconds` as a histogram with labels `method`, `route` (the Express *route pattern*, not the resolved URL — so `/resources/:id` instead of `/resources/abc-123`), and `status_code`. The same middleware also increments `http_requests_total{method,route,status_code}`.
- Introduce custom cache metrics: `cache_operations_total{operation,result}` counter (`operation` ∈ `get|set|del|incr`, `result` ∈ `hit|miss|error`), `cache_operation_duration_seconds` histogram, and a derived helper for "cache hit rate over the last scrape interval" (computed Prometheus-side, not in the app).
- Introduce custom database metrics: `db_query_duration_seconds{operation}` histogram (`operation` ∈ `select|insert|update|delete`), `db_pool_size{state}` gauge (`state` ∈ `total|idle|waiting`), and `db_query_errors_total{operation,error_class}` counter.
- Introduce custom domain metrics: `resources_operations_total{operation,outcome}` counter (`operation` ∈ `create|read|list|update|delete`, `outcome` ∈ `success|not_found|validation_error|error`).
- Introduce a `GET /metrics` endpoint that returns the registry's text-format output with `Content-Type: text/plain; version=0.0.4; charset=utf-8`.
- Introduce cardinality guards: the `route` label is sourced from `req.route?.path` (Express's matched pattern) so it cannot contain unbounded user input; the `error_class` label is enumerated against a known-classes allowlist; any label value that escapes the allowlist is recorded as `"other"`.
- Introduce a Prometheus scrape target service in `docker-compose.yml` under a `metrics` profile, so a reviewer can run `docker compose --profile metrics up -d` and see metrics flowing into a local Prometheus at `http://localhost:9090`. A minimal `prometheus.yml` scrape config lives in `deploy/prometheus/`.
- Introduce configuration flags: `METRICS_ENABLED` (default `true`) and `METRICS_DEFAULT_METRICS` (default `true`, controls whether `prom-client`'s default Node.js metrics are collected).
- Update `s06-add-architecture-docs` follow-on work: this change's `tasks.md` adds a task to extend `Architecture.md` with a metrics section once that change lands. This change does NOT modify `Architecture.md` directly because it may be landed before or after `s06`.

## Capabilities

### New Capabilities

- `metrics-observability`: The contract for how the service exposes Prometheus metrics, which metrics it publishes, what labels are allowed, and how cardinality is controlled.

### Modified Capabilities

None. The `/metrics` endpoint is additive. The health endpoint continues to live at `/healthz` with the same contract as `s03-add-redis-caching` left it.

## Impact

- **New files**: `src/observability/metrics-registry.ts`, `src/observability/http-metrics.ts` (middleware), `src/observability/cache-metrics.ts`, `src/observability/db-metrics.ts`, `src/observability/domain-metrics.ts`, `src/http/routes/metrics.ts`, `deploy/prometheus/prometheus.yml`.
- **Modified files**: `src/index.ts` (construct `MetricsRegistry` and wire it into the HTTP middleware, the Postgres pool, and the cache layer), `src/http/app.ts` (mount metrics middleware ahead of the router, mount the `/metrics` route), `src/config/env.ts` (`METRICS_ENABLED`, `METRICS_DEFAULT_METRICS`), `src/modules/resources/controller.ts` (increment `resources_operations_total` on each outcome), `src/modules/resources/cached-repository.ts` (increment `cache_operations_total`), `src/db/client.ts` (record `db_query_duration_seconds` via a Kysely plugin), `.env.example`, `docker-compose.yml` (add `prometheus` service under `metrics` profile), `package.json` (add `prom-client`), `README.md` (document `/metrics` and the compose profile).
- **New dependencies**: `prom-client`.
- **APIs exposed**: `GET /metrics` (text format, not JSON). No other endpoints.
- **Systems affected**: A new container (`prometheus`) exists under the `metrics` compose profile. The main stack is unchanged unless the profile is activated.
- **Breaking changes**: None.
