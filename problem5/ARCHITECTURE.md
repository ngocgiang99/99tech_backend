# Architecture

The Resources API is an HTTP CRUD service for a "resource" entity, backed by Postgres for durability and Redis for read-side caching. This document is the authoritative reference for **how the system is shaped**: what it talks to, how the modules decompose, what happens on a request, what the data looks like, how it deploys, and how it behaves when its dependencies fail.

It is intended to be read in under 10 minutes by anyone who has not seen the code. The diagrams come first (skim in 30 s), the deeper layering and enforcement rules come after.

For day-to-day commands and the project's operational surface, see [`README.md`](./README.md). For project-specific conventions that affect automated tooling, see [`CLAUDE.md`](./CLAUDE.md). For benchmark methodology and results, see [`Benchmark.md`](./Benchmark.md).

## Contents

- [Context Diagram](#context-diagram) — the service in its environment
- [Container Diagram](#container-diagram) — internal module decomposition
- [Request Flows](#request-flows) — sequence diagrams per endpoint (linked out)
- [Data Model](#data-model) — Postgres schema and Redis key taxonomy
- [Deployment](#deployment) — Docker Compose topology
- [Failure Modes](#failure-modes) — what breaks and how it degrades
- [Production Topology](#production-topology) — scale-out path beyond a single host
- [Directory Layout](#directory-layout) — `src/` tree
- [Dependency Direction](#dependency-direction) — layering rules
- [Two Kinds of Infrastructure](#two-kinds-of-infrastructure) — top-level vs module-level
- [Composition Layers](#composition-layers) — wiring chain from process to handler
- [What This Architecture Is NOT](#what-this-architecture-is-not) — explicit non-goals
- [Enforcement](#enforcement) — ESLint rules
- [Adding a Feature](#adding-a-feature) — step-by-step

## Context Diagram

The service sits between HTTP clients (curl, browsers, k6 benchmark runner) and two stateful dependencies (Postgres for durability, Redis for caching). Nothing else. There are no upstream services to call, no message queues, no external APIs.

```mermaid
graph LR
    Client["HTTP Client<br/>(curl / browser)"]
    K6["k6 Benchmark Runner<br/>(benchmarks/scenarios/*.js)"]
    API["Resources API<br/>(Express 5 + TS, port 3000)"]
    PG[("Postgres 16<br/>(port 5432)")]
    Redis[("Redis 7<br/>(port 6379)")]

    Client -- "HTTP/1.1<br/>JSON · :3000" --> API
    K6 -- "HTTP/1.1<br/>JSON · :3000" --> API
    API -- "TCP · pg wire<br/>:5432" --> PG
    API -- "TCP · RESP<br/>:6379" --> Redis
```

The API is the only component that speaks to Postgres and Redis. Clients never reach the data tier directly.

## Container Diagram

Inside the API process, the request path decomposes into a small number of named modules. Each box on the diagram corresponds to a real file in `src/`. Arrows show dependency direction (`A → B` means `A imports B`).

```mermaid
graph TD
    subgraph http["HTTP Layer (src/http, src/middleware)"]
        Router["Router<br/>src/modules/resources/presentation/router.ts"]
        Controller["Controller<br/>src/modules/resources/presentation/controller.ts"]
        Mapper["Mapper (toDto)<br/>src/modules/resources/presentation/mapper.ts"]
        Middleware["Middleware<br/>request-id · rate-limit · x-cache · error-handler"]
    end

    subgraph app["Application Layer (src/modules/resources/application)"]
        Service["ResourceService<br/>service.ts"]
        ReqCtx["RequestContext<br/>request-context.ts"]
    end

    subgraph infra["Module Infrastructure (src/modules/resources/infrastructure)"]
        IRepo["ResourceRepository<br/>(interface)"]
        PgRepo["PostgresResourceRepository<br/>repository.ts"]
        CachedRepo["CachedResourceRepository<br/>cached-repository.ts"]
        Keys["cache-keys.ts<br/>(detailKey · listKey · version)"]
        Cursor["Cursor codec<br/>cursor.ts"]
    end

    subgraph drivers["Driver Infrastructure (src/infrastructure)"]
        Kysely["Kysely + pg.Pool<br/>db/client.ts"]
        IORedis["ioredis client<br/>cache/client.ts"]
        Singleflight["Singleflight<br/>cache/singleflight.ts"]
    end

    subgraph obs["Observability (src/observability)"]
        MetricsReg["MetricsRegistry<br/>metrics-registry.ts"]
        HttpMetrics["HTTP middleware<br/>http-metrics.ts"]
        DbMetricsLog["DB log callback<br/>db-metrics.ts"]
        PoolGauge["Pool sampler<br/>db-pool-gauge.ts"]
        MetricsRoute["/metrics route<br/>http/routes/metrics.ts"]
    end

    subgraph platform["Cross-Cutting (src/shared)"]
        Health["HealthCheckRegistry<br/>health.ts"]
        Shutdown["ShutdownManager<br/>shutdown.ts"]
        Errors["AppError taxonomy<br/>errors.ts"]
        Logger["Pino logger<br/>logger.ts"]
    end

    Middleware --> Router
    Middleware -. rate-limit store .-> IORedis
    Router --> Controller
    Controller --> Service
    Controller --> Mapper
    Service --> IRepo
    CachedRepo -. implements .-> IRepo
    PgRepo -. implements .-> IRepo
    CachedRepo --> PgRepo
    CachedRepo --> IORedis
    CachedRepo --> Singleflight
    CachedRepo --> Keys
    PgRepo --> Kysely
    PgRepo --> Cursor
    Service --> ReqCtx
    Health --> Kysely
    Health --> IORedis
    Controller --> Errors
    Service --> Errors

    HttpMetrics --> MetricsReg
    DbMetricsLog --> MetricsReg
    PoolGauge --> MetricsReg
    MetricsRoute --> MetricsReg
    Controller --> MetricsReg
    CachedRepo --> MetricsReg
    Kysely -. log callback .-> DbMetricsLog
    PoolGauge -. samples .-> Kysely
```

The decomposition honors the layering rule **presentation → application → infrastructure** — each arrow points "inwards" (towards data), never the other way. The `CachedResourceRepository` is a decorator: it implements the same `ResourceRepository` interface as `PostgresResourceRepository` and delegates to it on miss, so the service is unaware of whether caching is enabled.

**Middleware chain order.** Registered in `src/http/app.ts` in this order: `trust proxy` setting → `requestIdMiddleware` → (optional `http-metrics` middleware) → `pinoHttp` → **rate-limit** → `express.json` → routes → error handler. The rate-limit middleware (`src/middleware/rate-limit.ts`) lives between `pinoHttp` and `express.json` so 429s are logged and counted in HTTP metrics but never pay the body-parse cost. It shares the same ioredis client the response cache uses (no new connection opened) so three-replica prod stacks enforce a single bucket per IP. Loopback is always bypassed; `/healthz` and `/metrics` are excluded from the counter entirely. See `openspec/specs/rate-limiting/spec.md` for the full contract.

## Request Flows

Sequence diagrams for each endpoint live as standalone files under [`docs/architecture/`](./docs/architecture/) so this overview stays scannable. Each file is a single Mermaid diagram plus a short "key points" section — pick the one you need.

| Flow                              | File                                                              | When to read                                        |
|-----------------------------------|-------------------------------------------------------------------|-----------------------------------------------------|
| `GET /resources/:id` — cache HIT  | [docs/architecture/get-cache-hit.md](./docs/architecture/get-cache-hit.md)         | Understand the fast path                            |
| `GET /resources/:id` — cache MISS | [docs/architecture/get-cache-miss.md](./docs/architecture/get-cache-miss.md)       | Understand the slow path + singleflight             |
| `POST /resources`                 | [docs/architecture/post.md](./docs/architecture/post.md)                           | Understand write + list-cache invalidation          |
| `PATCH /resources/:id`            | [docs/architecture/patch.md](./docs/architecture/patch.md)                         | Understand partial update + detail-cache `DEL`      |
| `DELETE /resources/:id`           | [docs/architecture/delete.md](./docs/architecture/delete.md)                       | Understand hard delete + invalidation               |
| Cache invalidation (version-counter trick) | [docs/architecture/cache-invalidation.md](./docs/architecture/cache-invalidation.md) | Understand why one `INCR` invalidates every list page |
| `GET /healthz` (liveness + readiness) | [docs/architecture/health-check.md](./docs/architecture/health-check.md)       | Understand the parallel db/cache probes             |

The high-level shape every request shares: client → middleware (request-id, x-cache) → controller (Zod validation) → service → cached-repository decorator → (Redis or Postgres) → response. The decorator is a pass-through wrapper around `PostgresResourceRepository` — the service is unaware of whether caching is enabled.

## Data Model

### Postgres `resources` table

Defined by `migrations/0001_create_resources.ts` and typed in `src/infrastructure/db/schema.ts`. Five indexes support keyset pagination, the three filterable scalar columns, and tag containment.

| Column       | Type            | Nullable | Default               | Indexed                              | Description |
|--------------|-----------------|----------|-----------------------|--------------------------------------|-------------|
| `id`         | `uuid`          | NO       | `gen_random_uuid()`   | PK + composite (with `created_at`)   | Server-issued resource id |
| `name`       | `varchar(200)`  | NO       | —                     | —                                    | Human-readable label, ≤ 200 chars |
| `type`       | `varchar(64)`   | NO       | —                     | `resources_type_idx`                 | Caller-defined classification (e.g. `widget`) |
| `status`     | `varchar(32)`   | NO       | `'active'`            | `resources_status_idx`               | Lifecycle state |
| `tags`       | `text[]`        | NO       | `ARRAY[]::text[]`     | `resources_tags_gin_idx` (GIN, `@>`) | Free-form labels, queried with `tag=` |
| `owner_id`   | `uuid`          | YES      | —                     | `resources_owner_id_idx`             | Optional owner reference |
| `metadata`   | `jsonb`         | NO       | `'{}'::jsonb`         | —                                    | Free-form blob, capped at 16 KB at the Zod layer |
| `created_at` | `timestamptz`   | NO       | `now()`               | `resources_created_at_id_idx` (DESC, with `id`) | Insertion timestamp; drives keyset cursor |
| `updated_at` | `timestamptz`   | NO       | `now()`               | —                                    | Updated by the service on every write |

The composite index `(created_at DESC, id DESC)` is what makes keyset pagination cheap: `WHERE (created_at, id) < ($cursor_ts, $cursor_id)` is an index range scan, not a sort.

### Redis key taxonomy

Three key shapes, all prefixed with `resource:` so they can be flushed in one `SCAN MATCH 'resource:*'` if needed.

| Key pattern                                | Example                                                  | Purpose                                       | TTL                                | Invalidation trigger |
|--------------------------------------------|----------------------------------------------------------|-----------------------------------------------|------------------------------------|----------------------|
| `resource:v1:id:{uuid}`                    | `resource:v1:id:7f3c…`                                   | Detail cache for `GET /resources/:id`         | `CACHE_DETAIL_TTL_SECONDS` (300 s) | `DEL` on `PATCH` / `DELETE` of that id; TTL self-heals on `POST` (no DEL needed) |
| `resource:v1:list:{version}:{sha256-16}`   | `resource:v1:list:42:c9a1b2…`                            | List cache, keyed on filter tuple + version   | `CACHE_LIST_TTL_SECONDS` (60 s)    | Implicit on `INCR resource:list:version` (every list key embeds the old version, so they all become unreachable in one op) |
| `resource:list:version`                    | `resource:list:version` → `42`                           | List version counter (no namespace bump field) | none (persistent)                  | `INCR` on every successful `POST` / `PATCH` / `DELETE` |

The `{sha256-16}` is the first 32 hex chars (128 bits) of `sha256(canonical-json(filters))`, where `canonical-json` sorts object keys and array elements before serializing — so `?status=a&status=b` and `?status=b&status=a` resolve to the same cache key.

The `v1` segment is a manual schema-version field. Bumping `v1` → `v2` in code makes every existing entry unreachable, useful when the serialized shape changes incompatibly.

## Metrics

The service exposes Prometheus metrics at `GET /metrics` (text exposition format). Instrumentation is wired at four layers by `src/observability/`, and every label value comes from a service-controlled allowlist so cardinality stays bounded by `routes × methods × status codes` regardless of user input.

| Metric                              | Type      | Labels                         | Source                                                  |
|-------------------------------------|-----------|--------------------------------|---------------------------------------------------------|
| `http_request_duration_seconds`     | Histogram | `method`, `route`, `status_code` | `createHttpMetricsMiddleware` (res.on('finish'))        |
| `http_requests_total`               | Counter   | `method`, `route`, `status_code` | same middleware                                         |
| `cache_operations_total`            | Counter   | `operation`, `result`          | `CachedResourceRepository` (around every `tryGet`/`trySet`/`tryDel`/`bumpListVersion`) |
| `cache_operation_duration_seconds`  | Histogram | `operation`                    | same decorator                                          |
| `db_query_duration_seconds`         | Histogram | `operation`                    | Kysely `log` callback (`createDbMetricsLogger`)         |
| `db_query_errors_total`             | Counter   | `operation`, `error_class`     | same log callback; pg SQLSTATE → named class, else `other` |
| `db_pool_size`                      | Gauge     | `state`                        | `startDbPoolGauge` (5 s `setInterval`, `unref`'d)       |
| `resources_operations_total`        | Counter   | `operation`, `outcome`         | `ResourceController` (`recordOutcome` + `classifyOutcome(err)`) |

Label value sets:

- `method` ∈ `GET|POST|PATCH|DELETE|PUT|HEAD|OPTIONS`
- `route` is `req.route?.path` (e.g. `/resources/:id`), or the constant sentinel `__unmatched` — **never** `req.originalUrl`
- `operation` (cache) ∈ `get|set|del|incr`; `result` ∈ `hit|miss|error`
- `operation` (db) ∈ `select|insert|update|delete`; non-CRUD nodes (raw, with, DDL, transactions) skip recording
- `error_class` (db) is an allowlist of translated pg SQLSTATEs: `unique_violation`, `not_null_violation`, `foreign_key_violation`, `check_violation`, `deadlock`, `serialization_failure`, `connection_failure`, `syntax_error`, `undefined_table`, `undefined_column`, `other`
- `operation` (resources) ∈ `create|read|list|update|delete`; `outcome` ∈ `success|not_found|validation_error|error`

**Design choice — Kysely `log` callback instead of `KyselyPlugin`.** The Kysely plugin interface does not call `transformResult` on errors (the Kysely docs explicitly warn about this), so error tracking from a plugin is unreliable. The `log` callback receives both `query` and `error` events with `queryDurationMillis` already computed by the driver — cleaner, no `WeakMap` bookkeeping, and the only path that captures both success AND error durations in one place. See `src/observability/db-metrics.ts`.

**Kill switch.** `METRICS_ENABLED=false` short-circuits the whole instrumentation stack: the HTTP middleware is not installed, the `/metrics` route is not mounted, the Kysely log callback is not attached, and the pool sampler is replaced with a no-op. Instrumentation cost drops to zero for a comparison benchmark. See `README.md` §Observability for the PromQL cheat sheet and the production-exposure considerations.

## Deployment

The default deployment is a single-host Docker Compose stack. Three long-lived services (`api`, `postgres`, `redis`) on a private bridge network, plus two optional sidecars gated behind compose profiles: `k6` (benchmark runner, `--profile bench`) and `prometheus` (metrics scraper, `--profile metrics`).

```mermaid
graph LR
    subgraph host["Docker host"]
        subgraph net["app-network (bridge)"]
            API["api<br/>resources-api:3000"]
            PG["postgres<br/>postgres:16-alpine:5432"]
            R["redis<br/>redis:7-alpine:6379"]
            K6["k6 (profile: bench)<br/>grafana/k6:latest"]
            PROM["prometheus (profile: metrics)<br/>prom/prometheus:v2.54.1:9090"]
        end
        VolPg[("pg-data<br/>(named volume)")]
        VolR[("redis-data<br/>(named volume)")]
        VolProm[("prometheus-data<br/>(named volume)")]
    end

    Host3000["host :3000"] -.-> API
    Host5432["host :5432"] -.-> PG
    Host9090["host :9090"] -.-> PROM

    API -- "depends_on: healthy" --> PG
    API -- "depends_on: healthy" --> R
    K6 -- "depends_on: healthy" --> API
    PROM -- "depends_on: healthy" --> API
    PROM -. scrapes /metrics every 5s .-> API

    PG --- VolPg
    R --- VolR
    PROM --- VolProm
```

Healthchecks gate startup: `api` does not start until `postgres` and `redis` report healthy, and the `api` healthcheck (`GET /healthz?probe=liveness`) is what `k6` and `prometheus` wait on. The default stack exposes only `api` (port 3000) and `postgres` (port 5432) to the host; Redis stays inside the network. When the `metrics` profile is active, Prometheus's UI is also exposed on host port 9090.

### Optional overlay: multi-replica benchmark topology

For measuring the Node event-loop ceiling under horizontal scale, the repo also ships `docker-compose.prod.yml` — a **minimal overlay** on top of `docker-compose.yml` that adds three API replicas (`api-1`, `api-2`, `api-3`) and one `nginx` reverse proxy. It reuses the dev stack's `postgres`, `redis`, `app-network`, and volumes; launching both files together is the canonical form:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
# or equivalently:
mise run up:prod
```

nginx listens on host `:${NGINX_PORT:-8080}` and round-robins across the three upstream api replicas with HTTP/1.1 keepalive. The dev `api` service is unaffected and can run alongside the overlay. Per-replica `DB_POOL_MAX` is tuned down to 20 in the overlay so `3 × 20 + 10` stays under Postgres's default `max_connections=100`. Migration races across replicas are serialized by Kysely's `migration_lock` row (`SELECT ... FOR UPDATE`), so every replica's entrypoint can run `kysely migrate:latest` safely. See [`Benchmark_prod.md`](./Benchmark_prod.md) for the delta results and `openspec/specs/horizontal-scaling-benchmark/spec.md` for the capability contract.

The s12 rate-limit middleware's Redis-backed store is what makes this topology honest about throttling: all three replicas share the same per-IP bucket, so the effective limit is `RATE_LIMIT_MAX` regardless of which replica nginx routes the request to.

## Failure Modes

What happens when a dependency goes away. The service is designed to **degrade**, not fail wholesale, when Redis is unavailable. Postgres is harder to lose because the cache cannot satisfy writes — but reads still survive on warm cache entries until they expire.

| Failed component       | Observable behavior                                                                                                                                       | Service status                                                              | Recovery action                                                                 |
|------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|---------------------------------------------------------------------------------|
| **Redis down — cache path only** | `GET /resources/:id` and `GET /resources` fall through to Postgres (`X-Cache: MISS` on every request). Writes commit normally; cache invalidation `INCR` / `DEL` fail silently and are logged at `warn` (TTL bounds the staleness window). | **Degraded — fully functional for reads + writes**. `GET /healthz` → `503` with `checks.cache: down`. | Restart Redis. Cache repopulates lazily on the next read. No manual flush needed because the version counter is `INCR`-ed by the next write (or starts at 1 again, which is harmless). |
| **Redis down — rate-limit path** | The s12 rate-limit middleware uses `rate-limit-redis` with `passOnStoreError: false` (the library default), so a Redis outage causes every non-loopback request to fail with `500 INTERNAL_ERROR`. Loopback + allow-listed CIDRs (host k6) are unaffected because they bypass the store entirely. | **Severely degraded — all non-bypassed traffic 500s**. `GET /healthz` still passes the liveness probe. | Restart Redis. The middleware recovers automatically on the next successful store call. **Follow-up candidate:** flip to `passOnStoreError: true` in the factory so a Redis outage becomes fail-open and matches the response cache's fail-open posture. None of the s12 spec scenarios exercised the Redis-outage path — adding it would require a new change proposal that updates `openspec/specs/rate-limiting/spec.md` with the desired behavior. |
| **Postgres down**      | `GET /resources/:id` returns the cached value if `X-Cache: HIT`; on `MISS` the request fails with `500`. List requests fail unless the exact filter tuple + version is cached. All writes (`POST`/`PATCH`/`DELETE`) fail with `500`. | **Severely degraded — read-only on warm keys**. `GET /healthz` → `503` with `checks.db: down`. | Restart Postgres. Once healthy, writes resume. Stale cache entries naturally expire within `CACHE_DETAIL_TTL_SECONDS` / `CACHE_LIST_TTL_SECONDS`. |
| **Both Postgres and Redis down** | All reads fail with `500` (no cache, no source of truth). All writes fail. Health endpoint reports both checks down. | **Down**. `GET /healthz` → `503` with both `checks.db: down` and `checks.cache: down`. The container's healthcheck (`GET /healthz?probe=liveness`) still returns `200` because liveness is the fast path that does not query dependencies — so Docker keeps the container running rather than restart-looping. | Restart both backends in any order. Postgres healthcheck unblocks `api` (the `depends_on: service_healthy` gate). |
| **API process crash**  | Connections refused on port 3000. Docker Compose restart policy is `unless-stopped`, so the container is restarted automatically. In-flight requests are lost; clients retry. | **Down briefly** (single-replica deployment). | Automatic via Docker restart. Graceful shutdown drains in-flight requests within `SHUTDOWN_TIMEOUT_MS` on SIGTERM, so a planned restart loses no traffic. |
| **Slow Postgres (no outage)** | Read latency rises on `MISS`; warm hits remain microseconds. Writes block on the connection pool; if the pool is exhausted, requests queue and may time out. | **Degraded — cache absorbs read load**. `/healthz` still passes if the slow query stays under the healthcheck timeout. | Diagnose (slow query log, connection pool metrics). Raise `DATABASE_POOL_SIZE` or front Postgres with PgBouncer in transaction mode. |

The graceful-degradation behavior on Redis loss is documented in the `response-caching` capability spec and enforced by integration tests that kill the Redis container mid-test.

## Production Topology

A single-host Compose stack is the right shape for development, CI, and the take-home review. The s11 `docker-compose.prod.yml` overlay (see [§Deployment — Optional overlay](#optional-overlay-multi-replica-benchmark-topology)) is the local realization of the API-tier fan-out — three stateless replicas behind nginx — and the rate-limit middleware from s12 already handles the shared-state side of that fan-out via Redis. For a real production deployment, the same topology fans out further:

```mermaid
graph LR
    LB["Load Balancer<br/>(nginx / ALB / k8s ingress)"]

    subgraph api["API Tier (replicas ≥ 3)"]
        A1["api-1"]
        A2["api-2"]
        A3["api-3"]
    end

    PgB["PgBouncer<br/>(transaction pooling)"]
    PgPrimary[("Postgres primary")]
    PgReplica[("Postgres read replica")]

    RedisPrimary[("Redis primary")]
    RedisReplica[("Redis replica<br/>(Sentinel-managed)")]

    LB --> A1
    LB --> A2
    LB --> A3
    A1 --> PgB
    A2 --> PgB
    A3 --> PgB
    PgB --> PgPrimary
    PgPrimary -. WAL streaming .-> PgReplica
    A1 --> RedisPrimary
    A2 --> RedisPrimary
    A3 --> RedisPrimary
    RedisPrimary -. replication .-> RedisReplica
```

The scale-out points map directly to the bottlenecks observed in [`Benchmark.md`](./Benchmark.md) and [`Benchmark_prod.md`](./Benchmark_prod.md):

- **Single API process** → horizontal replicas behind a load balancer. The service is stateless (all state lives in Postgres or Redis). s11's `docker-compose.prod.yml` ships this locally as three replicas behind nginx; s12's rate-limit middleware holds a single per-IP bucket across them via Redis. Production swaps nginx for ALB / k8s ingress without a code change.
- **Postgres connection pool** → PgBouncer in transaction mode in front of a primary, with each replica's `pg.Pool` capped at 5–10 connections. Read-heavy workloads can fan out to a read replica via a connection-string switch in `DATABASE_URL`. The s11 overlay caps each replica at `DB_POOL_MAX=20` so three replicas stay under the default Postgres `max_connections=100`.
- **Redis single node** → Redis Sentinel for HA failover, or Redis Cluster for sharding once a single primary saturates. Cache-aside fits both transparently. The rate-limit middleware would also need a connection switch, since `rate-limit-redis` supports a cluster-mode `sendCommandCluster` path; left unused today.
- **Co-located load generator** (relevant only to local benchmarks) → run k6 on a separate host or use k6 Cloud / distributed k6.

The `Benchmark.md` "Co-location penalty" section quantifies how much of the laptop result is artifact-of-environment vs real ceiling. `Benchmark_prod.md` extends the story with the three-replica shape on the same host and identifies host CPU saturation (92–95%) as the laptop's hard wall — production numbers on isolated hardware will be substantially higher.

## Directory Layout

```
src/
├── config/                              # Startup-time Zod-validated env config
│   └── env.ts
├── shared/                              # Cross-cutting primitives, no feature knowledge
│   ├── errors.ts                        # AppError taxonomy
│   ├── health.ts                        # HealthCheckRegistry
│   ├── logger.ts                        # Pino logger factory
│   └── shutdown.ts                      # ShutdownManager
├── infrastructure/                      # Driver-level primitives (top-level)
│   ├── db/
│   │   ├── client.ts                    # Kysely + pg.Pool factory
│   │   ├── health.ts                    # DB health check
│   │   └── schema.ts                    # Kysely Database type definitions
│   └── cache/
│       ├── client.ts                    # ioredis factory
│       ├── health.ts                    # Redis health check
│       └── singleflight.ts              # In-process request coalescer
├── http/                                # Express wiring + non-feature routes
│   ├── app.ts                           # buildApp(logger, healthRegistry, db, cache)
│   └── routes/
│       └── health.ts                    # GET /healthz
├── middleware/                          # Express middleware shared across routes
│   ├── error-handler.ts
│   ├── rate-limit.ts                    # Per-IP rate limiter + loopback / CIDR bypass
│   ├── request-id.ts
│   └── x-cache.ts
├── modules/
│   └── resources/                       # Feature module: resources
│       ├── presentation/                # HTTP adapters — router, controller, mapper
│       │   ├── router.ts
│       │   ├── controller.ts
│       │   └── mapper.ts                # toDto: DB row → response DTO
│       ├── application/                 # Business orchestration + request context
│       │   ├── service.ts
│       │   └── request-context.ts
│       ├── infrastructure/              # Feature-local data access + caching + cursor codec
│       │   ├── repository.ts
│       │   ├── cached-repository.ts
│       │   ├── cache-keys.ts
│       │   └── cursor.ts
│       ├── schema.ts                    # Zod schemas + inferred DTO types
│       └── index.ts                     # createResourcesModule(deps) → { router }
├── app.ts                               # createApp(deps) — DI entry point
└── index.ts                             # Process entry point
```

Each top-level directory under `src/` has a single purpose. A contributor opening `src/` sees the layout without reading any file.

## Dependency Direction

Within a feature module, dependencies flow in one direction:

```
presentation ──▶ application ──▶ infrastructure
     │               │
     └──────────┬────┘
                ▼
          schema.ts (module-root)
```

- **`presentation`** may import from `application` and the module-root `schema.ts`. It may not import from `infrastructure` directly.
- **`application`** may import from `infrastructure` and `schema.ts`. It may not import from `presentation`.
- **`infrastructure`** may not import from `application` or `presentation` except via `import type` for type-only references (e.g., `RequestContext`).
- **`schema.ts`** stays at the module root because both `presentation` (for request validation) and `application` (for typed input) consume it. Placing it inside a layer would force a cross-direction import.

At the top level:

- **`src/shared/`** and **`src/infrastructure/`** are terminal — feature modules import them, but they never reach into `src/modules/` or `src/http/`.
- **`src/http/`**, **`src/middleware/`**, **`src/config/`** are composition and transport wiring.
- **`src/app.ts`**, **`src/http/app.ts`**, **`src/index.ts`** are exempt from the layer rules — they are the composition root and must be allowed to wire every layer together.

## Two Kinds of Infrastructure

The project has two `infrastructure/` directories, at different scopes, and the distinction is deliberate:

- **Top-level `src/infrastructure/`** holds *driver-level* primitives every feature shares: the Postgres connection pool, the Redis client, and the drivers' health checks. These are constructed once in `src/index.ts` (or the integration test fixtures) and passed into `createApp(deps)`. They know nothing about any specific feature.
  - *Example:* `src/infrastructure/db/client.ts` exports a `createDb()` factory returning a `Kysely<Database>` wrapping a `pg.Pool`. It has no reference to the `resources` table.

- **Module-level `src/modules/<feature>/infrastructure/`** holds *feature-local* data access and caching: the Kysely queries for this feature's table, the cached decorator around that repository, the cache-key builder. It knows exactly which table and which cache-key scheme it owns.
  - *Example:* `src/modules/resources/infrastructure/repository.ts` exports `ResourceRepository` — a Kysely-backed class that issues `SELECT ... FROM resources WHERE ...` queries.

Naming both levels `infrastructure/` is honest: both hold code that owns external systems. The difference is *scope* — the top level is shared, the module level is scoped to one feature.

## Composition Layers

The wiring chain from process startup to request handling:

```
src/index.ts                          (process entry)
      │
      ▼   createApp({ config, logger, db, redis })
src/app.ts                            (DI entry point — test + prod share this)
      │
      ▼   buildApp(logger, healthRegistry, db, cache)
src/http/app.ts                       (Express wiring + middleware)
      │
      ▼   createResourcesModule({ db, cache, logger })
src/modules/resources/index.ts        (module factory)
      │
      ▼   returns { router }
   app.use('/resources', router)
```

**`createApp(deps)` is load-bearing** for the integration test suite — `tests/integration/fixtures/app.ts` constructs it with clients pointed at Testcontainers. Its external contract is preserved verbatim by any refactor: it accepts `{ config, logger, db, redis }` and returns `{ app, healthRegistry }`. Do not rename, split, or move it without a corresponding test-suite change.

Module factories (`createResourcesModule`) own their layer wiring: they construct the repository, optionally wrap it with the cached decorator, construct the service, build the controller, and assemble the Express router. `buildApp` in `src/http/app.ts` does not reach into a module's internal files — it sees a single factory that returns a router.

## What This Architecture Is NOT

Explicit non-goals — choices that were considered and rejected for this codebase:

- **No Domain-Driven Design.** There is no `Resource` entity with behavior, no value objects, no aggregates, no domain events. The "domain" is *a row in the `resources` table plus validation rules*; a domain layer would be empty ceremony.
- **No separate `domain/` layer.** The Zod-inferred input types belong to presentation (request validation); the Kysely row type belongs to infrastructure (database shape). There is no behavioral domain type between them that would justify a fourth layer.
- **No dependency-injection container.** Manual DI through constructor arguments and factory functions is simpler and more traceable than InversifyJS / TypeDI / Tsyringe for the handful of injectables this project has.
- **No formal ports/adapters split.** The `ResourceRepository` TypeScript interface already functions as the port, and `CachedResourceRepository` as the adapter. A separate `*.port.ts` / `*.adapter.ts` filename convention would add files without adding clarity.
- **No CQRS.** Reads and writes go through the same repository methods and the same service. Splitting them would double the file count without a behavioral benefit.
- **No event sourcing.** State lives in Postgres rows. There is no append-only event log.
- **No TypeScript path aliases.** `@shared/*`, `@infra/*` were considered and rejected. Aliases add tsconfig + bundler + test-runner + IDE configuration surface for a small readability win. They can be added later if import paths become painful.

## Enforcement

Layer direction is enforced at build time via ESLint `no-restricted-imports` (and `@typescript-eslint/no-restricted-imports` where type-only escape hatches are needed). Violations are lint errors, not review-time comments.

Current rules, in plain English:

1. **Presentation cannot import from infrastructure directly.** Files under `src/modules/*/presentation/` may not import from `**/infrastructure/**`. Type-only imports (`import type`) are allowed so `presentation/mapper.ts` can reference `import type { Resource } from '../../../infrastructure/db/schema.js'`.

2. **Infrastructure cannot import from application or presentation.** Files under `src/modules/*/infrastructure/` may not import from `**/application/**` or `**/presentation/**`. Type-only imports are allowed so `cached-repository.ts` and `repository.ts` can reference `import type { RequestContext }` from `application/request-context.js`.

3. **Application cannot import from presentation.** Files under `src/modules/*/application/` may not import from `**/presentation/**` at all.

4. **Cross-module imports are forbidden.** Files under `src/modules/` may not reach across module boundaries. If two modules need to share code, extract it to `src/shared/`.

5. **`src/infrastructure/` and `src/shared/` cannot import from modules or transport.** These terminal layers must stay terminal.

6. **Composition layers are exempt.** `src/index.ts`, `src/app.ts`, and `src/http/app.ts` may import from any layer — they exist precisely to wire layers together.

7. **Tests are exempt.** Files under `tests/` may import from any layer.

## Adding a Feature

To add a new feature module `<feature>`:

1. `mkdir -p src/modules/<feature>/{presentation,application,infrastructure}`
2. Create `src/modules/<feature>/schema.ts` — Zod schemas and inferred DTO types. Use `.strict()` so unknown request fields fail loudly.
3. Create `src/modules/<feature>/infrastructure/repository.ts` — Kysely queries against the feature's table. The Kysely `Database` type in `src/infrastructure/db/schema.ts` must include the table first; update it before adding the repository.
4. Create `src/modules/<feature>/application/service.ts` — business orchestration. Accept the repository in its constructor; throw `AppError` subclasses from `src/shared/errors.ts` for failure cases.
5. Create `src/modules/<feature>/presentation/controller.ts` — per-route `RequestHandler` wrappers. Validate input with `schema.ts`, call the service, serialize with a sibling `mapper.ts` if the response shape differs from the DB row.
6. Create `src/modules/<feature>/presentation/router.ts` — mount the controller's handlers under an Express `Router`. Accept the controller as an argument (do not construct it here).
7. Create `src/modules/<feature>/index.ts` — export `create<Feature>Module(deps)` that constructs the repository → (cached wrapper, if applicable) → service → controller → router, and returns `{ router }`.
8. Wire the module into `src/http/app.ts`:
   ```ts
   import { createFeatureModule } from '../modules/<feature>/index.js';
   // inside buildApp:
   const feature = createFeatureModule({ db, logger, cache });
   app.use('/<feature>', feature.router);
   ```
9. Add tests under `tests/unit/modules/<feature>/{application,infrastructure}/` (mirror the source layout) and `tests/integration/<feature>/` (end-to-end through supertest). Tests may import from any layer.
10. Run `pnpm check` and `pnpm test` — both must pass.

The layering rules are enforced automatically — if step 5's controller reaches into step 3's repository directly, ESLint will fail the build. Route through the application layer.
