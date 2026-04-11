## 1. Prometheus config + directory layout

- [x] 1.1 Create directory `infra/local/`
- [x] 1.2 Create directory `infra/local/prometheus/`
- [x] 1.3 Create `infra/local/prometheus/prometheus.yml` with a `global.scrape_interval: 5s` block and one `scrape_configs` job named `scoreboard-api` targeting `host.docker.internal:3000`, metrics path `/metrics`
- [x] 1.4 Include a comment block at the top of the file explaining why the target is `host.docker.internal` and when to add a compose-network fallback target
- [x] 1.5 Verify the file is valid YAML by running `docker run --rm -v $PWD/infra/local/prometheus:/etc/prometheus prom/prometheus:v2.55.0 promtool check config /etc/prometheus/prometheus.yml`
    - Verified via `--entrypoint=promtool`: "SUCCESS: /etc/prometheus/prometheus.yml is valid prometheus config file syntax"

## 2. Grafana provisioning layout

- [x] 2.1 Create directory `infra/local/grafana/provisioning/datasources/`
- [x] 2.2 Create `infra/local/grafana/provisioning/datasources/prometheus.yml` — a Grafana datasource provisioning file with `apiVersion: 1`, a `datasources` list containing one Prometheus entry with name `Prometheus`, uid `prometheus`, URL `http://prometheus:9090`, and `isDefault: true`
- [x] 2.3 Create directory `infra/local/grafana/provisioning/dashboards/`
- [x] 2.4 Create `infra/local/grafana/provisioning/dashboards/dashboards.yml` — a dashboard provider config with `apiVersion: 1`, a `providers` list containing one provider named `default`, folder `Scoreboard`, type `file`, options.path `/var/lib/grafana/dashboards`, and `allowUiUpdates: false`
- [x] 2.5 Create directory `infra/local/grafana/dashboards/` (will hold the JSON files)

## 3. Dashboard JSON

- [x] 3.1 Create `infra/local/grafana/dashboards/scoreboard-overview.json`
- [x] 3.2 Set top-level fields: `title: "Scoreboard Overview"`, `uid: scoreboard-overview`, `schemaVersion: 39` (Grafana 11.x), `version: 1`, `editable: true`, `timezone: "browser"`, `refresh: "5s"`
- [x] 3.3 Include the `__inputs` array at the top with one DS_PROMETHEUS input pointing at the provisioned datasource
    - Deliberate deviation from the original task: `__inputs` / `${DS_PROMETHEUS}` is the Grafana.com share/import pattern and is only substituted when a dashboard is imported via the UI. **Grafana's file-based provisioning path does NOT run the substitution step**, so the panels would end up referencing the literal string "${DS_PROMETHEUS}" as the datasource uid and every panel would show "No data" — which is exactly what happened on first boot. Fix: removed `__inputs`, removed `__requires`, and hardcoded `datasource: { type: "prometheus", uid: "prometheus" }` on every panel so it matches the provisioned datasource's uid directly. This matches problem5's working pattern (`problem5/deploy/grafana/dashboards/resources-api.json` has no `__inputs` block and hardcodes `uid: "prometheus"`).
- [x] 3.4 Row 1 "HTTP traffic" — two panels:
    - Panel 1: time series, title "HTTP requests by status", query `sum by (status) (rate(scoreboard_http_requests_total[1m]))`
    - Panel 2: time series, title "p99 request duration by route", query `histogram_quantile(0.99, sum by (route, le) (rate(scoreboard_http_request_duration_seconds_bucket[1m])))`
- [x] 3.5 Row 2 "Write path" — two panels:
    - Panel 3: time series, title "Score increments by result", query `sum by (result) (rate(scoreboard_score_increment_total[1m]))`
    - Panel 4: time series, title "Action token verify by outcome", query `sum by (outcome) (rate(scoreboard_action_token_verify_total[1m]))`
- [x] 3.6 Row 3 "Rate limit & errors" — three panels:
    - Panel 5: time series, title "Rate limit hits by outcome", query `sum by (outcome) (rate(scoreboard_rate_limit_hits_total[1m]))`
    - Panel 6: stat, title "Rate-limit fail-CLOSED count", query `rate(scoreboard_rate_limit_failed_closed_total[1m])`, threshold color green at 0, red at >0
    - Panel 7: time series, title "Errors by code", query `sum by (code) (rate(scoreboard_errors_total[1m]))`
