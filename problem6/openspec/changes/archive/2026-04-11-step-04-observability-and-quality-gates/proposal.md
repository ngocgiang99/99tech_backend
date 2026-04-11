## Why

After `step-03`, the application has a working write path with security guards but it ships **without** structured logging, error envelope normalization, metrics, traces, layer-boundary lint enforcement, test coverage gates, or operational runbooks. These cross-cutting concerns are the difference between "the code runs locally" and "the code is production-ready". Bundling them into one change is correct because:

1. The Pino logger and the global exception filter both wrap controller-level logging/error handling — they need to land together so the controller's local error mapping (added in `step-03` as a stop-gap) can be deleted.
2. Metrics, traces, ESLint boundaries, and Jest coverage all share infrastructure setup (`src/shared/{logger,metrics,tracing}/`, root-level config files, CI gate flags). Splitting them creates orphan setup files.
3. The GAP-05 runbook (manual action-token rotation) requires a small code change to the `ActionTokenVerifier` from `step-03` (read both `ACTION_TOKEN_SECRET` and an optional `ACTION_TOKEN_SECRET_PREV`). It's a 20-line edit — too small for its own change, but operationally critical for v1 launch.

This change brings the codebase from "feature-complete write path" to "Epic 1 done" — the next change (`step-05`) starts Epic 2.

## What Changes

- Add `src/shared/logger/{pino-logger.factory.ts, request-id.middleware.ts, index.ts}` building Pino with the schema's `LOG_LEVEL`, redaction for `Authorization`, `Action-Token`, `actionToken`, `ACTION_TOKEN_SECRET`, and other secret-bearing fields. Wire request-scoped child loggers with the request-ID.
- Add a Fastify `onRequest` hook that generates a ULID for `request.requestId`, accepts an existing `X-Request-Id` header if present, and echoes the value back in the response header. The Pino child logger inherits the request ID.
- Add `src/scoreboard/interface/http/error-filter.ts` (`@Catch() implements ExceptionFilter`) registered globally that wraps every error into `{ error: { code, message, requestId, hint } }`. Domain errors map to specific HTTP codes (`InvalidArgumentError → 400`, `NotFoundError → 404`, `ConflictError → 409`, `UnauthorizedError → 401`, `ForbiddenError → 403`). Unexpected errors become `500 INTERNAL_ERROR` with NO stack trace leaked to the client (logged server-side only).
- **Delete** the local error-mapping try/catch from `step-03`'s controllers. The global filter handles it now.
- Add `src/shared/metrics/{metrics.module.ts, prom-client.ts, write-path-metrics.ts}` using `prom-client`. Register the metrics from `architecture.md §12.1` as `Counter`/`Histogram`/`Gauge` instances. Instrument the score-increment path (counters for committed/idempotent/rejected, histogram for duration, counter for action-token verify outcomes, counter for rate-limit hits).
- Add `src/shared/tracing/tracing.bootstrap.ts` initializing OpenTelemetry SDK with `@opentelemetry/instrumentation-fastify`, `@opentelemetry/instrumentation-pg`, and `OTLPTraceExporter`. Tracing is gated on `OTEL_EXPORTER_OTLP_ENDPOINT` being set (no-op if unset). Custom spans for `jwt.verify`, `action-token.verify`, `idempotency.check`, `db.tx`.
- Add `eslint-plugin-boundaries` configuration in `eslint.config.mjs` declaring layer types `domain`, `application`, `infrastructure`, `interface`, `shared` and the dependency rules from `README.md §11.2`. `mise run lint` is the enforcement gate.
- Wire Jest properly: `jest.config.ts` (unit), `jest.integration.config.ts` (Testcontainers), `--coverageThreshold='{global:{lines:80,branches:80,functions:80,statements:80}}'` enforced by `mise run test:coverage`. Add `@testcontainers/postgresql`, `@testcontainers/redis` as dev dependencies. Backfill any missing unit tests from `step-02`/`step-03` so the coverage gate is met.
- Add the integration test suite for the `KyselyUserScoreRepository` (the suite that was deferred in `step-02`) and the Redis-backed adapters (`IdempotencyStore`, `RedisTokenBucket`). NATS tests come in `step-06`.
- **GAP-05 — Action-token rotation runbook + dual-secret verifier**: amend `step-03`'s `HmacActionTokenVerifier` to accept an optional second secret via `ACTION_TOKEN_SECRET_PREV`. When present, verification is attempted against the primary secret first, then the prev secret on signature failure. Add a runbook at `problem6/docs/runbooks/action-token-rotation.md` describing the 4-step rotation procedure. Add `ACTION_TOKEN_SECRET_PREV` to `step-01`'s `EnvSchema` as an optional field. **`<DECISION>` — the runbook needs your input on the rollover window length (default: 5 minutes = the action-token TTL); `/opsx:apply` will halt and prompt.**

