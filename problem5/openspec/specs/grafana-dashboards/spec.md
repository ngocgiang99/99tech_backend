# grafana-dashboards

## Purpose

Defines how the Resources API exposes an operator-facing visualization layer on top of the Prometheus metric contract published by the `metrics-observability` capability. Covers the Grafana container's compose wiring, file-based auto-provisioning of the Prometheus datasource and the single `Resources API` dashboard, anonymous read-only access for local-dev ergonomics, and the exact set of panels that ship with the dashboard (request rate, latency percentile selected via a dashboard variable, 5xx error rate, cache hit rate, cache operations breakdown, DB query duration percentile, DB pool utilization, and Node.js runtime health).

The design is deliberately narrow: one container under an opt-in compose profile, one datasource, one dashboard, one JSON file. No alerting, no multi-org, no custom plugins, no Grafana Cloud, no SSO. The Grafana image is pinned to a specific minor version so the dashboard JSON's `schemaVersion` stays compatible, and the dashboard JSON is hand-authored (not UI-exported) so diffs are reviewable line by line. Interactive edits via the UI are intentionally not persisted back to the committed JSON — operators who want to evolve the dashboard edit `deploy/grafana/dashboards/resources-api.json` and restart the container.

## Requirements

### Requirement: Grafana Container Under Metrics Profile

The service's `docker-compose.yml` SHALL define a `grafana` service attached to the existing `metrics` profile, pinned to a specific Grafana image version, depending on the `prometheus` service, and publishing its HTTP UI on a host port configurable via the `GRAFANA_PORT` environment variable (default `3300`, chosen so it does not collide with the Resources API dev server which binds host port `3000`). Grafana's in-container port is always `3000`; only the host mapping is configurable.

#### Scenario: Default stack does not include Grafana

- **WHEN** a developer runs `docker compose up -d` without any profile flag
- **THEN** only the `api`, `postgres`, and `redis` containers start
- **AND** no `grafana` container is created
- **AND** no host port 3300 is bound

#### Scenario: Metrics profile brings up the observability stack

- **WHEN** a developer runs `docker compose --profile metrics up -d`
- **THEN** the `api`, `postgres`, `redis`, `prometheus`, and `grafana` containers all start
- **AND** the `grafana` container is reachable at `http://localhost:3300`
- **AND** the `grafana` container image is pinned to `grafana/grafana:10.4.3` (or whatever version the change commits; the point is that an operator can read the pinned tag in `docker-compose.yml` and reproduce it)
- **AND** the host port 3000 is NOT bound by Grafana (it remains available for the Resources API dev server)

#### Scenario: Host port is configurable

- **WHEN** a developer sets `GRAFANA_PORT=3400` in `.env` and runs `docker compose --profile metrics up -d`
- **THEN** Grafana is reachable at `http://localhost:3400`
- **AND** the default value of `GRAFANA_PORT` when unset is `3300`

### Requirement: Anonymous Read-Only Access

Grafana SHALL be configured to allow anonymous users to view dashboards with the `Viewer` role, so an operator can land directly on the dashboard without authenticating. The `admin` account SHALL remain available for interactive editing with the default credentials `admin / admin`.

#### Scenario: Anonymous viewer can see the dashboard

- **WHEN** an operator opens `http://localhost:3300/d/resources-api/resources-api` in an incognito window
- **THEN** the dashboard renders without prompting for login
- **AND** the sidebar shows a "Sign in" option but does not require it
- **AND** the operator cannot edit or save panels as an anonymous user (read-only)

#### Scenario: Admin can log in interactively

- **WHEN** an operator clicks "Sign in" and submits `admin / admin`
- **THEN** Grafana accepts the credentials
- **AND** prompts for a password change (which can be skipped or satisfied without affecting provisioned content)
- **AND** the operator can interactively edit panels (changes persist in the data volume but do not modify the provisioned JSON file)

### Requirement: Prometheus Datasource Auto-Provisioning

Grafana SHALL be configured via file-based provisioning to automatically create a Prometheus datasource named `Prometheus` on container startup, pointing at `http://prometheus:9090` on the internal Docker network, marked as the default datasource, and with no manual setup required. The datasource SHALL have a stable, file-pinned `uid: prometheus` so dashboard panel queries that reference `datasource.uid: "prometheus"` resolve on every startup (including after `docker compose down -v`).

