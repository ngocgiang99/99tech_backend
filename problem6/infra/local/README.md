# `infra/local/` — developer-only observability stack

## What this is

This directory holds a **developer-only** observability stack for the
scoreboard module: a Prometheus scraper that targets the host-bound dev
server at `host.docker.internal:3000`, and a Grafana instance pre-loaded
with a committed dashboard (`scoreboard-overview.json`) that renders the
metrics registered in `src/shared/metrics/write-path-metrics.ts`.

It is **not** the production observability story. The `infra/helm/`
templates (Helm chart skeleton) are the production topology — deployment
environments are expected to run their own Prometheus operator,
ServiceMonitor-based scraping, and alert pipelines. This stack gives
developers a one-command local equivalent so they can watch metrics
update in real time while iterating.

The stack lives in `compose.override.yml` under the `observability`
profile, so default `docker compose up` / `mise run infra:up` behavior is
unchanged. Prometheus + Grafana only start when the profile is opted in
via `mise run obs:up`.

## How to use

```bash
# 1. Start the baseline infra (postgres + redis + nats), if not already up.
mise run infra:up

# 2. Start the observability profile — boots prometheus and grafana.
mise run obs:up

# 3. Run the dev server on the host (scraped by prometheus at :3000).
mise run dev

# 4. Open the URLs in your browser:
#    - Prometheus:  http://localhost:59090
#    - Grafana:     http://localhost:53000   (anonymous admin — no login)
#
#    In Grafana, navigate to Dashboards → Scoreboard → Scoreboard Overview.
#    With the dev server running, panels start populating within ~5 seconds
#    (5s scrape + 5s dashboard refresh).

# 5. Hot-reload the Prometheus config after editing prometheus.yml.
mise run obs:reload

# 6. Stop the observability stack when done (infra keeps running).
mise run obs:down
```

Follow `mise run obs:logs` to see live container output from both
services — useful when diagnosing a DOWN scrape target or a Grafana
provisioning error.

## How to edit the dashboard

The committed `infra/local/grafana/dashboards/scoreboard-overview.json`
is the **source of truth**. Grafana runs with no persistent volume, so
any edits made in the UI are ephemeral — they live in the running
container's internal SQLite and are lost the moment you run
`mise run obs:down`. This is deliberate (see `design.md` Decision 4):
two sources of truth for a dashboard makes git unreliable and produces
mysterious "where did my edits go" moments.

To make a real change:

1. `mise run obs:up` and open Grafana at `http://localhost:53000`.
2. Edit the dashboard in the UI — add panels, change queries, tweak
   legend formats, whatever.
3. When the dashboard looks right, open **Dashboard Settings → JSON
   Model** and copy the entire JSON blob.
4. Paste it into `infra/local/grafana/dashboards/scoreboard-overview.json`.
5. Run `jq empty infra/local/grafana/dashboards/scoreboard-overview.json`
   to confirm the JSON is well-formed.
6. Run `mise run obs:down && mise run obs:up` — the reloaded Grafana
   should show your edits from the committed file, not from its
   ephemeral state.
7. Commit the JSON change alongside any code change that motivated it
   (metric rename, new label, new panel, etc.).

If you skip step 6 and just assume the UI state is correct, your edits
disappear on the next container restart. The `obs:down && obs:up` round
trip is a cheap safety check — it proves the committed JSON matches what
you see in the UI.

## Version pinning

| Component  | Version  | Why it is pinned                                                                                                                                   |
|------------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| Prometheus | `v2.55.0`| The scrape config and `promtool check config` semantics are stable across 2.x; pinned so the `/etc/prometheus` bind-mount path stays deterministic. |
| Grafana    | `11.3.0` | Dashboard JSON `schemaVersion: 39` matches Grafana 11.x. Major version bumps occasionally change the JSON schema silently.                          |

**If you upgrade Grafana to a new major version**:

1. Boot the new version with the old JSON — Grafana usually converts it
   in place.
2. Export the updated JSON via **Dashboard Settings → JSON Model**.
3. Commit the new JSON alongside the image-tag bump in `compose.override.yml`.
4. Update this table.

Prometheus 2.x → 3.x would be a similarly careful upgrade; the current
config uses no 3.x-specific features and should work unchanged on 3.0.

---

## > **⚠️ DO NOT COPY TO PRODUCTION** ⚠️

