## Why

After `step-06`, the feature work is complete: the system can credit scores, enforce auth, log structured events, expose metrics, publish through the outbox, fan out to SSE clients, and recover from cache loss. But:
- **No HTTP health/readiness/metrics endpoints** — orchestrators (Kubernetes, ECS) can't probe the service. Prometheus can't scrape.
- **No documented degraded mode** for Redis SPOF (GAP-03) — operators don't know what to do when Redis dies.
- **No end-to-end test** that exercises the increment → outbox → JetStream → SSE chain against the full docker-compose stack.
- **No k6 load test with explicit thresholds** — NFR-01/02/03 are aspirational, not measured.
- **No cold-rebuild benchmark** — NFR-09's "< 60s" is asserted, not verified (MIN-02).
- **No production Dockerfile validation** — the multi-stage Dockerfile from `step-00` was never tested with the full Epic 2 codebase.
- **No deployment IaC stubs** — there's nothing for an operator to copy when standing up the service in their orchestrator.

This change is the "ship it" change. After it, the module is deployable, observable, monitored, load-tested, and operationally documented for v1 launch.

## What Changes

- Add `src/scoreboard/interface/health/health.controller.ts` exposing:
  - `GET /health`: returns `200 { status: "ok" }` unconditionally (liveness probe — only checks the process is running).
  - `GET /ready`: returns `200 { checks: { postgres: "up", redis: "up", nats: "up", leaderboard: "ready" } }` if all dependencies are reachable AND `readinessService.leaderboardReady === true`. Returns `503` with the failing checks if any dependency is down.
  - `GET /metrics`: returns the Prometheus text-format exposition from the registry built in `step-04`.
- Wire the dependency probes in `HealthService`: `pingPostgres()` runs `SELECT 1`, `pingRedis()` runs `PING`, `pingNats()` runs `js.streams.info('SCOREBOARD')` (lightweight). All probes have a 1s timeout.
- Add `problem6/docs/runbooks/redis-spof-degraded.md` (GAP-03) describing what happens when Redis is down: idempotency falls back to Postgres `UNIQUE(action_id)` only (per ADR-07 layer 2), rate-limit guard fails-open with an alert metric, leaderboard reads fall back to direct Postgres query (per `step-05` Story 2.6 fallback). The runbook walks the operator through (1) confirming degraded mode is active via metrics, (2) checking Redis recovery progress, (3) triggering `LeaderboardRebuilder` once Redis is back, (4) verifying rate-limit has re-enabled. **`<DECISION>` — `/opsx:apply` halts on the rate-limit fail-open behavior: should it fail OPEN (allow all), fail CLOSED (reject all), or use a degraded fallback (e.g. local in-memory budget)? Default: fail-open with a critical alert.**
- Add the Epic 2 integration test suite at `test/integration/leaderboard-stream/`, `test/integration/messaging/end-to-end.test.ts` covering the full subscriber → emitter → SSE path.
- Add `test/e2e/sse-live-update.test.ts` exercising the full happy path against the docker-compose stack:
  1. Start the API (already running via `mise run dev` or `mise run infra:up:full`)
  2. Open an SSE connection to `GET /v1/leaderboard/stream`
  3. Issue an action token
  4. Send a credit
  5. Assert the SSE client receives the `leaderboard.updated` event within 1s