#### Scenario: Datasource exists on first startup

- **WHEN** the Grafana container starts for the first time (empty data volume)
- **THEN** a datasource named `Prometheus` is visible at `http://localhost:3300/connections/datasources`
- **AND** the datasource URL is `http://prometheus:9090`
- **AND** the datasource is marked as the default
- **AND** the datasource `uid` is exactly `prometheus` (file-pinned, NOT the auto-generated 16-char ID Grafana would otherwise assign)
- **AND** panel queries referencing `datasource.uid: "prometheus"` resolve successfully against the auto-provisioned datasource

#### Scenario: Datasource health check succeeds after Prometheus is up

- **WHEN** both `prometheus` and `grafana` containers are healthy
- **THEN** clicking "Test" on the Prometheus datasource in Grafana's UI returns a success message
- **AND** PromQL queries against the datasource return data from the running `api` service

#### Scenario: Datasource is re-provisioned after volume wipe

- **WHEN** an operator runs `docker compose --profile metrics down -v` and then `docker compose --profile metrics up -d`
- **THEN** the Prometheus datasource is recreated identically on startup
- **AND** no manual reconfiguration is required

### Requirement: Resources API Dashboard Auto-Provisioning

Grafana SHALL be configured to load dashboards from a provisioning directory on startup, and the repository SHALL include exactly one dashboard named `Resources API` with a fixed UID so it is stably addressable via URL.

#### Scenario: Dashboard is visible on first startup

- **WHEN** the Grafana container starts for the first time
- **THEN** a dashboard named `Resources API` is visible at `http://localhost:3300/dashboards`
- **AND** the dashboard has a stable UID (e.g., `resources-api`) so its URL is predictable
- **AND** the dashboard cannot be deleted via the UI (Grafana's "provisioned dashboard" protection)

#### Scenario: Dashboard reloads from JSON on container restart

- **WHEN** an operator interactively edits a panel via the UI, then restarts the Grafana container
- **THEN** the dashboard reverts to the state defined in the committed JSON file
- **AND** the operator's edits are discarded (Grafana's canonical provisioning behavior)

### Requirement: HTTP Request Rate Panel

The `Resources API` dashboard SHALL include a time-series panel titled "Request Rate by Route" that displays per-route HTTP request rate over time.

#### Scenario: Panel query uses http_requests_total

- **WHEN** the panel is inspected
- **THEN** its query expression is `sum(rate(http_requests_total[1m])) by (route)`
- **AND** the legend is templated as `{{route}}`
- **AND** the unit is `reqps` (requests per second) or equivalent

#### Scenario: Panel renders data during a benchmark run

- **WHEN** the service is receiving traffic and Grafana's time range is set to the last 15 minutes
- **THEN** the panel shows one line per active route
- **AND** the y-axis values are non-zero

### Requirement: HTTP Latency Percentiles Panel

The dashboard SHALL include a time-series panel titled `Latency by Route (${percentile})` showing one latency percentile line per route, where the percentile is selected via a dashboard variable `percentile` whose options are `p50 / p95 / p99` (default `p95`). The query targets the `http_request_duration_seconds_bucket` histogram grouped by route.

#### Scenario: Panel computes the selected percentile per route

- **WHEN** the panel is inspected with the default `percentile` variable value (`p95` → `0.95`)
- **THEN** it has one query target with expression `histogram_quantile($percentile, sum(rate(http_request_duration_seconds_bucket[1m])) by (le, route))`
- **AND** the target legend is templated as `{{route}}` (one line per route, no per-percentile suffix)
- **AND** the unit is `s` (seconds)
- **AND** the panel title is `Latency by Route (${percentile})` so the current selection is visible in the title
- **AND** changing the `percentile` variable to `p50` or `p99` re-renders the panel with the corresponding percentile without edits to the dashboard JSON

#### Scenario: Panel excludes __unmatched route by default