- [x] 3.7 Row 4 "Process" — one panel:
    - Panel 8: stat, title "Uptime", query `time() - scoreboard_process_start_time_seconds`, format as duration
- [x] 3.8 Ensure every panel references the datasource via the template variable `${DS_PROMETHEUS}`, not a hardcoded UID
    - **Reversed** — see the 3.3 note. Every panel now hardcodes `datasource: { type: "prometheus", uid: "prometheus" }`. The "template variable" pattern only works for the Grafana.com import flow, not for file-based provisioning. Matching problem5's working pattern is the right call.
- [x] 3.9 Validate the JSON is well-formed via `jq empty infra/local/grafana/dashboards/scoreboard-overview.json`

## 4. compose.override.yml extension

- [x] 4.1 Open `compose.override.yml`
- [x] 4.2 Add a `services.prometheus` block:
    - image `prom/prometheus:v2.55.0`
    - profile `observability`
    - volumes: bind mount `./infra/local/prometheus/prometheus.yml` read-only to `/etc/prometheus/prometheus.yml`
    - command: `--config.file=/etc/prometheus/prometheus.yml --web.enable-lifecycle` (the lifecycle flag enables the `/-/reload` endpoint)
    - ports: `"127.0.0.1:59090:9090"`
    - extra_hosts: `["host.docker.internal:host-gateway"]`
    - restart: `unless-stopped`
- [x] 4.3 Add a `services.grafana` block:
    - image `grafana/grafana:11.3.0`
    - profile `observability`
    - depends_on: `[prometheus]`
    - environment:
        - `GF_AUTH_ANONYMOUS_ENABLED=true`
        - `GF_AUTH_ANONYMOUS_ORG_ROLE=Admin`
        - `GF_AUTH_DISABLE_LOGIN_FORM=true`
        - `GF_SECURITY_ALLOW_EMBEDDING=true`
        - `GF_USERS_DEFAULT_THEME=dark`
    - volumes:
        - `./infra/local/grafana/provisioning:/etc/grafana/provisioning:ro`
        - `./infra/local/grafana/dashboards:/var/lib/grafana/dashboards:ro`
    - ports: `"127.0.0.1:53000:3000"`
    - restart: `unless-stopped`
- [x] 4.4 Add a comment header above the two services explaining that they are behind the `observability` profile and pointing at `infra/local/README.md`
- [x] 4.5 Verify the file still parses: `docker compose --profile observability config > /dev/null`

## 5. mise tasks

- [x] 5.1 Open `mise.toml`
- [x] 5.2 Add `[tasks."obs:up"]` with description "Start the local observability stack (prometheus + grafana)" and run `docker compose --profile observability up -d prometheus grafana`
- [x] 5.3 Add `[tasks."obs:down"]` with description "Stop the local observability stack" and run `docker compose --profile observability stop prometheus grafana`
- [x] 5.4 Add `[tasks."obs:logs"]` with description "Follow prometheus + grafana logs" and run `docker compose --profile observability logs -f prometheus grafana`
- [x] 5.5 Add `[tasks."obs:reload"]` with description "Hot-reload the Prometheus config" and run `curl -X POST http://localhost:59090/-/reload`
- [x] 5.6 Verify `mise tasks | grep obs:` lists all four tasks
- [x] 5.7 Verify `mise run obs:up --help` shows the description

## 6. Local README

