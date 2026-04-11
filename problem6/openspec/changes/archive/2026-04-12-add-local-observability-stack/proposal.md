## Why

problem6 emits Prometheus metrics (`prom-client` is in `package.json`, `/metrics` endpoint is wired via `HealthController`, 8 scoreboard metrics are registered in `src/shared/metrics/write-path-metrics.ts`) but there is no local scraper or dashboard. `docker-compose.yml` contains only postgres, redis, nats, and nats-box — no prometheus, no grafana. The result: metrics exist as a claim backed by unit tests, but no developer has ever watched them update in real time against a running instance. Several concrete consequences fall out of that:

1. **Metric-shape regressions are silent until prod.** If a refactor renames `scoreboard_http_requests_total` or drops a label, there is no local dashboard that immediately breaks — the typecheck passes, tests pass, and the broken name ships. A checked-in Grafana dashboard JSON acts as a de-facto contract: "these metric names and labels exist; renaming them breaks this panel." Renames become visible at review time, not after a prod alert.

2. **The in-flight `restructure-error-handling-for-observability` change adds a new counter** (`scoreboard_errors_total{code, status}`) that has no local way to verify end-to-end emission. The unit tests will show the counter incrementing in isolation; a local Grafana view of the same counter would show the metric flowing all the way through: handler throws → filter catches → counter.inc → /metrics → Prometheus scrape → dashboard panel. That's a ~5-second manual smoke check instead of a guess based on unit tests.

3. **The `add-runtime-resilience-utilities` change's singleflight wiring** is exactly the kind of code where the expected impact is visible in metrics: a reconnect storm should produce N concurrent HTTP requests but only 1 `zrevrange` call. Without a local dashboard, the only way to verify this is to write a dedicated integration test that reaches into ioredis internals. With a local Prometheus + Grafana, you hit the endpoint with hey/k6/curl-loops, then open a dashboard panel and read the counter delta. Much faster iteration loop.

4. **k6 load tests produce threshold results but no correlated dashboard.** step-07 task 7 includes `test/load/scoreboard.k6.ts` with thresholds on `http_req_duration` and a custom `sse_event_latency`. When a threshold fails, the operator sees the k6 terminal output but has no correlated view of what the server was doing at the time — CPU, memory, Redis hit rate, error rate by code. Adding a local Grafana dashboard gives you the "pull up the dashboard for that time window" workflow that every real ops team has.

5. **Dashboard JSON as living spec.** A committed `scoreboard-overview.json` dashboard is easier to read than a metrics table in a markdown file: it shows which metrics the service is built around, what queries make sense on them, and what thresholds the team considers interesting. Future contributors onboarding to the service can boot the local stack and see "oh, these are the things we care about."

None of this is blocking. The IaC stubs in `infra/helm/` already assume Prometheus exists externally in the deployment environment (via ServiceMonitor or Pod annotations), so production observability is still handled — this change adds the **development-time** equivalent. The rough effort is ~2 hours of one-time setup for a permanent benefit.

## What Changes

- **NEW (compose)**: `compose.override.yml` is extended with three new services under a new `observability` profile (so `docker compose up` without `--profile observability` still boots the existing stack unchanged):
    - `prometheus` — image `prom/prometheus:v2.55.0`, mounts `infra/local/prometheus/prometheus.yml` read-only, port `59090:9090` (host port in the 5xxxx range to match the existing port-remap convention).
    - `grafana` — image `grafana/grafana:11.3.0`, mounts `infra/local/grafana/provisioning` and `infra/local/grafana/dashboards` read-only, env vars for anonymous admin + default dashboard, port `53000:3000`.
    - (Optional) `node-exporter` is NOT included — this is a dev stack; host-level metrics are out of scope.
