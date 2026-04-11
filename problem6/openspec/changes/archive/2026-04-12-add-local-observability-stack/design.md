## Context

problem6 has the producer side of observability wired (prom-client installed, 8 metrics registered in `src/shared/metrics/write-path-metrics.ts`, `/metrics` endpoint exposed via `HealthController`, OTel tracing bootstrap) but no local consumer. Developers cannot watch metrics update against a running instance without standing up Prometheus and Grafana manually. The IaC stubs in `infra/helm/` imply that production observability is operator-configured via a Prometheus operator (ServiceMonitor / Pod annotations), not something the application ships.

This change adds the missing dev loop: a checked-in Prometheus config, a checked-in Grafana dashboard, and mise tasks to boot/stop the pair. The constraint is that `docker-compose.yml` is SHA-256-pinned as a canonical scaffold file (Story 1.1 AC-6 / Story 1.2 AC-8) and cannot be edited. The existing `compose.override.yml` already uses this pattern for host-port remaps; this change extends that file rather than introducing a new override file.

**Current state:**
- `docker-compose.yml` — canonical; postgres, redis, nats, nats-box. SHA-256-pinned.
- `compose.override.yml` — already exists; used for host port remaps (postgres:55432, redis:56379, nats:54222/58222). Compose v2 auto-merges it.
- `mise.toml` — tasks use `dotted.suffix` naming (`infra:up`, `db:migrate`, `nats:init`, `docker:build`, `docker:run`). 4-letter module prefixes are the convention.
- `src/shared/metrics/write-path-metrics.ts` — registers 8 metrics with predictable names: `scoreboard_http_requests_total`, `scoreboard_http_request_duration_seconds`, `scoreboard_score_increment_total`, `scoreboard_action_token_verify_total`, `scoreboard_rate_limit_hits_total`, `scoreboard_rate_limit_failed_closed_total`, `scoreboard_process_start_time_seconds`, `scoreboard_errors_total` (the last one lands via the `restructure-error-handling-for-observability` change already in flight).
- `infra/helm/` — Helm chart skeleton with placeholders for production deployment. Does not include observability stack assumptions; deployment-time scraping is via the Prometheus operator.
- The existing compose override file pins host ports in the `5xxxx` range to avoid collision with problem5 running on the same host. We'll follow the same pattern for prometheus (`59090`) and grafana (`53000`).

**Constraints that shape every decision below:**
- **`docker-compose.yml` is untouchable** — every service addition goes into `compose.override.yml`. This is not flexible.
- **Compose v2 profiles** allow services to be opt-in. Services assigned to the `observability` profile are only started when `--profile observability` is passed (or via a mise task that always passes the flag). Default `docker compose up` behavior is unchanged.
- **Grafana dashboards must be JSON files** — Grafana's provisioning system reads JSON files from a directory. Any other source (API-driven import, CLI tool) is more operational overhead.
- **The dev server runs outside compose** — the canonical dev loop is `mise run dev` which runs `pnpm nest start --watch` on the host, not in a container. Prometheus must scrape the host from inside its own container. On Docker Desktop this is `host.docker.internal`; on Linux it needs the `extra_hosts: ["host.docker.internal:host-gateway"]` directive.
- **No persistent volumes for Grafana** — all state comes from read-only bind mounts of the provisioning directory. Grafana's internal SQLite database is ephemeral per container run. This is intentional: the repo is the source of truth.

## Goals / Non-Goals

**Goals:**
- A developer can run `mise run obs:up` and within 10 seconds have Prometheus scraping the dev server and Grafana rendering a pre-baked dashboard.
- The stack is opt-in via `--profile observability` so default `docker compose up` is unchanged for developers who don't want it.
- Prometheus and Grafana run on host ports in the 5xxxx range (59090 and 53000) to match the port-remap convention.
- A single committed `scoreboard-overview.json` dashboard renders panels for every metric defined in `write-path-metrics.ts` plus the inbound `scoreboard_errors_total` counter.
- Prometheus scrape target resolves `host.docker.internal:3000` (host-bound dev server) via the `extra_hosts` directive, working on both macOS and Linux.
- Grafana auto-provisions the Prometheus datasource and the dashboard on first boot via mounted config files — no manual UI setup.
- Dashboard panels break loudly if a metric is renamed (an empty panel + a "No data" legend), providing a review-time regression signal.
- `mise run obs:reload` hot-reloads the Prometheus config via the `/-/reload` endpoint, so dashboard iteration doesn't require restarting the container.
- Updated `README.md` documents the boot flow, URLs, and the "this is dev-only" caveat.

