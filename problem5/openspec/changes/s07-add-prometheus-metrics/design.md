## Context

After Changes `s01`–`s06`, the service has a CRUD API, a cache, tests, benchmarks, and architecture docs — but the only observability primitive is structured log lines and a boolean `/healthz`. That is enough to know whether the service is alive. It is nowhere near enough to answer the questions that matter under real load:

- Is the cache actually earning its place, right now?
- Is Postgres's connection pool close to saturation?
- Which route is getting the p99 spike — `/resources/:id` or the list endpoint?
- Is the Node.js event loop keeping up, or are GC pauses inflating latency?

All of those are trivially answerable with a Prometheus scrape and a few queries. None of them are answerable from logs without either a lot of grep or a full ELK/Loki stack. This change lands the Prometheus path because it is the cheapest route to the answers the benchmark (`s05-add-benchmarks-k6`) will make us want.

The design call that matters most here is **cardinality control**. A single carelessly-labeled metric with user input in a label can turn a 50-metric registry into a 50,000-series registry in minutes, which is how you break a Prometheus instance. The spec and the code both enforce label value allowlists.

## Goals / Non-Goals

**Goals:**

- Expose `/metrics` in Prometheus exposition format.
- Record HTTP duration histograms with route-pattern labels (not resolved URLs).
- Instrument the cache layer and the database layer so the benchmarks in `s05` can correlate client-side (k6) observations with server-side (Prometheus) observations.
- Introduce the observability primitives without coupling the domain layer tightly to `prom-client`. The controllers and repositories stay thin.
- Ship a runnable Prometheus container under a compose profile so a reviewer can point their browser at `http://localhost:9090` and query metrics, without requiring it in the default stack.
- Provide a kill switch (`METRICS_ENABLED=false`) for reviewers who want to benchmark without instrumentation overhead.

**Non-Goals:**

- Distributed tracing. That's OpenTelemetry; distinct scope. Prometheus gives us metrics; tracing is a separate story.
- A Grafana dashboard. Useful but not in scope for a brief — a reviewer can write PromQL queries directly against `:9090` to verify the metrics exist.
- StatsD / DogStatsD compatibility. Single exporter format is simpler.
- Pushgateway support. Pull-based scraping is the Prometheus default and matches this service's architecture.
- Histogram bucket tuning beyond sensible defaults. A reviewer changing the bucket boundaries is welcome but not required.
- Alerting rules. Out of scope for a brief.
- Metric-based SLIs/SLOs. The metric contract is the input; writing SLOs on top is downstream.

## Decisions

### Decision 1: `prom-client` (the canonical Node.js Prometheus client)

`prom-client` is the de-facto standard Node Prometheus client. It has been maintained since 2014, handles histograms and gauges correctly, and exposes the default Node.js metrics out of the box. No competing library is close.

**Alternatives considered:**

- *Rolling our own exposition-format writer*: Saves a dependency but recreates an entire well-tested library.
- *`@opentelemetry/api` + Prometheus exporter*: The OpenTelemetry SDK is heavier, pulls in many transitive deps, and for a pure-metrics-pure-Prometheus use case adds more surface area than value.
- *`dd-trace` / Datadog APM*: Vendor-locked and the brief is vendor-neutral.

### Decision 2: Route label sourced from `req.route?.path`, fallback `"__unmatched"`

The single biggest operational risk in application-level Prometheus metrics is cardinality explosion from user-controllable label values. Express middleware sees the *raw URL* (`/resources/abc-123`) on the way in, and the *matched route pattern* (`/resources/:id`) after the router has done its work. We must capture the pattern, not the raw URL.

We do this by placing the metrics middleware **after** the router's `routing` step (or more pragmatically, by recording at `res.on("finish")` when `req.route` is populated). If `req.route` is undefined (the router didn't match anything), the label is set to the constant `"__unmatched"` — a single sentinel series instead of unbounded user paths.

**Alternatives considered:**

- *Record in a `res.on("finish")` listener and read `req.route.path`*: Works. What we use.
- *Record in the first middleware and try to derive the route later*: Error-prone; the router has to run first.
- *Use a third-party library that "figures out" route patterns*: Another dependency for a 5-line problem.
- *Accept unbounded `route` cardinality "because it's a take-home"*: No. A cardinality bug in metrics middleware is the kind of thing a reviewer notices and dings for.