> The Grafana and Prometheus configuration in this directory is
> **intentionally insecure for developer convenience** and MUST NOT be
> transferred to `infra/helm/` or any production infrastructure-as-code.
>
> **Specifically**:
>
> - **`GF_AUTH_ANONYMOUS_ENABLED=true`** and
>   **`GF_AUTH_ANONYMOUS_ORG_ROLE=Admin`** give every visitor full admin
>   rights with no login. This is acceptable only because the stack is
>   bound to `127.0.0.1` on the developer's own machine. In a production
>   environment, this config is a remote code execution risk — Grafana
>   admins can run arbitrary PromQL, edit datasources, and (with the
>   right plugins) execute scripted queries.
> - **`127.0.0.1:59090:9090`** and **`127.0.0.1:53000:3000`** bind the
>   host ports to the loopback interface only, so the stack is
>   unreachable from the local network. Changing these to `0.0.0.0`
>   would immediately expose the anonymous-admin Grafana to anyone on
>   your network. Don't.
> - **No persistent volume for Grafana** means every container restart
>   wipes UI state. That is correct for dev, but production needs a
>   durable store for user settings, alert configuration, and audit
>   logs.
> - **`prom/prometheus:v2.55.0`** runs without TLS, without auth, and
>   without any rule-evaluation hardening. Production Prometheus is
>   typically behind an ingress with mTLS and a read-only HTTP API.
>
> Production observability for problem6 is the operator's responsibility,
> wired via the `infra/helm/` templates (ServiceMonitor / Pod annotations
> feeding a cluster-level Prometheus operator). The application's
> `/metrics` endpoint stays the same; the scraper and viewer are
> different. A grep for `GF_AUTH_ANONYMOUS_ENABLED` in `infra/helm/`
> should return zero matches — if it doesn't, revert the offending
> change.

---

## Troubleshooting

### Prometheus target shows DOWN (at `http://localhost:59090/targets`)

**Most likely cause**: the dev server is not running on the host at
`:3000`. Run `mise run dev` in another terminal and wait ~15 seconds for
Prometheus to scrape again. Refresh the targets page.

**Less likely**: you're running the API inside a compose container
(`mise run docker:run`) and the scrape target doesn't resolve. The
current config only targets `host.docker.internal:3000`. Add a secondary
target for `scoreboard-api:3000` in
`infra/local/prometheus/prometheus.yml` if you need both modes, then run
`mise run obs:reload`.

**Edge case**: a firewall on your host is blocking connections from the
Docker gateway to `:3000`. `curl http://localhost:3000/metrics` from the
host should work; if it does, the issue is the gateway bridge.

### Grafana shows empty panels / "No data"

**Most likely cause**: Prometheus hasn't scraped any data yet. Check
`http://localhost:59090/targets` — the target must be UP. Once it's UP,
wait 5-10 seconds (one scrape interval plus one dashboard refresh
interval) and the panels populate.

**Second cause**: the dashboard's `Errors by code` panel shows "No data"
by design until the `restructure-error-handling-for-observability`
change ships and at least one error has been emitted. That's expected,
not a bug. See `design.md` Decision 10.

**Third cause**: a metric was renamed in code but the dashboard panel
still references the old name. The panel renders "No data". Fix the
dashboard JSON and follow the **How to edit the dashboard** workflow
above.

### `host.docker.internal` doesn't resolve on Linux

**Fix**: the `extra_hosts: ["host.docker.internal:host-gateway"]`
directive in `compose.override.yml` is the standard Docker-on-Linux
shim. Confirm it is still present next to the `prometheus` service
block. If it is and resolution still fails, check that your Docker
daemon is recent enough to support `host-gateway` (Docker 20.10+).

### `mise run obs:reload` returns 404 or connection refused

**Cause**: Prometheus isn't running, or the `--web.enable-lifecycle`
flag is missing. Check:

```bash
docker compose ps prometheus
```

The command in `compose.override.yml` should include
`--web.enable-lifecycle` — without it, the `/-/reload` endpoint returns
404 on purpose (the flag is a deliberate guardrail against accidental
remote reloads in production).

### `mise run obs:up` fails with "port already in use"

**Cause**: something else on your machine is already bound to `:59090`
or `:53000`. Find it with `lsof -i :59090` / `lsof -i :53000` and stop
it, or edit the host ports in `compose.override.yml` to a different
5xxxx pair. Keep both services in the loopback range; do not switch
them to `0.0.0.0`.

### Dashboard looks right in the UI but `git diff` has no changes

**Cause**: you forgot the **Dashboard Settings → JSON Model → copy → paste
into `scoreboard-overview.json`** step. UI state is ephemeral; nothing
writes to the JSON file automatically. Follow the **How to edit the
dashboard** workflow.