**Non-Goals:**
- Grafana alerting, alert manager integration, or any paging mechanism. Production uses the ops team's existing alerting.
- Loki, Tempo, or any log/trace aggregation. Scope is metrics only.
- Host-level metrics (node-exporter, cAdvisor). Developer concern is app metrics.
- Dashboard variables, templating, or drill-down links. Keep the first dashboard simple and declarative. Future changes can iterate.
- Persisting Grafana UI edits across restarts. The committed JSON is the source of truth.
- Production-ready auth on Grafana. Anonymous admin, bound to `127.0.0.1`. This MUST NOT leak into the Helm charts.
- Running the dev server inside compose. `mise run dev` continues to run on the host. The Prometheus scrape target is the host, not a compose service.
- Scraping anything other than `scoreboard-api`. No blackbox exporter, no other target. If a future service is added, extend the scrape config then.
- Replacing the `infra/helm/` production stubs with anything from this change. The production topology is operator-configured; this stack is strictly dev.
- Automated dashboard snapshot testing (rendering the dashboard headless and comparing pixels). Overkill for one dashboard.

## Decisions

### Decision 1 — Services go into the existing `compose.override.yml` under a new profile

**Decision**: The three new services (`prometheus`, `grafana`, plus optional ancillary configuration) are added to the existing `compose.override.yml` file, each assigned `profiles: ['observability']`. Nothing in `docker-compose.yml` changes. The existing port-remap sections in `compose.override.yml` remain untouched.

**Rationale**: The existing `compose.override.yml` is already the home for "things that override or extend the canonical compose file without editing it." Creating a second override file (`compose.obs.yml`) would force operators to remember to pass multiple `-f` flags, and Compose v2's automatic override-file detection only picks up `compose.override.yml`. Profiles are the correct primitive for opt-in services.

**Alternatives rejected**:
- *Add services to `docker-compose.yml`*: rejected — violates the SHA-256 preservation rule.
- *Create `compose.obs.yml` and pass via `-f`*: rejected — operators would need to remember the flag; mise tasks would need to re-specify it every time; confusion about which file is "canonical."
- *Create `infra/local/docker-compose.yml` as a standalone stack*: rejected — it can't share the compose network with the app stack, so Prometheus couldn't scrape via compose DNS even when the app runs in compose.

### Decision 2 — Prometheus scrape target is `host.docker.internal:3000`

**Decision**: The Prometheus scrape config contains one job, `scoreboard-api`, with a static target of `host.docker.internal:3000`. The prometheus service has `extra_hosts: ["host.docker.internal:host-gateway"]` so the address resolves on Linux as well as Docker Desktop (macOS/Windows).

**Rationale**: The dev loop is `mise run dev` on the host. Prometheus scraping from inside a container must reach the host via the Docker gateway. The `extra_hosts` + `host-gateway` pattern is the standard solution across all platforms Docker supports.

**Alternatives rejected**:
- *Scrape `scoreboard-api` via compose-network DNS*: doesn't apply — the dev server isn't in compose. Would apply if a future `mise run docker:run` task boots the API inside compose; a secondary target can be added then as a separate job.
- *Use a named network alias*: rejected — `host.docker.internal` is already the de-facto convention.
- *Run Prometheus on the host (not in compose)*: rejected — increases host toolchain friction; the point of this change is one-command setup.

**Implementation note**: If the operator runs the API inside compose instead of on the host, the scrape target is `scoreboard-api:3000` (compose-network DNS). The prometheus config can include both targets; Prometheus marks the unreachable one as down in the UI, which is easier to diagnose than a cryptic DNS failure.

### Decision 3 — Grafana auto-provisioning via mounted config files

**Decision**: Grafana's datasources and dashboards are provisioned via mounted directories:
- `infra/local/grafana/provisioning/datasources/prometheus.yml` — defines the Prometheus datasource pointing at `http://prometheus:9090`
- `infra/local/grafana/provisioning/dashboards/dashboards.yml` — defines a dashboard provider that loads any JSON file from `/var/lib/grafana/dashboards`
- `infra/local/grafana/dashboards/*.json` — the actual dashboard JSON files

