## ADDED Requirements

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

The `infra/local/prometheus/prometheus.yml` file SHALL define one scrape job named `scoreboard-api` with a static target of `host.docker.internal:3000`. The prometheus service in `compose.override.yml` SHALL include an `extra_hosts: ["host.docker.internal:host-gateway"]` directive so the hostname resolves on Linux as well as Docker Desktop (macOS/Windows). The scrape interval SHALL be 5 seconds.

#### Scenario: Scrape job targets the host dev server
- **WHEN** `infra/local/prometheus/prometheus.yml` is inspected
- **THEN** it contains a `scrape_configs` entry named `scoreboard-api`
- **AND** the static target is `host.docker.internal:3000`
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

### Requirement: Grafana auto-provisions the datasource and dashboard on boot

The grafana service SHALL mount `infra/local/grafana/provisioning/` read-only at `/etc/grafana/provisioning/`. The provisioning directory SHALL contain a `datasources/prometheus.yml` file that defines a Prometheus datasource pointing at `http://prometheus:9090` (compose-network DNS), and a `dashboards/dashboards.yml` provider config that loads any JSON file from `/var/lib/grafana/dashboards/`. The dashboard JSON files themselves SHALL be mounted from `infra/local/grafana/dashboards/` read-only at `/var/lib/grafana/dashboards/`. Grafana SHALL NOT have a persistent volume for `/var/lib/grafana` — all state is ephemeral and the committed JSON is the source of truth.

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

`infra/local/grafana/dashboards/scoreboard-overview.json` SHALL contain exactly 8 panels organized into 4 rows (HTTP traffic, Write path, Rate limit & errors, Process). Every metric registered in `src/shared/metrics/write-path-metrics.ts` SHALL have at least one corresponding panel. Panel queries SHALL use `rate()` with a 1-minute window for counters and `histogram_quantile()` for duration histograms. The JSON SHALL use the `__input` template variable pattern for the datasource so it is portable across datasource UUIDs.

#### Scenario: All 8 metric names are referenced in the dashboard
- **WHEN** `scoreboard-overview.json` is grep'd for metric names
- **THEN** it contains at least one query referencing each of: `scoreboard_http_requests_total`, `scoreboard_http_request_duration_seconds`, `scoreboard_score_increment_total`, `scoreboard_action_token_verify_total`, `scoreboard_rate_limit_hits_total`, `scoreboard_rate_limit_failed_closed_total`, `scoreboard_process_start_time_seconds`, `scoreboard_errors_total`

#### Scenario: Panels group into the expected rows
- **WHEN** the dashboard is inspected
- **THEN** row 1 is "HTTP traffic" with 2 panels
- **AND** row 2 is "Write path" with 2 panels
- **AND** row 3 is "Rate limit & errors" with 3 panels
- **AND** row 4 is "Process" with 1 panel

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
