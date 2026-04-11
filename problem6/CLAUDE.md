# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory (`problem6/` — the Scoreboard module).

This directory is one of several sibling problem solutions under the parent `99tech_backend` home-assignment repo. Scope all work described here to `problem6/`; sibling directories (`problem-4/`, `problem5/`, other worktrees) are unrelated.

## Scoreboard Module

NestJS 11 (Fastify adapter) + TypeScript service backed by Postgres (Kysely), Redis (ioredis), and NATS JetStream, implementing a DDD hexagonal (ports & adapters) architecture. Node 22 LTS, pnpm 9, pinned via `mise.toml`.

The authoritative spec is [`README.md`](./README.md) at this directory root — read it for the functional + non-functional requirements, data model, API contracts, domain events, rollout checklist, and the DDD dependency rules (§11). This file summarizes what you need while editing code.

### Commands

Day-to-day commands are exposed as **mise tasks** (see `mise.toml`). Run `mise tasks` to list them all. The underlying `pnpm` / `docker compose` invocations still exist — mise is a thin wrapper so the Dockerfile and CI can call them directly — but **always prefer `mise run <task>`** when working locally. Using raw `pnpm tsc` / `pnpm jest` instead of `mise run typecheck` / `mise run test` is a convention violation.

```bash
# Dev loop
mise run dev                 # pnpm nest start --watch — live reload on :3000
mise run build               # nest build → dist/
mise run start               # node dist/main.js (requires build)
mise run setup               # pnpm install --frozen-lockfile

# Quality gates
mise run typecheck           # pnpm tsc --noEmit (strict)
mise run lint                # eslint src/**/*.ts --max-warnings 0 (zero warnings allowed)
mise run format              # prettier --write src/**/*.ts
mise run check               # lint + typecheck + unit tests — pre-push gate

# Tests
mise run test                # unit tests (pure domain + application, no I/O)
mise run test:coverage       # unit tests with coverage — fails if global < 80%
                             # (domain 100%, shared/errors 100/95/100/100,
                             #  shared/resilience 100/85/100/100)
mise run test:integration    # Testcontainers — real Postgres + Redis + NATS (--runInBand)
mise run test:e2e            # End-to-end against the docker-compose stack
mise run test:load           # k6 — 10k SSE connections + write burst; pass `-- --quick` for 1-min smoke

# Database (Kysely via kysely-ctl; reads kysely.config.ts)
mise run db:migrate                    # migrate:latest
mise run db:migrate:make -- <desc>     # create new migration file
mise run db:migrate:down               # roll back the most recent migration
mise run db:codegen                    # regenerate src/database/types.generated.ts from live DB
mise run db:seed                       # run scripts/seed.ts

# Local infrastructure (docker compose)
mise run infra:up            # start Postgres + Redis + NATS only
mise run infra:up:full       # infra + API container
mise run infra:up:tools      # infra + adminer + redis-commander + nats-box
mise run infra:down          # stop containers
mise run infra:reset         # stop + wipe volumes (destructive)
mise run infra:logs          # tail logs

# NATS JetStream helpers
mise run nats:init           # idempotently create/update SCOREBOARD stream
mise run nats:info           # inspect stream
mise run nats:cli            # interactive nats CLI

# Docker image
mise run docker:build        # build runtime image locally (problem6/scoreboard-api:dev)
mise run docker:run          # run the runtime image against the compose network
```

**First-clone bootstrap**: `mise install` → `mise run setup` → `mise run infra:up` → `mise run db:migrate` → `mise run db:codegen`. Then `mise run dev`.

The test stack is three-tiered: **unit** (`test/unit/`, mocked adapters, fast), **integration** (`test/integration/`, Testcontainers-backed real Postgres/Redis/NATS, slower), and **e2e** (`test/e2e/`, full docker-compose). Integration + coverage are part of the definition of done for any change that touches infrastructure adapters or crosses a layer boundary.

### Architecture

The project is a **single bounded context with one aggregate** (`UserScore`). All code lives under `src/scoreboard/` organized as a hexagonal (ports-and-adapters) layout:

