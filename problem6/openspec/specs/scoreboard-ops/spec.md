# scoreboard-ops

## Purpose

Operational endpoints for orchestrators and observability, the Redis-SPOF degraded-mode runbook, the production Docker image contract, and the deployment IaC stub library. Owns `GET /health`, `GET /ready`, `GET /metrics`, `problem6/docs/runbooks/redis-spof-degraded.md`, the `problem6/scoreboard-api:v1.0.0-rc1` image, and `infra/{helm,k8s,terraform}/`. Establishes the shape of what an operator needs to probe, monitor, recover, deploy, and customize the module in their own cluster.

## Requirements

### Requirement: GET /health is the unconditional liveness probe

The system SHALL expose `GET /health` that returns `200 { status: "ok" }` unconditionally as long as the process is running and responsive. This endpoint SHALL NOT check any external dependency.

#### Scenario: /health returns 200 even when dependencies are down
- **GIVEN** Postgres, Redis, or NATS is unreachable
- **WHEN** `GET /health` is called
- **THEN** the response is `200 { "status": "ok" }`
- **AND** no dependency probe is performed

#### Scenario: /health is fast (< 10ms)
- **WHEN** `GET /health` is called
- **THEN** the response time is < 10ms p99 (just Express/Fastify routing overhead)

### Requirement: GET /ready checks all dependencies + leaderboard rebuild

The system SHALL expose `GET /ready` that returns `200 { checks: { postgres: "up", redis: "up", nats: "up", leaderboard: "ready" } }` only if all dependency probes succeed AND `readinessService.leaderboardReady === true`. Otherwise it returns `503` with the failing checks marked down.

#### Scenario: All dependencies up returns 200
- **GIVEN** Postgres, Redis, NATS reachable AND leaderboard ready
- **WHEN** `GET /ready` is called
- **THEN** the response is `200 { "checks": { "postgres": "up", "redis": "up", "nats": "up", "leaderboard": "ready" } }`

#### Scenario: Postgres down returns 503
- **GIVEN** Postgres is unreachable (probe times out or errors)
- **WHEN** `GET /ready` is called
- **THEN** the response is `503` with body `{ "checks": { "postgres": "down", "redis": "up", "nats": "up", "leaderboard": "ready" } }`
- **AND** the response includes the standard error envelope

#### Scenario: Leaderboard not ready returns 503
- **GIVEN** all dependencies up but `readinessService.leaderboardReady === false` (rebuild in progress)
- **WHEN** `GET /ready` is called
- **THEN** the response is `503` with body indicating `leaderboard: "rebuilding"`

#### Scenario: Probes have a 1-second timeout
- **GIVEN** Postgres takes 5 seconds to respond
- **WHEN** the probe runs
- **THEN** the probe times out after 1 second
- **AND** the dependency is marked "down" in the response
- **AND** the total /ready response time is < 1.5 seconds

### Requirement: GET /metrics exposes Prometheus text-format

The system SHALL expose `GET /metrics` that returns the Prometheus exposition for the registry built in `step-04`'s `MetricsModule`. The endpoint SHALL set `Content-Type: text/plain; version=0.0.4`.

#### Scenario: /metrics returns valid Prometheus format
- **WHEN** `GET /metrics` is called
- **THEN** the response is `200`
- **AND** the body is valid Prometheus text exposition format
- **AND** all metrics from `architecture.md §12.1` are present in the body