- **NEW (config)**: `infra/local/prometheus/prometheus.yml` — one `scrape_configs` job named `scoreboard-api` targeting the host-network address `host.docker.internal:3000` (so it scrapes the dev server running outside compose via `mise run dev`). Scrape interval 5s. If the operator runs the API inside compose (via a future `mise run docker:run` path), a secondary target `scoreboard-api:3000` resolves via the compose network.
- **NEW (config)**: `infra/local/grafana/provisioning/datasources/prometheus.yml` — Grafana datasource file that points at `http://prometheus:9090` (compose-network DNS). Auto-provisions on Grafana boot.
- **NEW (config)**: `infra/local/grafana/provisioning/dashboards/dashboards.yml` — Grafana dashboard provider config that loads any JSON file under `/var/lib/grafana/dashboards` (mounted from `infra/local/grafana/dashboards/`). Auto-provisions on Grafana boot.
- **NEW (config)**: `infra/local/grafana/dashboards/scoreboard-overview.json` — a checked-in Grafana dashboard JSON with panels for the 8 existing scoreboard metrics plus the planned `scoreboard_errors_total` counter:
    - **HTTP traffic** — `rate(scoreboard_http_requests_total[1m])` by status, `histogram_quantile(0.99, rate(scoreboard_http_request_duration_seconds_bucket[1m]))` by route
    - **Write path** — `rate(scoreboard_score_increment_total[1m])` by result, `rate(scoreboard_action_token_verify_total[1m])` by outcome
    - **Rate limit** — `rate(scoreboard_rate_limit_hits_total[1m])` by outcome, `rate(scoreboard_rate_limit_failed_closed_total[1m])`
    - **Errors** — `rate(scoreboard_errors_total[1m])` by code and status (depends on `restructure-error-handling-for-observability` shipping; panel stays empty until then but doesn't fail)
    - **Process** — `scoreboard_process_start_time_seconds` (uptime), standard `process_cpu_seconds_total` + `process_resident_memory_bytes` from `prom-client`'s default collectors
- **NEW (mise tasks)**:
    - `mise run obs:up` — brings up the `observability` profile (`docker compose --profile observability up -d prometheus grafana`)
    - `mise run obs:down` — `docker compose --profile observability stop prometheus grafana`
    - `mise run obs:logs` — `docker compose --profile observability logs -f prometheus grafana`
    - `mise run obs:reload` — curl POST to `http://localhost:59090/-/reload` for prometheus config hot-reload without restart
- **MODIFIED (docs)**: `README.md` gets a short section under the existing operations docs (~§16 or equivalent) documenting the local observability stack: how to start it, the URLs (prometheus `http://localhost:59090`, grafana `http://localhost:53000` with anonymous admin), what dashboard is preloaded, and the caveat that this is dev-only (the production deployment uses the IaC stubs in `infra/helm/`).
- **NOT CHANGED**: `docker-compose.yml` remains SHA-256-identical (canonical scaffold file per the existing preservation rule). All new services go into `compose.override.yml` under a new profile. `package.json` — no new runtime deps; `prom-client` is already there. No env var changes. No database migration. No test framework changes.

## Capabilities

### New Capabilities

(none — this is a cross-cutting dev-experience change)

### Modified Capabilities

- `scoreboard-observability`: Adds a requirement for a local observability stack that scrapes problem6's `/metrics` endpoint and renders a committed dashboard against it. This is the developer-time counterpart to the existing "metrics are registered and exposed" requirement — same metrics, new scraper + viewer. The operator-configurable production stack is unchanged; this adds a local dev loop.

## Impact

**New files (~350 LOC / config):**
- `infra/local/prometheus/prometheus.yml` — ~30 lines (one scrape job, global config)
- `infra/local/grafana/provisioning/datasources/prometheus.yml` — ~15 lines
- `infra/local/grafana/provisioning/dashboards/dashboards.yml` — ~15 lines
- `infra/local/grafana/dashboards/scoreboard-overview.json` — ~250 lines (Grafana JSON is verbose; ~8 panels)
- `infra/local/README.md` — ~40 lines (what this directory is, how it's wired, how to customize)

**Modified files (~60 LOC):**
- `compose.override.yml` — add 3 new services under `observability` profile (~50 lines)
- `mise.toml` — add 4 tasks (~15 lines)
- `README.md` — add one section (~20 lines)
- `.gitignore` — no changes needed (grafana volumes are unused; we use read-only bind mounts)

**Operational consequences:**
- `docker compose up` (no profile flag) still boots only postgres/redis/nats — no surprise containers. Operators who don't want the observability stack don't see it.
- `mise run obs:up` boots prometheus + grafana in ~5 seconds. Memory footprint ~200MB (~50MB prom, ~150MB grafana).
- Prometheus scrapes `host.docker.internal:3000/metrics` every 5 seconds. On macOS and Windows this is automatic; on Linux the `extra_hosts: ["host.docker.internal:host-gateway"]` directive on the prometheus service makes it work.
- Grafana boots with anonymous admin access — the stack is bound to `127.0.0.1` only, never exposed. No auth setup required. This is explicitly a dev convenience; the `infra/helm/` production stubs do NOT inherit this setting.
- The dashboard JSON is checked in. Edits made in the Grafana UI are NOT persisted across restarts (no volume mount for grafana data) — if the operator wants to save a dashboard edit, they export JSON and commit it. This is deliberate: the repo is the source of truth, not the local grafana database.
- Dashboard file format is Grafana 11.x JSON. If Grafana updates a format breaking change in the future, the dashboard may need re-export; the `infra/local/README.md` notes the tested version.

**No breaking changes:**
- Existing compose commands, mise tasks, and the `/metrics` endpoint are unchanged.
- CI and tests are unaffected — this is pure dev infrastructure.
- The production deployment story in `infra/helm/` is untouched.

**Out of scope:**
- Alert manager / alerting rules. Local dev doesn't need alerting; production is configured externally.
- Loki / log aggregation. Logs are a separate observability concern; this change is metrics-only.
- Tempo / trace storage. The OTel exporter in `tracing.bootstrap.ts` sends to `OTEL_EXPORTER_OTLP_ENDPOINT` when set — adding a local OTLP collector is a separate future change.
- node-exporter or cAdvisor. Host/container metrics are not the developer concern; app metrics are.
- Dashboard variables (dropdowns for route / error code). Keep the dashboard simple until real use surfaces a need.
- Persisting Grafana data across restarts. The JSON file is the source of truth.
- Exposing the local stack outside `127.0.0.1`. Bound to loopback only, intentionally.