```
src/
  main.ts                  # NestJS bootstrap (Fastify adapter)
  app.module.ts            # Root module
  config/                  # Zod-validated env (ConfigService)
  database/                # Kysely + pg.Pool + types.generated.ts (committed codegen output)
  shared/                  # Cross-cutting: logger (pino), metrics (prom-client), tracing (OTel)
  scoreboard/              # The bounded context
    domain/                # Pure TS, no framework imports, no I/O
      user-score.aggregate.ts
      value-objects/       # UserId, Score, ScoreDelta, ActionId
      events/              # ScoreCredited, LeaderboardChanged
      ports/               # UserScoreRepository, LeaderboardCache, IdempotencyStore, DomainEventPublisher
      errors/              # InvalidArgumentError, IdempotencyViolationError (domain-layer throwables)
    application/           # Command/query handlers — depends only on domain
      commands/            # IncrementScoreHandler
      queries/             # GetTopLeaderboardHandler
      ports/               # ActionTokenVerifier (application-owned port)
      dto/
    infrastructure/        # Adapters that implement domain/application ports
      persistence/
        kysely/            # KyselyUserScoreRepository
        redis/             # RedisLeaderboardCache, RedisIdempotencyStore, RedisLeaderboardRebuilder
      messaging/nats/      # JetStreamEventPublisher + JetStreamSubscriber + StreamBootstrap
      outbox/              # OutboxPublisherService (background leader-elected publisher)
      auth/                # JwtGuard (HS256 via INTERNAL_JWT_SECRET), ActionTokenGuard, HmacActionTokenVerifier
      rate-limit/          # RedisTokenBucket + RateLimitGuard
    interface/              # Controllers + filters — the outward-facing edge
      http/
        controllers/       # scoreboard.controller, leaderboard.controller, leaderboard-stream.controller (SSE), actions.controller
        error-filter.ts    # Global HttpExceptionFilter (pure orchestration via scoreboard-errors primitives)
      health/              # /health, /ready, /metrics
    shared/
      errors/              # DomainError hierarchy + wrapUnknown + buildErrorMetadata + mapDbError + toPublicResponse + scrubHeaders
      resilience/          # Singleflight + logWithMetadata
```

**Dependency direction (enforced by `eslint-plugin-boundaries`):**

```
interface ──► application ──► domain
                 ▲
                 │
infrastructure ──┘   (adapters implement domain/application ports)
```

- **domain** depends on nothing. Pure TypeScript, no `@nestjs/*` imports, no I/O, no adapters.
- **application** depends only on **domain** + `src/shared/`.
- **infrastructure** depends on **domain** + **application** + **shared** (it implements the ports they declare).
- **interface** depends on **application** and framework modules; **not** on `infrastructure` directly — it goes through DI tokens.
- `src/shared/` is cross-cutting and usable from any layer.

A boundary violation is a **lint error, not a review comment** — `mise run lint` will fail CI. Type-only imports (`import type`) across boundaries are allowed where the symbol is purely a type.

**Port → Adapter map** (keep this in mind when you add new infrastructure):

| Port (domain / application) | Adapter (infrastructure) |
|---|---|
| `UserScoreRepository` | `KyselyUserScoreRepository` |
| `LeaderboardCache` | `RedisLeaderboardCache` (Redis ZSET, bit-packed score+updated_at for stable tie-break) |
| `IdempotencyStore` | `RedisIdempotencyStore` (SET NX EX) |
| `DomainEventPublisher` | `JetStreamEventPublisher` (driven by `OutboxPublisherService`) |
| `ActionTokenVerifier` | `HmacActionTokenVerifier` |
| `RateLimiter` | `RedisTokenBucket` |

**Write path lifecycle** (the core invariant of this module): `POST /v1/scores:increment` → JwtGuard → ActionTokenGuard → IdempotencyGuard → RateLimitGuard → `IncrementScoreHandler` opens a Postgres transaction that writes `score_events` (audit) + upserts `user_scores` + inserts `outbox_events` (atomic) → commit. A background `OutboxPublisherService` (leader-elected via Redis lock `outbox:lock`) then picks the row, publishes to JetStream subject `scoreboard.leaderboard.updated` with header `Nats-Msg-Id: <outbox.id>` (2-minute dedup window), and marks it sent. Every API instance creates its own ephemeral push consumer on boot for SSE fan-out.

