## Context

After `step-06`, all the code is in place but the system is still not deployable in any meaningful sense:
- An orchestrator can't probe `/health` because it doesn't exist.
- Prometheus can't scrape `/metrics` because there's no controller exposing the registry.
- An operator has no runbook for the most likely incident type (Redis SPOF).
- NFR-01/02/03 are unverified.
- The production Dockerfile from `step-00` was last validated with an empty NestJS scaffold; it may not even build with all the new dependencies.
- There's nothing for an operator to copy when standing the service up in their cluster.

This change addresses all of those gaps. It's the largest change in terms of file count (16 new files across 6 directories) but each file is small and mostly mechanical. The risk is in the **DECISION points** (rate-limit fail-open behavior, k6 threshold values) and in the **k6 + benchmark validation** — those involve real infrastructure and can surface bugs that haven't been caught yet.

The change is structured so that the deliverables most likely to surface bugs (k6 load test, cold-rebuild benchmark, e2e test) come AFTER the easier deliverables (health endpoints, IaC stubs). If a real bug is found, it can be triaged before the rest of the change ships.

## Goals / Non-Goals

**Goals:**
- `GET /health`, `GET /ready`, `GET /metrics` exist and work correctly. Liveness is unconditional, readiness checks all dependencies, metrics serves the Prometheus registry from `step-04`.
- Redis SPOF runbook documents the degraded mode and the rate-limit guard implements the chosen GAP-03 fail-mode.
- E2E test exercises the full happy path (increment → outbox → JetStream → SSE) against the docker-compose stack and passes deterministically.
- k6 load test runs to completion with the chosen DECISION-2 thresholds and produces a pass/fail exit code.
- Cold-rebuild benchmark on a 100k-row dataset (10M is optional for "real" verification) runs in < 60s — verifying NFR-09.
- Production Dockerfile builds the Epic 2 codebase, the resulting image runs cleanly, the internal healthcheck passes, and the image runs as non-root.
- IaC stubs (Helm, k8s manifests, Terraform skeleton) exist in `infra/` and are coherent enough to be a starting point for an operator's actual deployment.
- `architecture.md` `openGaps` has GAP-03, MIN-01, MIN-02 marked resolved.

**Non-Goals:**
- A working CI pipeline (`.github/workflows/*.yaml`, `.gitlab-ci.yml`) — operators wire their own.
- A real production deployment — IaC is stubs, not "kubectl apply" ready.
- Chaos engineering (manual and out-of-scope per `architecture.md`).
- A multi-tenant or multi-region topology.
- TLS / mTLS — post-MVP.
- A managed-service migration guide (operators choose their own RDS, ElastiCache, NATS managed service).
- Performance regression baselines — k6 produces numbers, but tracking them across releases is the operator's responsibility.

## Decisions

### Decision 1 — DECISION-1 (GAP-03): Rate-limit fail mode when Redis is down

**What**: Resolved at `/opsx:apply` time. The architecture says "rate-limit guard fails open with an alert", but the exact behavior needs confirmation:

**Option (a) — Fail-OPEN with alert (recommended default)**: when the Lua call throws (Redis error), the guard catches, increments `scoreboard_rate_limit_failed_open_total`, and returns true (allows the request). The metric is wired to a critical alert that pages the operator.
- Pros: matches the spec ("fail-open with alert"); the leaderboard still updates, the system stays useful in a degraded mode.
- Cons: a sustained Redis outage means UNLIMITED writes per user — possible abuse vector.