On boot, Grafana reads these directories and creates the datasource + loads the dashboards. No manual UI setup, no API import step.

**Rationale**: Provisioning is Grafana's official mechanism for declarative config. It works offline, survives container restarts without persistent volumes, and produces deterministic boot state. Any other approach (manual import, API calls, volume-mounted SQLite database) has more moving parts.

**Alternatives rejected**:
- *Import the dashboard via Grafana API*: rejected — requires a separate import step, credentials, and error handling; provisioning is simpler.
- *Mount a pre-populated SQLite file*: rejected — version-locked to Grafana's schema, binary diff, unreviewable.
- *Let Grafana start empty and document the "File → Import" UI flow*: rejected — every developer must repeat the manual step; the whole point is one command.

### Decision 4 — Ephemeral Grafana state (no persistent volume)

**Decision**: The Grafana container has NO volume mount for `/var/lib/grafana` (the Grafana data directory). All UI edits are lost on container restart. The committed `scoreboard-overview.json` is the source of truth.

**Rationale**: Persistent state turns the dashboard file into two sources of truth (the committed JSON and the running Grafana's SQLite). Operators who edit a dashboard in the UI and forget to export it would lose their work on the next `mise run obs:down && mise run obs:up`. Making it explicit from the start ("your edits don't survive — export them") produces cleaner git history and avoids mysterious "where did my dashboard go" moments.

**Workflow for editing the dashboard**:
1. Operator opens Grafana, edits the dashboard in the UI
2. Dashboard → Settings → JSON Model → copies the JSON
3. Pastes into `infra/local/grafana/dashboards/scoreboard-overview.json`
4. Commits
5. On next `obs:down && obs:up`, the new version is loaded

This is the same workflow as problem5's approach to test fixtures: the file is canonical, not the runtime.

**Alternatives rejected**:
- *Persist via Docker named volume*: rejected — two sources of truth, git becomes unreliable.
- *Persist via bind mount to a gitignored directory*: rejected — still two sources of truth.
- *Persist only the user preferences, not the dashboard*: Grafana doesn't support that split cleanly.

### Decision 5 — Scrape interval 5 seconds

**Decision**: Prometheus `scrape_interval: 5s` in the global config. Retention is the default 15 days (not configured explicitly; Prometheus defaults are fine for dev).

**Rationale**: 5 seconds is aggressive enough to see live changes during manual testing (hit an endpoint, see the counter move within 5s) but slow enough that the scrape cost is invisible. Production would be 15s or 30s; dev wants responsiveness.

**Alternatives rejected**:
- *1 second*: rejected — unnecessary scrape cost, flickering histograms.
- *15 seconds (production default)*: rejected — developers hit an endpoint, refresh Grafana, see no change, hit refresh again, wonder if it's working.
- *Configurable via env var*: rejected — one hardcoded value is fine; if someone really needs different, edit the yml.

### Decision 6 — Dashboard JSON format and versioning

**Decision**: The dashboard JSON is exported from Grafana 11.3.0 (the container image version pinned in this change) and committed. The JSON's top-level `schemaVersion` field is included. `infra/local/README.md` notes the tested Grafana version.

**Rationale**: Grafana's JSON format is mostly backward-compatible but does evolve across major versions. Pinning the container image to a specific version (11.3.0) means the committed JSON is guaranteed to render correctly. If a future change bumps Grafana, the dashboard may need re-export; the README documents this contract.

**Implementation detail**: Dashboards use the `__input` template variable for the datasource so the JSON is portable (not hardcoded to a specific datasource UUID). Grafana's provisioning substitutes the actual datasource at load time.

**Alternatives rejected**:
- *Use Grafana's JSONNET (grafonnet)*: rejected — adds a build step, niche tooling, extra dependency. Plain JSON is the path of least resistance.
- *Generate the dashboard programmatically in TypeScript*: rejected — over-engineering for one dashboard.
- *Pin to Grafana latest*: rejected — dashboards break silently across major versions.

### Decision 7 — Mise task naming

**Decision**: Four new mise tasks under the `obs:` prefix:
- `obs:up` — start the observability profile
- `obs:down` — stop the observability profile
- `obs:logs` — follow logs from prometheus + grafana
- `obs:reload` — POST to Prometheus's `/-/reload` endpoint for config hot-reload

The `obs:` prefix matches the existing 4-letter-module convention (`db:`, `nats:`, `docker:`, `infra:`). Tasks are defined in `mise.toml` alongside the existing task groups.

**Rationale**: Consistency with the existing convention. New developers searching for "obs" in `mise tasks` get a coherent group. The `obs:up`/`obs:down` pair mirrors `infra:up`/`infra:down`.

**Alternatives rejected**:
- *One task `mise run observability`*: rejected — doesn't match the convention; doesn't give reload/logs sub-commands.
- *Put tasks under `infra:`*: rejected — conflates the core stack (postgres/redis/nats) with the dev-only observability stack; they should be independently controllable.

### Decision 8 — Security posture: anonymous admin, loopback-only binding

**Decision**: Grafana is configured with:
```
GF_AUTH_ANONYMOUS_ENABLED=true
GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
GF_AUTH_DISABLE_LOGIN_FORM=true
```
And the host port binding uses `127.0.0.1:53000:3000` (not `0.0.0.0:53000:3000`), so the service is only reachable from the developer's own machine.

Prometheus gets the same loopback binding: `127.0.0.1:59090:9090`.

**Rationale**: Dev convenience without auth friction. `127.0.0.1` binding ensures the stack never leaks outside the developer's machine, even on shared networks. A separate production-ready configuration would need auth; this is a commitment that the local stack is strictly local.

**Critical**: The `infra/local/README.md` MUST say this anonymous-admin config is NOT transferable to `infra/helm/`. A paragraph with a bold "DO NOT COPY" warning.

**Alternatives rejected**:
- *Require operators to set a password*: rejected — adds friction for a dev-only tool.
- *Bind to `0.0.0.0`*: rejected — creates a security footgun on laptops connected to untrusted networks.
- *Use Grafana's built-in admin/admin default*: rejected — every operator has to dismiss the "change your password" prompt on every fresh container boot.

### Decision 9 — Dashboard panel inventory

**Decision**: The `scoreboard-overview.json` dashboard contains exactly 8 panels, grouped into 4 rows:

```
Row: HTTP traffic
  Panel 1: Request rate by status
    Query: sum by (status) (rate(scoreboard_http_requests_total[1m]))
    Type: time series
  Panel 2: p99 request duration by route
    Query: histogram_quantile(0.99, sum by (route, le) (rate(scoreboard_http_request_duration_seconds_bucket[1m])))
    Type: time series

Row: Write path
  Panel 3: Score increments by result
    Query: sum by (result) (rate(scoreboard_score_increment_total[1m]))
    Type: time series
  Panel 4: Action token verifications by outcome
    Query: sum by (outcome) (rate(scoreboard_action_token_verify_total[1m]))
    Type: time series

Row: Rate limit & errors
  Panel 5: Rate limit outcomes
    Query: sum by (outcome) (rate(scoreboard_rate_limit_hits_total[1m]))
    Type: time series
  Panel 6: Rate-limit fail-CLOSED count
    Query: rate(scoreboard_rate_limit_failed_closed_total[1m])
    Type: stat (single value, alerts the eye when non-zero)
  Panel 7: Errors by code (depends on restructure-error-handling-for-observability)
    Query: sum by (code) (rate(scoreboard_errors_total[1m]))
    Type: time series
    Note: Panel shows "No data" until the dependent change ships; this is expected

Row: Process
  Panel 8: Uptime
    Query: time() - scoreboard_process_start_time_seconds
    Type: stat (single value in seconds, or formatted as duration)
```

**Rationale**: 8 panels covers every existing metric plus the inbound one. Small enough to fit on one screen without scrolling. Grouped by functional concern (traffic, writes, limits/errors, process). Every query uses `rate()` with a 1-minute window — consistent across panels. The fail-CLOSED counter is a stat panel because its value is supposed to be 0 in steady state; a non-zero number should immediately catch the eye.

**Alternatives rejected**:
- *Include the default Node.js process metrics (`process_cpu_seconds_total`, `process_resident_memory_bytes`) as additional panels*: rejected from v1 — they're nice-to-have, not load-bearing. Add later if operators want them.
- *Build separate dashboards per concern (write-path, read-path, ops)*: rejected — one dashboard is easier to maintain; complexity can grow later.
- *Skip the errors panel until the dependent change ships*: rejected — the panel is cheap to define, and committing it now means the dependency change's apply step has one fewer thing to add.

### Decision 10 — Dependency relationship with other changes

**Decision**: This change has NO hard dependencies on any other in-flight change. It can apply today against main.

The only cross-change touch point: the `scoreboard-overview.json` dashboard includes a panel for `scoreboard_errors_total` which is added by `restructure-error-handling-for-observability`. Until that change ships, the panel renders "No data" — it's not an error; Grafana handles missing metrics gracefully. Once the error-restructure change applies, the panel starts showing data automatically.

This change also provides immediate value for `add-runtime-resilience-utilities` — the singleflight wiring's expected impact is visible in the HTTP traffic panel (concurrent requests spike but upstream metrics don't).