**Error handling is centralized through `scoreboard-errors`.** Throw `DomainError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `UnauthenticatedError`, `ForbiddenError`, `RateLimitError`, `DependencyUnavailableError`, `InternalError`, etc.) from `src/scoreboard/shared/errors/`. The global `HttpExceptionFilter` (`src/scoreboard/interface/http/error-filter.ts`, wired via `APP_FILTER` in `app.module.ts`) is **pure orchestration** — nine steps in fixed order with no `instanceof` branches:

1. idempotency guard on `reply.raw.headersSent`
2. `wrapUnknown(exception)` coerces anything into a `DomainError`
3. fresh `errorId` UUID
4. `buildErrorMetadata(err, request, errorId)` builds the 17-field structured log payload
5. pick log level: `warn` for < 500, `error` for ≥ 500
6. log with the metadata object as first argument
7. `scoreboard_errors_total{code, status}` counter inc
8. `toPublicResponse(err, requestId, errorId | null)` builds the allowlist-based public envelope
9. `reply.status(...).send(body)`

**Never** construct error response bodies in controllers or guards — throw a typed `DomainError` and let the filter format it. The public envelope is `{ error: { code, message, requestId, details?, errorId? } }`; `details` only appears for `ValidationError`, `errorId` only appears on 5xx. Raw `InternalError` messages are always replaced with `'Internal server error'` — message leaks are prevented by `toPublicResponse`. The full stack + walked cause chain + scrubbed headers go to the server log under the same `errorId`. Redis infrastructure errors (ioredis `MaxRetriesPerRequestError`, `ECONNREFUSED`, etc.) are coerced inside `wrapUnknown()` into `DependencyUnavailableError → 503 TEMPORARILY_UNAVAILABLE` to preserve the GAP-03 fail-CLOSED contract.

**Non-HTTP error paths** (outbox publisher, NATS message handlers, background jobs, bootstrap code) go through `logWithMetadata(logger, level, err, context?)` from `src/scoreboard/shared/resilience/` — it reuses `wrapUnknown` + `buildErrorMetadata` with a synthetic `BACKGROUND` request stub so background errors log with the same structure as HTTP errors.

**Singleflight-wrapped reads.** `RedisLeaderboardCache.getTop(n)` is wrapped in a per-instance `Singleflight<LeaderboardEntry[]>` keyed by `top:${n}`. Under a reconnect storm, 10,000 concurrent `GET /v1/leaderboard/top` calls collapse into **one** Redis `ZREVRANGE` per pod instead of 10,000, preventing a self-inflicted GAP-03 Redis SPOF trip. Do not wrap `upsert`/`getRank` — they're per-user and don't thunder.

**Graceful shutdown** is NestJS-native via `app.enableShutdownHooks()` (called in `main.ts` after filter registration and before `listen()`). Six stateful adapters implement `OnApplicationShutdown(signal?)`: `OutboxPublisherService` (releases Redis `outbox:lock`), `JetStreamEventPublisher` (drains), `JetStreamSubscriber` (unsubscribes ephemeral consumer), `LeaderboardStreamController` (writes `event: shutdown\ndata: {"reason":"graceful"}\n\n` to each open SSE stream and `reply.raw.end()`s it), `RedisModule` (`redis.quit()`, NOT `disconnect()`), `NatsModule` (`drain()` then `close()`). NestJS runs hooks in reverse-dependency order — leaf providers release handles before the transport clients close. `main.ts` installs a 10-second process-level `unref()`'d SIGTERM/SIGINT sentinel that `process.exit(1)`s only if teardown hangs — it must not fire on a clean shutdown.

**Validation boundary** is the controller. `zod .safeParse()` on the request → on failure, throw `ValidationError('<msg>', zodIssues)` — the filter surfaces `details` on 400s. Zod schemas live in `src/scoreboard/interface/http/dto/`.

**Kysely schema** lives in `src/database/` as generated types (`types.generated.ts`) plus a `kysely.factory.ts` wiring a single `Database` interface. Migrations are TypeScript files in `migrations/` (project root, consumed by `kysely.config.ts`). **Kysely has no schema auto-diff** — hand-author migrations as the source of truth, then regenerate `types.generated.ts` via `mise run db:codegen` against the live DB. Do not hand-edit `types.generated.ts`.

**Authentication.** HS256 JWTs signed with `INTERNAL_JWT_SECRET` are the norm (JWKS-based verification was removed in an earlier change). `ActionTokenGuard` verifies a second short-lived HMAC token bound to a specific `userId`+`actionId`+`delta` for every write; the secret is `ACTION_TOKEN_SECRET` (+ optional `ACTION_TOKEN_SECRET_PREV` for rotation). `JwtGuard` sets `request.userId` before any downstream guard runs.

**Observability.** Structured JSON logs via Pino (`nestjs-pino`), fastify request-id hook, `X-Request-Id` echo on every response, Prometheus metrics via `prom-client` (including `scoreboard_errors_total{code, status}` for bounded cardinality), OpenTelemetry SDK initialized in `tracing.bootstrap.ts` as the **first** statement in `main.ts` (before any framework imports) — OTLP exporter enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `GET /v1/leaderboard/top` emits `X-Cache-Status: hit | miss` for k6 load-test assertions — this header is informational and MUST NOT be relied on by production clients.

### Work Tracking — OpenSpec

This project is planned and executed via **OpenSpec** change artifacts under `openspec/`:

- `openspec/changes/<id>/` — in-flight changes. Each has `proposal.md`, `design.md`, `specs/` (delta specs per capability), `tasks.md`, and often `verification.md`. The `tasks.md` checklist is the source of truth for implementation progress.
- `openspec/specs/<capability>/spec.md` — main specs. Delta specs from changes get synced here on archival. Current capabilities: `scoreboard-auth`, `scoreboard-config`, `scoreboard-database`, `scoreboard-domain`, `scoreboard-errors`, `scoreboard-events`, `scoreboard-idempotency`, `scoreboard-leaderboard`, `scoreboard-observability`, `scoreboard-ops`, `scoreboard-outbox`, `scoreboard-quality`, `scoreboard-rate-limit`, `scoreboard-resilience`, `scoreboard-streaming`, `scoreboard-testing`, `scoreboard-write-path`.
- `openspec/changes/archive/YYYY-MM-DD-<id>/` — completed changes.

The module was built in seven steps (`step-01` config/data → `step-07` ops/tests/prod-readiness), all archived, plus several post-step refinements (`restructure-error-handling-for-observability`, `add-runtime-resilience-utilities`, `replace-jwks-with-internal-hs256`). When implementing work, check `tasks.md` in the relevant change directory for the authoritative task list rather than inferring from code state. Use the `/opsx:*` skills (`/opsx:explore`, `/opsx:apply`, `/opsx_custom:verify`, `/opsx_custom:preflight`) for OpenSpec workflows — `/opsx:explore` is the starting point for new work, `/opsx_custom:verify` validates implementations before archiving, and `/opsx:archive` moves the change to `archive/` and syncs delta specs to main specs.

### Conventions Worth Preserving

- **Mise tasks over raw pnpm.** Use `mise run <task>` rather than `pnpm tsc` / `pnpm jest` / `pnpm eslint`. The mise layer exists so everyone hits the same invocation; bypassing it splits the team.
- **Hexagonal layer direction is lint-enforced.** `domain → nothing`, `application → domain + shared`, `infrastructure → domain + application + shared`, `interface → application`. Violations fail `mise run lint` — not a review comment.
- **Throw typed `DomainError` subclasses, never construct error JSON in controllers.** Let `HttpExceptionFilter` serialize them. Raw `InternalError` messages are always replaced with the generic `'Internal server error'` in the public body — the real message goes to server logs under `errorId`.
- **Non-HTTP error paths use `logWithMetadata(logger, level, err, context?)`** from `src/scoreboard/shared/resilience/`. Do not call `logger.error(err.message, err.stack)` directly — you lose the walked cause chain, errorId correlation, and pgCode mapping.
- **Coverage thresholds are per-directory, not just global.** `domain/**` = 100/100/100/100, `shared/errors/**` = 100/95/100/100, `shared/resilience/**` = 100/85/100/100, global = 80%. Branch thresholds are below 100% only where optional-chain defaults are unreachable in practice but Istanbul still counts them.
- **Adapters that hold external state must implement `OnApplicationShutdown`** and must be idempotent on repeated calls. Use a private `shutdownCompleted`/`drained` flag to short-circuit the second call. Log with `{ signal, ... }` so operators can correlate a SIGTERM trace across adapters.
- **Initialize OpenTelemetry before any framework import.** `tracing.bootstrap.ts` is the FIRST statement in `main.ts`, before `import { NestFactory }`, `AppModule`, etc. Auto-instrumentation patches must be installed before the patched libraries load.
- **The singleflight in `RedisLeaderboardCache` is instance-scoped, not module-scoped.** Each DI-scoped cache has its own; this keeps test isolation clean and matches the "each pod's Redis pool is protected independently" semantic. Do not move it to a static field.
- **Kysely migrations are hand-authored, not generated.** `types.generated.ts` is committed codegen output — regenerate via `mise run db:codegen` whenever a migration changes the schema; never hand-edit it alongside a migration PR.
- **INTERNAL_JWT_SECRET + ACTION_TOKEN_SECRET** are the two auth secrets. JWTs use HS256; action tokens are HMAC-SHA256 over `userId|actionId|delta|exp`. Dual-secret rotation via `ACTION_TOKEN_SECRET_PREV` is supported (see `docs/runbooks/action-token-rotation.md`).
- **Redis fail-CLOSED is a feature, not a bug.** ioredis `maxRetriesPerRequest: 1`; any Redis transport failure surfaces as `503 TEMPORARILY_UNAVAILABLE` via `wrapUnknown()`'s Redis-infrastructure branch. This is the GAP-03 contract — the recovery runbook is `docs/runbooks/redis-spof-degraded.md`.
- **SSE controller tracks an `openStreams: Set<FastifyReply>`.** Add to it on connect, delete on cleanup/disconnect, iterate on shutdown. The shutdown frame is `event: shutdown\ndata: {"reason":"graceful"}\n\n` (note the double newline — SSE frames terminate on `\n\n`).