**Option (b) — Fail-CLOSED (reject all)**: when the Lua call throws, the guard catches and returns 503 TEMPORARILY_UNAVAILABLE for ALL requests until Redis recovers.
- Pros: safer against abuse; no unlimited-write window.
- Cons: full outage of the write path; the rest of the system (which doesn't depend on Redis except for layer-1 idempotency) is down too.

**Option (c) — Degraded local fallback**: when the Lua call throws, the guard falls back to an in-memory token bucket per instance. Lossy on instance restart, no cross-instance coordination, but provides SOME rate limiting during the outage.
- Pros: bounded write rate even during the outage.
- Cons: 3 instances × per-instance budget = 3x the global limit during the outage. Bucket state lost on restart.

**Default if `/opsx:apply` doesn't prompt**: option (a) fail-OPEN with critical alert. Matches the architecture and is the most permissive (least likely to cause secondary outages).

**Recorded answer**: option (b) **fail-CLOSED** (resolved 2026-04-11). On Redis error, the guard increments `scoreboard_rate_limit_failed_closed_total` and throws `HttpException(503, 'TEMPORARILY_UNAVAILABLE')`. Rationale: the abuse-vector risk of fail-open during a sustained Redis outage outweighs the availability cost, since Redis is already load-bearing for idempotency layer 1 — a Redis outage already degrades the write path significantly. Fail-closed makes the failure mode explicit and uniform.

### Decision 2 — DECISION-2 (MIN-01): k6 threshold values

**What**: The k6 script's `thresholds` section is the contract for "is this build acceptable?". The architecture's NFR numbers are the ceiling, but operators may want stricter values to leave headroom.

**Defaults from architecture (NFR-02/NFR-03)**:
- `http_req_duration{endpoint:scores_increment} p(99) < 150ms`
- `http_req_duration{endpoint:leaderboard_top} p(95) < 50ms`
- `sse_event_latency p(95) < 1000ms`

**Stricter alternative** (for v1 if operators want headroom):
- `p(99) < 100ms` for writes
- `p(95) < 30ms` for top
- `p(95) < 500ms` for SSE

**Looser alternative** (if operators want to ship now and tune later):
- Same as defaults but `p(99)` becomes `p(95)` for writes (more permissive percentile)

**Default if `/opsx:apply` doesn't prompt**: architecture's NFR numbers (150/50/1000). The threshold can always be tightened in a follow-up change.

**Recorded answer**: architecture defaults (resolved 2026-04-11): `p(99) < 150ms` for writes, `p(95) < 50ms` for /top, `p(95) < 1000ms` for SSE. Tightening is deferred to a follow-up change once the v1 baseline has been measured on real hardware.

### Decision 3: `/health` is unconditional, `/ready` checks dependencies

**What**: `/health` returns 200 unconditionally — only checks the process is running and responding. `/ready` returns 200 only if Postgres + Redis + NATS are all reachable AND `readinessService.leaderboardReady === true` (set by `step-05`'s rebuilder bootstrap).

**Why**:
- **Liveness vs readiness in Kubernetes**: liveness probe failing means "kill this pod"; readiness probe failing means "remove from LB but keep running". They're different because a pod with stale dependencies (e.g. Redis just became reachable but we haven't reconnected yet) shouldn't be killed but should be removed from traffic.
- **`/health` minimal scope**: if it fails, k8s restarts the pod. Should ONLY fail if the process is genuinely broken (deadlock, exception loop). A reachable process always returns 200.
- **`/ready` thorough**: covers every external dep. Failure → removed from traffic but not killed.

**Alternatives considered**:
- **Single `/health` doing both**. Rejected — Kubernetes treats liveness and readiness differently; combining them defeats the orchestrator's design.

### Decision 4: Health probes have a 1s timeout

**What**: Each dependency probe (postgres, redis, nats) wraps the call in `Promise.race([probe(), timeout(1000)])`. If the probe takes longer than 1s, it's marked "down".

**Why**:
- **Avoid cascading failures**: a slow dependency shouldn't slow the readiness response. The probe must return within the orchestrator's polling budget (k8s default is 1s probe timeout).
- **Mark slow as down**: from the orchestrator's perspective, a 5-second-to-respond Postgres is just as bad as an unreachable one.

**Alternatives considered**:
- **Longer timeout** (5s). Rejected — exceeds k8s default.
- **No timeout, let Node hang**. Rejected — defeats the point.

### Decision 5: Cold-rebuild benchmark uses a configurable dataset size

**What**: `scripts/benchmark-rebuild.ts` accepts a `--rows N` flag (default 100000). Seeds `user_scores` with N synthetic rows, runs `LeaderboardRebuilder.rebuild()`, logs the elapsed time. The "official" MIN-02 verification runs with `--rows 10000000` (10M rows), but this requires a beefy local machine and ~30min to seed. The default is 100k for fast iteration.

**Why**:
- **MIN-02 budget is < 60s for a "realistic" dataset**, and the architecture doesn't define "realistic". 10M rows is the upper bound for v1 expected scale.
- **100k rows is fast to seed and runs in < 1s** — useful for catching regressions in the rebuild loop logic. The full 10M run is for the "ship-it" verification.

**Alternatives considered**:
- **Always 10M**. Rejected — too slow for iteration.
- **Always 100k**. Rejected — doesn't actually verify the NFR-09 budget on real-scale data.

### Decision 6: IaC stubs are skeletons, not deployable manifests

**What**: `infra/helm/`, `infra/k8s/`, `infra/terraform/` contain placeholder YAML/Terraform files with TODO comments where operators must fill in their cluster-specific values (image registry URL, ingress hostname, secret manager URN, etc.).

**Why**:
- **Operators have very different infra**: AWS EKS vs GCP GKE vs on-prem k8s have different ingress, secret management, and image registry conventions. A "ready to apply" Helm chart locks operators into the spec author's choices.
- **Stubs document the SHAPE**: 3 replicas, sticky sessions on `/v1/leaderboard/stream`, ConfigMap for env vars, SecretRef for `ACTION_TOKEN_SECRET`, PDB `minAvailable: 2`. Operators see the topology and adapt to their tools.

**Alternatives considered**:
- **Fully working Helm chart for one specific platform**. Rejected — privileges one platform over others.
- **No IaC at all**. Rejected — Story 2.20 explicitly asks for stubs.

## Risks / Trade-offs

- **[Risk]** The k6 load test pulls the docker-compose stack to its limits and may surface bugs hidden by smaller-scale tests (race conditions, leak in SSE controller, lock contention) → **Mitigation**: this is the POINT of the load test. Bugs found here are bugs we want to fix before v1. Allocate time in tasks.md for triage.

- **[Risk]** The cold-rebuild benchmark on 10M rows requires ~3GB of Postgres data and 5+ minutes of seed time. May not complete on a laptop → **Mitigation**: the script defaults to 100k rows; the 10M run is opt-in via `--rows 10000000`. CI runs the 100k version; the 10M version is a manual pre-release check.

- **[Risk]** Production Dockerfile may break with new Epic 2 dependencies — `nats`, `prom-client`, `pino`, etc. add native modules or unusual transitive deps that the multi-stage build wasn't tested with → **Mitigation**: Task 11 includes a build-and-run smoke check. If it breaks, fix the Dockerfile in this change.

- **[Risk]** Helm chart stubs will go stale as operators adapt them — they're a one-time gift, not a maintained library → **Mitigation**: stubs are clearly labeled "TEMPLATE — OPERATOR MUST CUSTOMIZE". Not a v1 maintenance burden.

- **[Risk]** GAP-03 fail-OPEN behavior is a real abuse vector during sustained outages. A bad actor could DoS Redis to disable rate limiting → **Mitigation**: documented in the runbook. The critical alert means an operator is paged within minutes of the outage. Acceptable for v1.

- **[Risk]** k6 thresholds passing today doesn't mean they pass tomorrow as data grows → **Mitigation**: load tests are operator-rerun pre-release. The thresholds are a CONTRACT, not a guarantee.

- **[Trade-off]** This change is large in file count (16+ new files) but each file is small and mechanical. Acceptable.

- **[Trade-off]** k6 is a separate binary, not a Node dependency. Operators must install it via `mise install` (if mise has a k6 plugin) or `brew install k6`. Documented in tasks.md.

## Open Questions

- **Q1 — DECISION-1 (GAP-03)**: see Decision 1 above.
- **Q2 — DECISION-2 (MIN-01)**: see Decision 2 above.
- **Q3: Should the k6 load test be runnable in CI?** Default: yes, with a `--quick` flag that uses 1 minute instead of 35 minutes. The full run is manual. CI catches obvious regressions; manual catches scale issues.
- **Q4: Should the Dockerfile be re-validated in this change or is it sufficient that `mise run docker:build` exits 0?** Default: build + run + curl /health + verify non-root. ~5 minutes manual but worth it.
- **Q5: Where should the production image be tagged-pushed in `mise run docker:build`?** Default: tag locally as `problem6/scoreboard-api:v1.0.0-rc1`, do NOT push (operators push to their own registry). The runbook lists the publish command for the operator.