- **WHEN** the panel is rendered
- **THEN** requests to unmatched routes (label `route="__unmatched"`) are either visible as a distinct line or filtered out — whichever the dashboard JSON commits, the behavior is deterministic and documented in the panel description

### Requirement: Error Rate Panel

The dashboard SHALL include a stat panel titled "5xx Error Rate" showing the fraction of HTTP responses with a 5xx status code, with color thresholds indicating severity.

#### Scenario: Panel query computes 5xx ratio

- **WHEN** the panel is inspected
- **THEN** its query expression is `sum(rate(http_requests_total{status_code=~"5.."}[1m])) / sum(rate(http_requests_total[1m]))`
- **AND** the unit is `percentunit` (0.0–1.0 formatted as a percentage)
- **AND** thresholds are configured so the panel renders green below 1%, yellow 1–5%, red above 5%

#### Scenario: Panel shows zero when there are no 5xx responses

- **WHEN** the service is returning only 2xx responses
- **THEN** the panel displays `0.00%` in green
- **AND** does not display `NaN` or an error

### Requirement: Cache Hit Rate Panel

The dashboard SHALL include a stat panel titled "Cache Hit Rate" showing the fraction of `cache_operations_total{operation="get"}` results that are `hit`.

#### Scenario: Panel query computes hit ratio

- **WHEN** the panel is inspected
- **THEN** its query expression is `sum(rate(cache_operations_total{operation="get",result="hit"}[1m])) / sum(rate(cache_operations_total{operation="get"}[1m]))`
- **AND** the unit is `percentunit`
- **AND** thresholds are configured so the panel renders red below 50%, yellow 50–90%, green above 90%

#### Scenario: Panel handles a cold cache gracefully

- **WHEN** the cache has no traffic yet (denominator is zero)
- **THEN** the panel displays "No data" or `0%` in a non-alarming color
- **AND** does not display `NaN`

### Requirement: Cache Operations Breakdown Panel

The dashboard SHALL include a time-series panel (stacked area) titled "Cache Operations by Type and Result" showing `cache_operations_total` grouped by `operation` and `result`.

#### Scenario: Panel query groups by operation and result

- **WHEN** the panel is inspected
- **THEN** its query expression is `sum(rate(cache_operations_total[1m])) by (operation, result)`
- **AND** the legend is templated as `{{operation}} {{result}}`
- **AND** the panel uses stacked rendering so total cache throughput is visible

### Requirement: Database Query Duration Panel

The dashboard SHALL include a time-series panel titled `DB Query Duration by Operation (${percentile})` derived from `db_query_duration_seconds_bucket`, using the same dashboard-level `percentile` variable as the HTTP latency panel.

#### Scenario: Panel computes the selected percentile per operation

- **WHEN** the panel is inspected with the default `percentile` variable value (`p95` → `0.95`)
- **THEN** it has one query target with expression `histogram_quantile($percentile, sum(rate(db_query_duration_seconds_bucket[1m])) by (le, operation))`
- **AND** the target legend is templated as `{{operation}}` (one line per operation)
- **AND** the unit is `s` (seconds)
- **AND** the panel title is `DB Query Duration by Operation (${percentile})` so the current selection is visible

### Requirement: Database Pool Utilization Panel

The dashboard SHALL include a time-series panel titled "DB Pool Utilization" showing the three `db_pool_size` gauge states.

#### Scenario: Panel displays total, idle, and waiting

- **WHEN** the panel is inspected
- **THEN** it includes three query targets: `db_pool_size{state="total"}`, `db_pool_size{state="idle"}`, `db_pool_size{state="waiting"}`
- **AND** each target has a distinct legend (`total`, `idle`, `waiting`)
- **AND** the unit is `short` (integer count)

### Requirement: Node.js Runtime Health Panel

The dashboard SHALL include a panel titled "Node.js Runtime" showing event loop lag, heap used, and resident memory.

#### Scenario: Panel displays the three runtime metrics

- **WHEN** the panel is inspected
- **THEN** it includes three query targets:
  - `nodejs_eventloop_lag_p99_seconds` labelled `event loop lag p99` (reads the pre-computed p99 gauge that `prom-client` exposes as part of its `nodejs_eventloop_lag_seconds` summary — there is no `_bucket` series for this metric, so `histogram_quantile()` cannot be used)
  - `nodejs_heap_size_used_bytes` labelled `heap used`
  - `process_resident_memory_bytes` labelled `rss`