## Capabilities

### New Capabilities

- `scoreboard-observability`: Cross-cutting observability infrastructure. Owns the Pino logger factory, request-ID middleware, Prometheus metrics module, OpenTelemetry tracing bootstrap, and the global error filter. Establishes the contract that every controller writes structured logs and every error follows the envelope format.
- `scoreboard-quality`: Test coverage gate, layer-boundary lint enforcement, integration test infrastructure (Jest + Testcontainers), and the operational runbook collection. Owns `eslint.config.mjs` (boundary rules), `jest.config.ts`, `jest.integration.config.ts`, and `docs/runbooks/`.

### Modified Capabilities

- `scoreboard-auth`: Adds dual-secret support to `HmacActionTokenVerifier` (GAP-05). The verifier reads both `ACTION_TOKEN_SECRET` and the optional `ACTION_TOKEN_SECRET_PREV`. When both are set, verification falls through from primary to prev on signature failure. The runbook at `docs/runbooks/action-token-rotation.md` describes the rollover procedure.
- `scoreboard-config`: Adds `ACTION_TOKEN_SECRET_PREV` as an optional field in `EnvSchema` (`z.string().min(32).optional()`).
- `scoreboard-write-path`: Removes the local error-mapping try/catch from `ScoreboardController.incrementScore()` and `ActionsController.issueActionToken()`. Errors now propagate to the global filter.

## Impact

**New code**:
- `src/shared/logger/{pino-logger.factory.ts, request-id.middleware.ts, redaction.ts, index.ts}` (~150 LOC)
- `src/shared/metrics/{metrics.module.ts, write-path-metrics.ts, registry.ts, index.ts}` (~200 LOC)
- `src/shared/tracing/{tracing.bootstrap.ts, index.ts}` (~120 LOC)
- `src/scoreboard/interface/http/error-filter.ts` (~80 LOC)
- `eslint.config.mjs` updates (~50 LOC of boundary rules)
- `jest.config.ts`, `jest.integration.config.ts` (~80 LOC)
- `test/integration/persistence/kysely-user-score.repository.test.ts` (~150 LOC)
- `test/integration/persistence/redis-idempotency.test.ts` (~100 LOC)
- `test/integration/rate-limit/redis-token-bucket.test.ts` (~100 LOC)
- `problem6/docs/runbooks/action-token-rotation.md` (~80 LOC of operator-facing prose)