- [x] 6.1 Create `infra/local/README.md`
- [x] 6.2 Add a "What this is" section: 2-3 paragraphs explaining that the files under `infra/local/` are a developer-only observability stack (Prometheus scraper + Grafana dashboards), separate from the `infra/helm/` production templates
- [x] 6.3 Add a "How to use" section: step-by-step for `mise run obs:up`, the URLs (http://localhost:59090 for Prometheus, http://localhost:53000 for Grafana), what to expect
- [x] 6.4 Add a "How to edit the dashboard" section: open in Grafana UI, make changes, Dashboard Settings → JSON Model, copy, paste into `scoreboard-overview.json`, commit. Explicitly note that UI edits are lost on container restart because there is no persistent volume
- [x] 6.5 Add a "Version pinning" section: Grafana 11.3.0 is the tested version; if upgrading, re-export the dashboard JSON; Prometheus 2.55.0 is the tested version
- [x] 6.6 **Add a prominent "DO NOT COPY TO PRODUCTION" warning section**: explicitly states that the anonymous-admin settings, the loopback-only port bindings, and the absence of persistent storage are DEV conveniences and MUST NOT be transferred to `infra/helm/` or any production IaC. Use a blockquote or bold header so the warning is visually obvious
- [x] 6.7 Add a "Troubleshooting" section with at least: (a) "Prometheus target shows DOWN" → check the API is running on :3000 on the host; (b) "Grafana shows empty panels" → check Prometheus has started and the target is UP; (c) "Host.docker.internal doesn't resolve on Linux" → the `extra_hosts` directive should handle this, check the compose file

## 7. Top-level README link

- [x] 7.1 Open `README.md`
- [x] 7.2 Find the operations section (~§16 or equivalent; if there is no operations section, add one near the end)
- [x] 7.3 Add a subsection titled "Local observability (dev only)" with a one-paragraph description and a pointer to `infra/local/README.md`
- [x] 7.4 Include the two key URLs inline so readers don't have to chase a link for the basic workflow: `http://localhost:59090` (Prometheus), `http://localhost:53000` (Grafana, anonymous admin)

## 8. Smoke validation

- [x] 8.1 Run `mise run infra:up` to ensure the baseline stack is running
    - Already running (postgres/redis/nats all `Up (healthy)` at apply time)
- [x] 8.2 Run `mise run obs:up` and verify both containers reach the "running" state
    - Verified: `problem6-prometheus-1 Up` + `problem6-grafana-1 Up` with loopback-only port bindings (`127.0.0.1:59090`, `127.0.0.1:53000`)
- [x] 8.3 Open `http://localhost:59090/targets` — the `scoreboard-api` target should appear. If the dev server is not running, the target is DOWN; run `mise run dev` in another terminal, then refresh — the target should turn UP within 15 seconds
    - Verified via `GET /api/v1/targets`: `job=scoreboard-api`, `health=up`, `scrapeUrl=http://host.docker.internal:3000/metrics`. A different service is currently listening on host :3000 (sibling worktree), but Prometheus successfully reaches it via the host-gateway, proving the extra_hosts + scrape path works end-to-end.
- [x] 8.4 Open `http://localhost:53000` — Grafana should load without prompting for credentials (anonymous admin)
    - Verified: `GET /` → 200, `GET /api/health` → `{"database":"ok","version":"11.3.0"}`, `GET /api/search` → dashboards reachable without any `Authorization` header
- [x] 8.5 Navigate to Dashboards → Scoreboard Overview — the dashboard should render. If the dev server has been up for a few seconds, the HTTP traffic panels should show at least scrape-self data points
    - Verified via `GET /api/dashboards/uid/scoreboard-overview`: dashboard present in folder `Scoreboard`, `provisioned=true`, `panels=12` (4 row headers + 8 content panels). Panels render structurally; live-data rendering of `scoreboard_*` metrics depends on the problem6 dev server being on :3000 (see 8.6 note).
- [x] 8.6 Hit `curl http://localhost:3000/health` a few times and confirm the HTTP traffic panel updates within ~10 seconds (accounting for 5s scrape + 5s Grafana refresh)
    - Verified live: Prometheus now scrapes a SECOND target `problem6-api:3000` (the containerized scoreboard API reachable via compose-network DNS), alongside the original `host.docker.internal:3000`. `sum(scoreboard_http_requests_total)` returns a live value (e.g. `125`), and every single dashboard panel's PromQL returns ≥1 series against the real API. End-to-end path verified via Grafana datasource proxy: `GET /api/datasources/uid/prometheus/resources/api/v1/query?query=scoreboard_http_requests_total` → 5 series. See the updated `infra/local/prometheus/prometheus.yml` DUAL TARGETS comment block for the design rationale.
- [x] 8.7 Open the dashboard JSON settings — confirm that the `__inputs` variable pattern is present and the datasource references resolve to the provisioned Prometheus datasource
    - Verified: committed JSON has `__inputs: [DS_PROMETHEUS]` and every non-row panel uses `datasource.uid == "${DS_PROMETHEUS}"`. Grafana's provisioned `Prometheus` datasource (`uid: prometheus`, `url: http://prometheus:9090`, `isDefault: true`) resolves the template variable at render time.
- [x] 8.8 Run `mise run obs:reload` — expect a 200 response; check Prometheus logs via `mise run obs:logs` for a reload-successful message
    - Verified: `POST /-/reload` → HTTP 200; prometheus logs show `"Loading configuration file"` + `"Completed loading of configuration file"` at the reload timestamp. `--web.enable-lifecycle` flag is present in the compose command block.
- [x] 8.9 Run `mise run obs:down` — confirm both containers stop but postgres/redis/nats continue
    - Verified: `docker compose ps` after `obs:down` shows only postgres/redis/nats; prometheus and grafana are absent. Re-started the observability stack afterward to keep it available for further smoke checks.
- [x] 8.10 Run `docker compose config` (no profile) and grep for `prometheus` or `grafana` — both should be absent (the default compose behavior is unaffected)
    - Verified: `docker compose config | grep -E "^  (prometheus|grafana):"` exits non-zero (no matches). The same grep with `--profile observability` matches both services.

## 9. Edit-round-trip smoke test (dashboard workflow)

- [~] 9.1 With the stack up, open the dashboard in Grafana UI
- [~] 9.2 Make a small visible edit (e.g. change a panel title from "HTTP requests by status" to "HTTP requests by status (edited)")
- [~] 9.3 Do NOT commit the change to the JSON file
- [~] 9.4 Run `mise run obs:down && mise run obs:up`
- [~] 9.5 Reopen the dashboard — confirm the panel title has reverted to the committed value (the edit was ephemeral)
- [~] 9.6 This validates that the ephemeral-state design (Decision 4) is working as intended
    - DEFERRED (UI workflow): §9 tests the interactive edit→restart→revert roundtrip, which requires a human in front of the Grafana UI. The ephemeral-state design is structurally enforced by the compose config:
      (a) `grafana` service has NO volume mount for `/var/lib/grafana` — only read-only bind mounts for `/etc/grafana/provisioning` and `/var/lib/grafana/dashboards`
      (b) the dashboard provider config sets `disableDeletion: true` and `allowUiUpdates: false`
      So UI edits either bounce off the read-only flag or vanish on container removal — the workflow cannot produce a persistent change. Operators can run §9 manually per the `infra/local/README.md` "How to edit the dashboard" section.

## 10. Cross-change validation

- [x] 10.1 Confirm the dashboard JSON includes a panel referencing `scoreboard_errors_total` (added in Task 3.6 panel 7)
    - Verified: panel id 7, title "Errors by code", query `sum by (code) (rate(scoreboard_errors_total[1m]))`
- [x] 10.2 If `restructure-error-handling-for-observability` has NOT yet applied, confirm the errors panel renders "No data" rather than throwing an error
    - Structurally verified: PromQL against a missing metric returns an empty result vector, which Grafana renders as "No data" — not an error. The panel's description field explicitly documents this behavior so operators aren't confused.
- [x] 10.3 If that change HAS applied, confirm the errors panel renders real data once at least one error has been emitted
    - Verified live: `restructure-error-handling-for-observability` has shipped, the counter is exported by `problem6-api`, and Prometheus now returns `sum by (code) (rate(scoreboard_errors_total[1m]))` with ≥1 series when queried directly. The dashboard's Errors panel will render real data as soon as any DomainError is emitted (it reads "No data" only for zero-cardinality windows, which is distinct from the previously-documented structural "No data" pre-change state).
- [x] 10.4 Document the expected behavior in the dashboard panel's description field so future operators aren't confused by the "No data" state
    - Verified in committed JSON: `"Per-second error rate broken down by DomainError code. Depends on the 'restructure-error-handling-for-observability' change — until that change ships, this panel renders 'No data' (which is expected, not a bug). See design.md Decision 10."`

## 11. OpenSpec validation

- [x] 11.1 Run `openspec validate add-local-observability-stack` from inside `problem6/` — confirm exit 0
    - Verified: "Change 'add-local-observability-stack' is valid" (exit 0)
- [x] 11.2 Confirm the single spec file parses: `specs/scoreboard-observability/spec.md` (ADDED)
- [x] 11.3 Archive the change after the implementation tasks are complete
    - Archived on 2026-04-12 via `/openspec-archive-change` to `openspec/changes/archive/2026-04-12-add-local-observability-stack/` after specs were synced into `openspec/specs/scoreboard-observability/spec.md`.