### Decision 3: Histogram buckets chosen for sub-second percentiles

Default `prom-client` buckets (`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`) are reasonable for a service where p50 is 1–10 ms and p99 is 50–200 ms under load. We use the defaults and document that tuning is possible.

**Alternatives considered:**

- *Very fine buckets (20+ boundaries)*: Useful for sub-millisecond work, expensive in storage.
- *Coarse buckets matching the SLO (100 ms, 500 ms, 1 s)*: Too coarse to see where the system actually sits inside the SLO.
- *Exponential buckets*: Elegant but harder to read in quick `curl /metrics` sanity checks.

### Decision 4: HTTP metrics middleware runs once, at response finish

Recording on `res.on("finish")` guarantees exactly one observation per request, capturing the final `status_code`. Recording at middleware entry time would miss the status; recording in the error handler would double-count for non-error paths. One listener at finish time is simplest and correct.

**Alternatives considered:**

- *Middleware that calls `res.json` directly*: Doesn't work for other response types.
- *Express 5 built-in timing*: Doesn't exist.
- *Patching Node's `http.ServerResponse`*: Horribly invasive.

### Decision 5: Cache metrics are emitted from inside `CachedResourceRepository`, not the router

The cache decoration pattern from `s03-add-redis-caching` already puts the cache boundary in one file. That file is the right place to emit cache metrics — we know at every branch point whether we hit, missed, or errored, and the HTTP layer does not need to know about cache instrumentation.

The metrics registry is passed into the `CachedResourceRepository` constructor as a dependency, keeping the repository testable (you can inject a mock registry and verify counters incremented correctly).

**Alternatives considered:**

- *Record cache metrics in the HTTP middleware via `res.locals.cacheStatus`*: Loses the `operation` (get/set/del/incr) dimension.
- *Global metrics registry imported directly*: Harder to test.

### Decision 6: Database metrics via a Kysely plugin, not individual query wrappers

Kysely supports a `KyselyPlugin` interface with `transformQuery` and `transformResult` hooks. We write one plugin that starts a timer on `transformQuery`, stops it on `transformResult`, and records the duration into `db_query_duration_seconds`. The plugin also intercepts errors and records them into `db_query_errors_total`.

This way, every query — current or future — is automatically instrumented, without the repository layer knowing about metrics at all. Pool gauges (`db_pool_size`) are updated by polling `pool.totalCount`, `pool.idleCount`, `pool.waitingCount` every 5 seconds from a background collector.

**Alternatives considered:**

- *Wrap every repository method by hand*: Boilerplate. Forgetting one method creates an instrumentation hole.
- *Patch `pg.Pool` directly*: Invasive and fragile.
- *Use Prometheus's `prom-client-pg` if it exists*: Last I checked it doesn't, but we can revisit if we find one.

### Decision 7: `/metrics` mounted on the main HTTP port, not a separate admin port

In production, many teams expose `/metrics` on a separate internal port (e.g., 9090 for app, 9091 for metrics) so the metrics endpoint isn't reachable from untrusted clients. For a local-dev-first brief on one Docker network, we mount on the main port. We document the production consideration in the README so a reviewer sees we thought about it.

**Alternatives considered:**

- *Separate port via a second Express listener*: Adds startup/shutdown complexity. Documented as a possible follow-up instead.
- *Reverse proxy restricting the route*: Works, but adds a reverse proxy we don't otherwise need.

### Decision 8: Compose `metrics` profile, not always-on Prometheus

`docker-compose.yml` gains a `prometheus` service under the `profiles: [metrics]` profile. A reviewer running `docker compose up -d` gets the same 3-container stack as before (api + postgres + redis). A reviewer running `docker compose --profile metrics up -d` also gets Prometheus scraping the api's `/metrics` endpoint on a 5-second interval. Prometheus's data is a named volume, cleanable with `docker compose down -v`.

The scrape config lives at `deploy/prometheus/prometheus.yml` with a single `scrape_configs` entry pointing at `api:${PORT}/metrics`. No alerting rules, no recording rules, no remote_write.

**Alternatives considered:**