**Modified code**:
- `src/scoreboard/infrastructure/auth/hmac-action-token.verifier.ts` — accept optional `ACTION_TOKEN_SECRET_PREV`, attempt prev on primary failure
- `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` — delete local error-mapping try/catch (the global filter handles it now); the idempotent-replay path stays inline (it's success, not an error)
- `src/scoreboard/interface/http/controllers/actions.controller.ts` — delete local error-mapping try/catch
- `src/main.ts` — register the global error filter, register the Pino logger via `app.useLogger(...)`, register the request-ID hook
- `src/config/schema.ts` — add `ACTION_TOKEN_SECRET_PREV: z.string().min(32).optional()`
- `eslint.config.mjs` — add `eslint-plugin-boundaries` config

**New dependencies**:
- `pino` and `pino-pretty` (logger)
- `prom-client` (metrics)
- `@opentelemetry/sdk-node`, `@opentelemetry/instrumentation-fastify`, `@opentelemetry/instrumentation-pg`, `@opentelemetry/exporter-trace-otlp-http` (tracing)
- `nestjs-pino` OR a manual NestJS adapter (decision in design.md)

**New dev dependencies**:
- `eslint-plugin-boundaries`
- `@testcontainers/postgresql`, `@testcontainers/redis` (NATS Testcontainer comes in `step-06`)
- `jest`, `ts-jest`, `@types/jest` (might already exist from `step-00` scaffold; verify)

**Decisions to be made at /opsx:apply time** (the `<DECISION>` markers in tasks.md will halt and prompt):
- **DECISION-1** (GAP-05): What is the rollover window length for action-token rotation? Default suggestion: 5 minutes (the action-token TTL). Alternative: longer if action types span multiple TTL windows. Affects the runbook's "wait" step.

## File List (as-applied)

**New files**:
- `src/shared/logger/pino-logger.factory.ts`
- `src/shared/logger/request-id.hook.ts`
- `src/shared/logger/index.ts`
- `src/shared/metrics/registry.ts`
- `src/shared/metrics/write-path-metrics.ts`
- `src/shared/metrics/metrics.module.ts`
- `src/shared/metrics/metrics.interceptor.ts`
- `src/shared/metrics/index.ts`
- `src/shared/tracing/tracing.bootstrap.ts`
- `src/shared/tracing/index.ts`
- `src/scoreboard/interface/http/error-filter.ts`
- `jest.config.ts`
- `jest.integration.config.ts`
- `test/integration/setup.ts`
- `test/integration/persistence/kysely-user-score.repository.test.ts`
- `test/integration/persistence/redis-idempotency.test.ts`
- `test/integration/rate-limit/redis-token-bucket.test.ts`
- `test/unit/config/config.service.test.ts`
- `test/unit/interface/http/error-filter.test.ts`
- `test/unit/shared/pino-logger.factory.test.ts`
- `test/unit/auth/jwks-cache.test.ts`
- `docs/runbooks/action-token-rotation.md`
- `scripts/smoke-step04.ts`

**Modified files**:
- `src/app.module.ts` — add LoggerModule
- `src/main.ts` — add initTracing, registerRequestIdHook, useGlobalFilters, MetricsInterceptor, processStartTimeSeconds
- `src/config/schema.ts` — add ACTION_TOKEN_SECRET_PREV optional field
- `src/scoreboard/infrastructure/auth/hmac-action-token.verifier.ts` — dual-secret support
- `src/scoreboard/infrastructure/auth/action-token.guard.ts` — add OTel spans + metrics
- `src/scoreboard/infrastructure/auth/jwt.guard.ts` — add OTel spans
- `src/scoreboard/infrastructure/rate-limit/rate-limit.guard.ts` — add metrics
- `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` — remove local try/catch, add metrics
- `src/scoreboard/interface/http/controllers/actions.controller.ts` — remove local try/catch
- `src/scoreboard/application/commands/increment-score.handler.ts` — add OTel spans + metrics
- `src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts` — add OTel spans
- `eslint.config.mjs` — add eslint-plugin-boundaries
- `nest-cli.json` — fix Lua asset outDir to dist/src
- `package.json` / `pnpm-lock.yaml` — new dependencies
- `mise.toml` — add test:integration task
- `.env.example` — add OTEL and LOG_LEVEL vars

**Out of scope** (deferred):
- Grafana dashboards as JSON (mentioned in `architecture.md §12.4`) — operational artifact, not code
- The `/health`, `/ready`, `/metrics` HTTP endpoints — `step-07` (those are operational endpoints; the metrics REGISTRATION happens here, but the HTTP scrape endpoint is wired in `step-07`)
- E2E tests against the full docker-compose stack — `step-07`
- k6 load tests — `step-07`
- Anything in Epic 2 (`outbox_events`, leaderboard cache, NATS, SSE)
- The `LeaderboardCache`, `LeaderboardRebuilder` — `step-05`
- Any Pino transport beyond stdout (no log shipper config in v1)