- **AND** the byte-valued metrics use unit `bytes`
- **AND** the lag metric uses unit `s`

### Requirement: Percentile Dashboard Variable

The dashboard SHALL expose a single dashboard-level custom variable named `percentile` with three options — `p50` → `0.50`, `p95` → `0.95`, `p99` → `0.99` — defaulting to `p95`, non-multi-value, non-includeAll, so a viewer can switch the HTTP latency panel and the DB query duration panel between percentiles without editing the dashboard JSON.

#### Scenario: Variable is present and defaults to p95

- **WHEN** the committed `deploy/grafana/dashboards/resources-api.json` is parsed
- **THEN** `templating.list` contains exactly one entry named `percentile`
- **AND** its `type` is `custom`, `multi` is `false`, `includeAll` is `false`
- **AND** its `options` array has exactly three entries with `text` values `p50 / p95 / p99` and `value` values `0.50 / 0.95 / 0.99`
- **AND** the `current` entry is `{text: "p95", value: "0.95"}`

#### Scenario: Variable is consumed by both percentile-bearing panels

- **WHEN** panels 2 ("Latency by Route") and 6 ("DB Query Duration by Operation") are inspected
- **THEN** each panel has exactly one query target whose expression uses `$percentile` as the first argument to `histogram_quantile()`
- **AND** each panel's title contains the substring `${percentile}` so Grafana interpolates the selected label
- **AND** no panel hard-codes `0.50`, `0.95`, or `0.99` in its latency/duration expressions

### Requirement: Dashboard Panel Count and Layout

The `Resources API` dashboard SHALL contain exactly eight panels on a single page in a 2-column grid, answering request rate, latency, error rate, cache hit rate, cache breakdown, DB duration, DB pool, and runtime questions in that order.

#### Scenario: Dashboard contains exactly eight panels

- **WHEN** the committed `deploy/grafana/dashboards/resources-api.json` file is parsed
- **THEN** the `panels` array contains exactly 8 entries
- **AND** each panel's `title` matches one of the titles defined by the panel requirements above
- **AND** no panel is nested inside a row or collapsed group

#### Scenario: Dashboard fits on a standard 1920x1080 screen without scrolling for the first row

- **WHEN** the dashboard is rendered at 1920x1080 with the default time range
- **THEN** at minimum the Request Rate and Latency Percentiles panels are visible above the fold
- **AND** the remaining panels are reachable by scrolling once

### Requirement: Grafana Data Volume

A named Docker volume `grafana-data` SHALL be attached to `/var/lib/grafana` in the Grafana container so interactive edits and user-account state survive non-destructive restarts, and SHALL be cleaned by `docker compose down -v`.

#### Scenario: Interactive state survives restart

- **WHEN** an operator logs in as `admin`, changes the admin password, and restarts the `grafana` container (without `-v`)
- **THEN** the new admin password is still valid after restart

#### Scenario: Destructive down wipes the volume

- **WHEN** an operator runs `docker compose --profile metrics down -v`
- **THEN** the `grafana-data` volume is removed
- **AND** the next `up -d` starts Grafana in a fresh state with re-provisioned datasources and dashboards

### Requirement: README Documentation

`README.md` SHALL include a subsection under Observability documenting: how to bring up the metrics stack, the Grafana URL, anonymous access behavior, admin credentials, the production caveat about anonymous access, and the relationship to the Prometheus UI from `s07`.

#### Scenario: README mentions the compose profile command

- **WHEN** an operator reads `README.md`
- **THEN** there is a one-liner example showing `docker compose --profile metrics up -d`
- **AND** the resulting URLs `http://localhost:9090` (Prometheus) and `http://localhost:3300` (Grafana) are both listed

#### Scenario: README notes production security guidance

- **WHEN** an operator reads the Grafana section
- **THEN** the text notes that anonymous viewer access is intended for local dev only
- **AND** directs production users to put Grafana behind real authentication and/or a reverse proxy