**Rationale**: Dependency graphs get messy fast. Making this change dependency-free means it can land whenever the operator wants dev observability, regardless of where the other changes are in their apply cycle.

**Alternatives rejected**:
- *Wait until all three changes (error-restructure, resilience, this one) are ready to apply together*: rejected — adds coordination overhead for no benefit.
- *Remove the errors panel and add it in a follow-up change*: rejected — the panel cost is one JSON block; adding it now means fewer moving parts later.

## Risks / Trade-offs

- **[Prometheus can't reach `host.docker.internal` on Linux without extra_hosts]** → Mitigation: the compose service includes `extra_hosts: ["host.docker.internal:host-gateway"]`. Tested on Linux via the standard Docker Desktop-compatible pattern. Documented in `infra/local/README.md`.
- **[Grafana dashboard JSON format rot across versions]** → Mitigation: pin Grafana to `11.3.0` in the compose file. `infra/local/README.md` documents the tested version and the "if you bump Grafana, re-export" workflow.
- **[Grafana state lost on restart confuses new users]** → Mitigation: `infra/local/README.md` has a prominent "how to edit the dashboard" section explaining the export-and-commit workflow. The container startup log also includes a comment noting the mount is read-only.
- **[Anonymous admin leaking to production]** → Mitigation: `infra/local/README.md` contains a DO-NOT-COPY warning. The `infra/helm/` templates do NOT copy the env var settings from `compose.override.yml`. A grep-level review when cloning config between environments catches it.
- **[Port collisions on ports 59090/53000]** → Unlikely but possible on machines that use uncommon software. Mitigation: the override file pattern supports per-developer customization. If it's a real problem, document the "edit the override file locally" escape hatch; don't try to auto-pick ports.
- **[Prometheus scraping overhead during dev]** → Scrape interval 5s × 8 metrics × default histogram bucket count = negligible. Not a concern.
- **[Dashboard becomes stale as metrics change]** → Mitigation: dashboard JSON is checked in; metric renames in code review should trigger a dashboard review. A stale dashboard renders "No data" for renamed metrics, which is a loud signal.
- **[memory footprint of ~200MB]** → Dev machines can accommodate. Developers who don't want the stack simply don't run `mise run obs:up`.
- **[New contributors don't know about the stack]** → Mitigation: `README.md` gets a new section pointing at it. `mise tasks` listing shows the `obs:` group. `openspec` history records the addition.
- **[Dashboard JSON is verbose and unreviewable]** → Mitigation: organize the JSON by panel, keep panels small, and accept that the file is read by Grafana, not humans. Diffs on metric query changes should still be scannable even if full-file diffs are noisy.

## Migration Plan

1. Land this change in one commit.
2. Run `mise run obs:up` to boot the stack.
3. Visit `http://localhost:53000` — Grafana renders the dashboard automatically.
4. Run `mise run dev` in another terminal if the API isn't running already.
5. Hit a few endpoints with `curl` or the existing smoke scripts. Watch the panels populate within 5-10 seconds.
6. Run `mise run obs:down` when finished.

**No rollback needed**: The change is purely additive. `git revert` removes all new files; no stateful cleanup required (Grafana has no persistent volume).

**No existing developer workflow is affected**: `mise run infra:up`, `mise run dev`, `mise run test` all behave identically whether or not the observability stack is running. Developers who don't want the stack never see it.

## Open Questions

None. The exploration session resolved scope, file layout, and dependency ordering. Operator decisions (whether to run it, when to export dashboard edits) are runtime choices, not design choices.