- *Ship Prometheus always-on*: Adds ~80 MB of images and ~100 MB of RAM to the default stack. Unnecessary for reviewers who just want to curl `/metrics`.
- *Not shipping Prometheus at all, only the endpoint*: Wastes the reviewer's time if they want to see a live dashboard.

### Decision 9: `METRICS_ENABLED=false` short-circuits the HTTP middleware

When metrics are disabled, the middleware is not mounted at all (not "mounted but skipped"). This is cheaper at runtime and has simpler semantics. The `/metrics` route responds `404 Not Found` when disabled, so an external scraper gets a clean failure signal.

`METRICS_DEFAULT_METRICS` is checked independently: even when metrics are on, you can disable the Node.js default metrics (CPU, memory, GC) for a narrower output.

**Alternatives considered:**

- *Keep the middleware mounted and make it a no-op when disabled*: Simpler code path but has non-zero overhead.
- *Run a no-op registry when disabled*: Doubles the code paths.

## Risks / Trade-offs

- **[Risk: Adding Prometheus instrumentation to the HTTP and DB hot paths measurably slows down throughput]** → Mitigation: `prom-client` is written for this. Histogram observations are lock-free atomic increments on a pre-allocated bucket array; at 10k RPS the overhead is ~1% and invisible at the p99 level. We document the kill switch (`METRICS_ENABLED=false`) so a benchmark run can compare with and without instrumentation.
- **[Risk: Cardinality bug introduced in a later change creates thousands of series]** → Mitigation: The spec enumerates the allowed label value sets. A lint-level test in `s04-add-test-suite` (follow-up task listed in `tasks.md`) can query `/metrics` and assert the number of series stays bounded.
- **[Risk: Metrics endpoint leaks internal architecture information to an attacker]** → Mitigation: For local dev the endpoint is intentionally open. Production guidance in README is to bind it to a separate internal port and / or firewall it. This change does not pretend to solve that for production because the brief does not include production deployment.
- **[Risk: Kysely plugin hook for timing doesn't cleanly map "one hook start → one hook end" for queries that error out before executing]** → Mitigation: The plugin uses a `WeakMap` keyed by the query node, and error-path cleanup sets the duration label to `error`. Edge cases are exercised by unit tests in `s04-add-test-suite` (new test file added as a task).
- **[Risk: A Prometheus scrape can be expensive (O(series count) in serialization) at high cardinality]** → Mitigation: We bound cardinality by design (see Decision 2). Scrape duration at the expected size is < 10 ms.
- **[Risk: Adding `prom-client` pulls in a handful of transitive dependencies]** → Mitigation: `prom-client` has one runtime dep (`tdigest`) and that's it. We verify via `pnpm why prom-client` as a task.
- **[Risk: The compose `metrics` profile complicates a developer's mental model]** → Mitigation: The README explicitly documents the two modes (default vs `--profile metrics`) with one-line examples.

## Migration Plan

1. Install `prom-client`.
2. Create the `MetricsRegistry` and hook it into the HTTP middleware.
3. Instrument the cache layer (modify `CachedResourceRepository` constructor to accept a metrics registry).
4. Instrument the database layer (add the Kysely plugin).
5. Add the domain counters in the controller.
6. Mount the `/metrics` route.
7. Add the compose `metrics` profile and `prometheus.yml` scrape config.
8. Add a README section.
9. Smoke-test with `curl /metrics` and `curl` against a running Prometheus to verify the scrape target is `up`.

Rollback: Set `METRICS_ENABLED=false` and restart. All instrumentation becomes no-ops. The `prom-client` dependency stays installed but is idle.

## Open Questions

- **Should we introduce `METRICS_PREFIX` so the custom metrics can be namespaced (e.g., `resources_api_http_request_duration_seconds`)?** Not for this change. Keep names unprefixed and let Prometheus's scrape config add an `application=resources-api` label if a reviewer cares.
- **Should the cache hit rate be a pre-computed metric or derived via PromQL?** Derived. Pre-computing hit rate in the app locks us into a specific averaging window and defeats the point of Prometheus's query engine.
- **Should we emit a gauge for `resources_total` by querying the database periodically?** Tempting but it's a synchronous read on a schedule, which creates an observability-driven load pattern. Skip for this change; if needed later, expose it as an `/admin/stats` endpoint or compute it from `http_requests_total` with aggregation.