#### Scenario: /metrics is callable without authentication
- **WHEN** `GET /metrics` is called with no `Authorization` header
- **THEN** the response is `200` (Prometheus scrapers don't carry JWTs)
- **AND** in production, network-level isolation (private subnet) is the access control

### Requirement: Redis SPOF degraded mode runbook (GAP-03)

`problem6/docs/runbooks/redis-spof-degraded.md` SHALL document the system's behavior when Redis is unreachable and provide a recovery procedure. The runbook SHALL describe the chosen rate-limit fail mode (per DECISION-1) and walk the operator through confirming degraded mode, monitoring recovery, and restoring full functionality.

#### Scenario: Runbook documents the four-step recovery procedure
- **WHEN** the runbook is read
- **THEN** it contains a numbered procedure: (1) confirm degraded mode is active via metrics (which metric to check, expected values), (2) check Redis recovery progress (ping, logs, monitoring), (3) trigger `LeaderboardRebuilder` once Redis is back (the manual admin command), (4) verify rate-limit has re-enabled (which metric to check)

#### Scenario: Runbook describes the chosen GAP-03 fail mode
- **WHEN** the "Behavior in degraded mode" section is read
- **THEN** it lists each subsystem's behavior: idempotency layer 1 → falls back to layer 2 (Postgres unique), rate limit → fails open with critical alert (or per DECISION-1), leaderboard reads → fall back to direct Postgres query

#### Scenario: Runbook closes GAP-03
- **WHEN** the runbook is committed
- **THEN** `_bmad-output/planning-artifacts/architecture.md` `openGaps` GAP-03 is marked "resolved"

### Requirement: Production Dockerfile builds and runs the Epic 2 codebase

The multi-stage Dockerfile from `step-00` (preserved by AC-8 in `step-00`) SHALL build the Epic 2 codebase without errors when invoked via `mise run docker:build`. The resulting image SHALL run cleanly, pass its internal `HEALTHCHECK`, run as the non-root `app` user, and respond to `GET /health` within 10 seconds of startup.

#### Scenario: Image builds without errors
- **WHEN** `mise run docker:build` is run with the full Epic 2 codebase in place
- **THEN** the build exits 0
- **AND** the image is tagged `problem6/scoreboard-api:dev` locally

#### Scenario: Image runs cleanly via mise run docker:run
- **WHEN** `mise run docker:run` starts the container against the compose network
- **THEN** the container starts
- **AND** `docker logs` shows the NestJS boot sequence completing
- **AND** within 10 seconds, `curl http://localhost:3000/health` returns `200`
- **AND** `docker exec problem6-api whoami` returns `app` (not root)

#### Scenario: Image is tagged for v1.0.0-rc1
- **AFTER** the image passes the healthcheck
- **THEN** `docker tag problem6/scoreboard-api:dev problem6/scoreboard-api:v1.0.0-rc1` is run
- **AND** the operator has the runbook command for pushing to their registry

### Requirement: Deployment IaC stubs exist in infra/

The system SHALL provide placeholder IaC stubs at `infra/helm/`, `infra/k8s/`, `infra/terraform/`. Each stub SHALL be clearly labeled "TEMPLATE — OPERATOR MUST CUSTOMIZE" and SHALL document the required topology (3 replicas, sticky sessions on `/v1/leaderboard/stream`, ConfigMap for env vars, SecretRef for `ACTION_TOKEN_SECRET`, PodDisruptionBudget `minAvailable: 2`).

#### Scenario: Helm chart skeleton exists
- **WHEN** `infra/helm/` is inspected
- **THEN** it contains `Chart.yaml`, `values.yaml`, `templates/deployment.yaml`, `templates/service.yaml`, `templates/ingress.yaml`, `templates/configmap.yaml`, `templates/secret.yaml`, `templates/pdb.yaml`
- **AND** each template is labeled as a placeholder with TODO comments

#### Scenario: Kubernetes raw manifests exist
- **WHEN** `infra/k8s/` is inspected
- **THEN** it contains standalone YAML files for Deployment, Service, Ingress, ConfigMap, Secret stub, PDB
- **AND** the Deployment specifies 3 replicas and references the image `problem6/scoreboard-api:<TAG>`
- **AND** the Ingress includes sticky session annotations on `/v1/leaderboard/stream`

#### Scenario: Terraform skeleton exists
- **WHEN** `infra/terraform/` is inspected
- **THEN** it contains `main.tf`, `variables.tf`, `outputs.tf` with a Kubernetes provider scaffold
- **AND** comments explain that operators must fill in their cluster-specific values

### Requirement: Graceful shutdown via NestJS lifecycle hooks on all stateful adapters

The system SHALL enable NestJS's application shutdown lifecycle via `app.enableShutdownHooks()` in `src/main.ts`, registered after the global exception filter and before `app.listen()`. Every stateful adapter in the scoreboard module SHALL implement `OnApplicationShutdown(signal)` with a cleanup contract appropriate to the external state it holds (Redis lock, NATS connection, open SSE streams, background poll loop). The `main.ts` entrypoint SHALL additionally install a 10-second overall timeout sentinel so a hanging hook cannot indefinitely block the process; the sentinel SHALL log a warning and force-exit with code 1.

The adapters that SHALL implement the hook are: `OutboxPublisher`, `JetStreamEventPublisher`, `JetStreamSubscriber`, `StreamController` (SSE fan-out), `RedisClient` provider, `NatsClient` provider. The exact cleanup contract for each adapter is defined in `scoreboard-resilience/spec.md` — this requirement mandates that the hook exists and is wired; the resilience spec mandates what it does.

#### Scenario: main.ts enables shutdown hooks
- **WHEN** `src/main.ts` is inspected
- **THEN** `app.enableShutdownHooks()` is called exactly once
- **AND** the call appears after `app.useGlobalFilters(...)` and before `app.listen(...)`

#### Scenario: SIGTERM triggers the full shutdown sequence
- **GIVEN** a running instance with an active outbox leader lock, 3 open SSE streams, and an active JetStream subscription
- **WHEN** the process receives SIGTERM
- **THEN** `OutboxPublisher.onApplicationShutdown('SIGTERM')` runs and releases the Redis lock
- **AND** `JetStreamSubscriber.onApplicationShutdown('SIGTERM')` runs and unsubscribes the ephemeral consumer
- **AND** `StreamController.onApplicationShutdown('SIGTERM')` sends shutdown frames to all 3 streams and closes them
- **AND** `RedisClient.onApplicationShutdown('SIGTERM')` calls `redis.quit()`
- **AND** `NatsClient.onApplicationShutdown('SIGTERM')` calls `nats.drain()` + `nats.close()`
- **AND** the process exits with code 0 within the 10-second sentinel window
- **AND** each adapter logs its shutdown line with the signal name

#### Scenario: 10-second sentinel force-exits on a hanging hook
- **GIVEN** an adapter whose `onApplicationShutdown` never completes
- **WHEN** SIGTERM is received
- **AND** 10 seconds elapse
- **THEN** a warning log is emitted: `'Shutdown timeout exceeded — forcing exit'`
- **AND** `process.exit(1)` is called

#### Scenario: Clean shutdown exit code
- **GIVEN** all adapters' shutdown hooks complete in under 10 seconds
- **WHEN** the process exits
- **THEN** the exit code is 0
- **AND** the sentinel timer (which was `unref()`'d) did not fire and did not keep the event loop alive

#### Scenario: Shutdown ordering — publishers release handles before transports close
- **GIVEN** NestJS's lifecycle orchestration
- **WHEN** SIGTERM teardown runs
- **THEN** `OutboxPublisher` and `JetStreamSubscriber` complete their shutdown before `RedisClient` and `NatsClient` close their transports
- **NOTE**: NestJS orders providers in reverse dependency order by default; this scenario documents the expected outcome, not a manual ordering