- Add `test/load/scoreboard.k6.ts` k6 script with explicit `thresholds` per NFR-01/02/03:
  - `http_req_duration{endpoint:scores_increment} p(99) < 150ms`
  - `http_req_duration{endpoint:leaderboard_top} p(95) < 50ms`
  - `sse_event_latency p(95) < 1000ms` (custom metric tracked via the k6 script's SSE client)
  - VU ramp: 0 → 10000 over 5 minutes, hold for 30 minutes, mix 1500 writes/sec across all VUs
  - The script's exit code reflects threshold pass/fail (CI-friendly)
  - **`<DECISION>` — `/opsx:apply` halts on the EXACT threshold values. The defaults above are the architecture's NFR numbers, but operators may want stricter or looser thresholds for v1.**
- Add `scripts/benchmark-rebuild.ts` that seeds `user_scores` with N rows (configurable, default 10M for the MIN-02 budget verification or 100k for a quick check) and runs `LeaderboardRebuilder.rebuild()`, logging the elapsed time. Compare against the 60s budget.
- Add `infra/helm/`, `infra/k8s/`, `infra/terraform/` placeholder directories with stub manifests:
  - `helm/Chart.yaml`, `helm/values.yaml`, `helm/templates/{deployment,service,ingress,configmap,secret,pdb}.yaml`
  - `k8s/`: standalone YAML equivalents (Deployment with 3 replicas, Service, Ingress with sticky sessions on `/v1/leaderboard/stream`, ConfigMap, SecretRef, PodDisruptionBudget `minAvailable: 2`)
  - `terraform/`: a `main.tf` and `variables.tf` skeleton with comments
- Validate the production Dockerfile by running `mise run docker:build` against the Epic 2 codebase, then `docker run` the resulting image and confirm it starts cleanly, passes its internal healthcheck, and runs as the non-root user.
- Tag the validated image as `problem6/scoreboard-api:v1.0.0-rc1` locally (the production tag — operators publish to their own registry).

## Capabilities

### New Capabilities

- `scoreboard-ops`: Operational endpoints (`/health`, `/ready`, `/metrics`), the deployment IaC stub library (Helm/k8s/Terraform), and the operational runbook for Redis SPOF degraded mode (GAP-03). Owns the production Dockerfile validation and image tagging contract.
- `scoreboard-testing`: The Epic 2 integration test suite, the E2E test against docker-compose, the k6 load test with NFR thresholds, and the cold-rebuild benchmark (MIN-02). Establishes the verification surface that operators rerun before each release.

### Modified Capabilities

- `scoreboard-quality`: Adds the cold-rebuild benchmark script and the k6 load test. The integration suite from `step-04`/`step-05`/`step-06` is rounded out with end-to-end coverage.
- `scoreboard-leaderboard`: The MIN-02 cold-rebuild benchmark verifies the rebuilder's < 60s budget on a realistic dataset.
- `scoreboard-rate-limit`: GAP-03 specifies the fail-open behavior for the rate-limit guard when Redis is unreachable. The implementation may need a small patch to add a try/catch around the bucket consume call that defaults to "allow" on Redis error and emits a `rate_limit_failed_open_total` metric.

## Impact

**New code**:
- `src/scoreboard/interface/health/{health.controller.ts, health.service.ts, health.module.ts, index.ts}` (~250 LOC)
- `test/e2e/sse-live-update.test.ts` (~150 LOC)
- `test/integration/messaging/end-to-end.test.ts` (~200 LOC)
- `test/load/scoreboard.k6.ts` (~250 LOC, k6 JS)
- `scripts/benchmark-rebuild.ts` (~150 LOC)
- `problem6/docs/runbooks/redis-spof-degraded.md` (~150 LOC operator-facing prose)
- `infra/helm/{Chart.yaml, values.yaml, templates/*.yaml}` (~400 LOC YAML)
- `infra/k8s/*.yaml` (~250 LOC YAML)
- `infra/terraform/*.tf` (~200 LOC Terraform skeleton with comments)

**Modified code**:
- `src/scoreboard/infrastructure/rate-limit/rate-limit.guard.ts` — wrap the Redis call in try/catch; on Redis error, increment `rate_limit_failed_open_total` and allow the request (per GAP-03 DECISION-1)
- `src/scoreboard/scoreboard.module.ts` — register `HealthController`
- `mise.toml` — already has the relevant tasks (`docker:build`, `docker:run`, `test:e2e`, `test:load`); verify they work end-to-end

**New dev dependencies**:
- `k6` is a separate binary; document install via `mise install` (should work via mise's k6 plugin, or via `brew install k6` as a fallback)

**Decisions** (`<DECISION>` markers in tasks.md):
- **DECISION-1 (GAP-03)**: When Redis is unreachable, what does `RateLimitGuard` do? Options: (a) fail-open (allow all requests, alert), (b) fail-closed (reject all requests with 503), (c) degraded fallback (in-memory bucket per instance, lossy across restarts). Default: option (a) — fail-open with a critical alert metric.
- **DECISION-2 (MIN-01)**: What are the EXACT k6 thresholds? Defaults from the architecture: `p(99) < 150ms` for writes, `p(95) < 50ms` for `/top`, `p(95) < 1000ms` for SSE event latency. Operators may want stricter values for v1. `/opsx:apply` halts and prompts.

**Out of scope** (deferred or post-MVP):
- Multi-region NATS replication
- Automated secret rotation (manual rotation runbook landed in `step-04`)
- Chaos testing (mentioned in `architecture.md §15` as monthly, but no automated harness)
- Grafana dashboards as JSON (operational artifact, not v1 deliverable)
- CI pipeline configuration (the architecture lists the steps in §14.3, but the actual `.github/workflows/*.yaml` is deferred — operators copy the steps into their own CI)
- Production NATS cluster topology (the IaC stub references it but the actual deployment is the operator's job)
- TLS / mTLS — `IMPROVEMENTS.md` I-SEC-05, post-MVP
