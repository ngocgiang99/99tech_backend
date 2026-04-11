# Resources API

An ExpressJS + TypeScript CRUD service backed by Postgres and Redis.

## Quick Start (5 steps)

**Prerequisites:** [mise](https://mise.jdx.dev/) and Docker / Docker Compose installed.

1. **Install the pinned toolchain**

   ```bash
   mise install
   ```

   This installs Node 22, pnpm 9, and k6 in exact versions pinned in `mise.toml`.
   First-time mise users, see the [*Don't have mise?*](#dont-have-mise) section below.

2. **Copy the environment template**

   ```bash
   cp .env.example .env
   ```

   The defaults in `.env.example` work out of the box for local development — no edits required.

3. **Start the full stack**

   ```bash
   docker compose up -d
   ```

   This starts three containers (`api`, `postgres`, `redis`) on a private Docker network. The API waits for Postgres and Redis to pass their healthchecks before starting.

4. **Run database migrations** (if running locally outside Docker)

   ```bash
   pnpm db:migrate
   ```

   Inside Docker Compose this runs automatically on container startup before the server starts.

5. **Verify the service is live**

   ```bash
   curl http://localhost:3000/healthz
   ```

   Expected response:

   ```json
   {"status":"ok","checks":{"db":{"status":"up"}}}
   ```

6. **You're done.** The API is accepting requests at `http://localhost:3000`.

## First Request

Create your first resource:

```bash
curl -s -X POST http://localhost:3000/resources \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-widget","type":"widget","tags":["demo"]}' | jq .
```

Sample response:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "my-widget",
  "type": "widget",
  "status": "active",
  "tags": ["demo"],
  "ownerId": null,
  "metadata": {},
  "createdAt": "2026-04-10T19:00:00.000Z",
  "updatedAt": "2026-04-10T19:00:00.000Z"
}
```

---

## Don't have mise?

Install it with the official one-line installer ([docs](https://mise.jdx.dev/getting-started.html)):

```bash
curl https://mise.run | sh
```

Activate mise in your current shell (one-time per shell config):

```bash
# zsh
echo 'eval "$(~/.local/bin/mise activate zsh)"' >> ~/.zshrc
exec zsh

# bash
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
exec bash

# fish
echo '~/.local/bin/mise activate fish | source' >> ~/.config/fish/config.fish
```

Then, in the project root:

```bash
mise trust          # one-time — approve the project's mise.toml
mise install        # install pinned versions of node, pnpm, k6
```

If you prefer not to use mise, manually install:
- **Node 22** (via nvm: `nvm install 22 && nvm use 22`)
- **pnpm 9** (`npm install -g pnpm@9`)
- **k6** (only needed for benchmarks — see [k6 install docs](https://k6.io/docs/get-started/installation/))
- Then run `pnpm install`

---

## Development Workflow

All day-to-day commands are exposed as **mise tasks**. Run `mise tasks` to see the
full catalog at any time. Tasks are thin wrappers over `pnpm` and `docker compose`,
so the Dockerfile and CI still call those directly — but as a developer you should
reach for `mise run <task>` first.

### Common tasks at a glance

| Command | What it does |
|---------|--------------|
| `mise run install` | Install Node deps (`pnpm install --frozen-lockfile`) |
| `mise run dev` | Start the API with live reload |
| `mise run dev:pretty` | Same, but with pretty-printed logs (pino-pretty) |
| `mise run check` | Typecheck + lint + unit tests + integration tests — **must pass before committing** (integration tests require a running Docker daemon) |
| `mise run lint` / `format` / `build` | Individual quality gates |
| `mise run start` | Run the compiled build (after `mise run build`) |
| `mise run up` / `up:build` | Start the full Docker stack (optionally rebuilding) |
| `mise run down` / `down:volumes` | Stop stack (keep / wipe volumes) |
| `mise run ps` | Show container status |
| `mise run health` | `curl /healthz` against the running stack |
| `mise run fresh` | Wipe volumes, rebuild, bring the stack up from scratch |
| `mise run docker:build` | Build the runtime image standalone (no compose) |
| `mise run db:migrate` / `db:rollback` / `db:reset` | Migration lifecycle |
| `mise run db:make -- <description>` | Create a new migration file |

### Run locally (without Docker)

```bash
cp .env.example .env    # one-time — tweak DATABASE_URL / REDIS_URL if needed
mise run install        # pnpm install --frozen-lockfile
mise run dev            # live reload via tsx watch
# or
mise run dev:pretty     # same, with pino-pretty output
```

### Run the full stack (with Docker)

```bash
mise run up                    # start api + postgres + redis in the background
docker compose logs -f api     # follow API container logs (direct — no mise wrapper)
mise run health                # confirm /healthz returns 200

mise run down                  # stop containers, keep volumes
mise run down:volumes          # stop + wipe volumes (fresh Postgres next time)
mise run fresh                 # one-shot: wipe volumes, rebuild, bring it all back up
```

> **Falling back to pnpm / docker directly.** Every mise task prints the underlying
> command it runs, so if you prefer to invoke `pnpm dev` or `docker compose up -d`
> by hand (or your IDE integration expects it), nothing is hiding from you. The
> `package.json` scripts in this repo are the implementation layer and are not
> going away.

---

## Running Tests

Tests are split into two layers with separate Vitest configs:

| Command | What it runs | Typical runtime |
|---------|--------------|-----------------|
| `pnpm test:unit` | Pure-logic unit tests under `tests/unit/` | &lt; 1 s |
| `pnpm test:integration` | Full HTTP stack against real Postgres + Redis (Testcontainers) | 5–30 s |
| `pnpm test` | Unit layer, then integration layer | 5–30 s |
| `pnpm test:watch` | Unit layer in watch mode (live reload on save) | — |
| `pnpm test:coverage` | Unit layer with v8 coverage + HTML report in `coverage/` | &lt; 2 s |

### Unit tests — fast, no Docker

```bash
pnpm test:unit
```

Covers pure logic that doesn't touch a database, a cache, or the network:
Zod schemas, cursor encode/decode, cache-key derivation, singleflight
coalescing, error-class-to-HTTP translation. The unit layer runs in well
under a second and is the right thing to bind to your editor on-save.

### Integration tests — real Postgres + Redis via Testcontainers

```bash
pnpm test:integration
```

**Prerequisite: a running Docker daemon.** Testcontainers boots a
`postgres:16-alpine` and a `redis:7-alpine` container per test run, applies
the migrations from `migrations/` to the fresh Postgres instance, and
constructs the Express app from `src/app.ts` with clients pointed at the
containers. Every test file goes through `supertest` so the entire middleware
chain (request-id, error-handler, `X-Cache`, body parser) is exercised
end-to-end.

State is reset between tests via `TRUNCATE resources RESTART IDENTITY` and
Redis `FLUSHDB` (see `tests/integration/fixtures/db.ts`). Containers are
started once per run and torn down on global teardown.

If Testcontainers cannot find Docker, the run fails fast with a clear error.
Make sure `docker ps` works before running this layer.

### Coverage

```bash
pnpm test:coverage
```

Runs the unit layer with v8 coverage collection and prints a table plus
writes an HTML report to `coverage/index.html`. The gate is set to **80%
line coverage** on the pure-logic modules covered by the unit layer;
wiring/router/repository/controller code is validated by the integration
layer, not the coverage gate.

### Debugging a failing integration test

```bash
# Verbose reporter — shows individual it() names as they run
pnpm test:integration --reporter=verbose

# Inspect Testcontainers logs live
DEBUG=testcontainers* pnpm test:integration
```

If a test hangs on startup, check that no stale containers are holding
port bindings from a previous run: `docker ps -a` and remove orphans.

---

## Benchmarks

Load scenarios live in `benchmarks/` and are driven by [k6](https://k6.io/)
(pinned to 0.56.0 via `mise.toml`). Results from a canonical run are
captured in [`Benchmark.md`](./Benchmark.md).

### Prerequisites

```bash
mise install              # installs Node 22 + pnpm 9 + k6 0.56.0
mise run up               # start api + postgres + redis
mise run health           # confirm /healthz is 200
pnpm bench:seed           # insert 10 000 resources and write benchmarks/seed/ids.json
```

`bench:seed` is idempotent — running it twice does not duplicate rows.
Pass `--clear` to truncate the bench pool before reseeding.

### Scenarios

| Command | What it runs |
|---|---|
| `pnpm bench:smoke` | 1 VU × 30 s sanity check; confirms the bench tooling is wired. |
| `pnpm bench:read` | `ramping-arrival-rate` 0 → 10k GET RPS over 5 min; records `X-Cache` telemetry. |
| `pnpm bench:write` | `constant-arrival-rate` 100 RPS, 60/30/10 POST/PATCH/DELETE blend. |
| `pnpm bench:mixed` | 95% GET / 5% write — matches the brief's primary workload. |
| `pnpm bench:spike` | 1k → 10k RPS over 10 s, 30 s hold, ramp down. |
| `pnpm bench:stress` | Ramps 1k RPS/min up to 10k RPS to find the saturation point. |
| `pnpm bench:cache:cold` | Same shape as `bench:read` but with Redis flushed. For a true cold baseline, also restart the API with `CACHE_ENABLED=false`. |
| `pnpm bench:cache:warm` | Pre-warms the cache via `setup()` (one GET per seed id) before running the read-load shape. |
| `pnpm bench:flush-cache` | Standalone Redis `FLUSHDB` — uses `REDIS_URL`. |

Every scenario enforces thresholds (`http_req_failed<0.01`,
`http_req_duration{expected_response:true} p(99)<500`) via the shared
`benchmarks/lib/thresholds.js` module. k6 exits non-zero on threshold
violation, so the same scripts can run in a CI smoke job later.

### Running the full cache comparison

```bash
# 1. Seed 10 000 resources
pnpm bench:seed

# 2. Cold baseline — Redis flushed AND CACHE_ENABLED=false on the API
docker exec resources-redis redis-cli FLUSHDB
# Restart the api container with CACHE_ENABLED=false (docker run / compose override)
pnpm bench:cache:cold

# 3. Warm baseline — cache enabled, setup() pre-warms every id
docker exec resources-redis redis-cli FLUSHDB
# Restart the api container with CACHE_ENABLED=true (default)
pnpm bench:cache:warm
```

The canonical Apple M4 Pro run captured in `Benchmark.md` shows a **~2× p50
latency improvement** with the warm cache (196 ms vs 403 ms) — the cache
earns its place on latency more than on raw RPS on a co-located laptop.

### Docker Compose profile (no local k6 install)

If you don't have k6 installed locally, the `bench` compose profile runs k6
inside a container against the API service on the same compose network:

```bash
# Start the stack (api + postgres + redis)
docker compose up -d

# Run the smoke scenario from a k6 sidecar — no local k6 needed
docker compose --profile bench run --rm k6 run /benchmarks/scenarios/smoke.js
```

The profile mounts `./benchmarks` into the container at `/benchmarks` and
sets `BASE_URL=http://api:3000`, so any scenario script works the same way.

### Resetting after a run

Bench rows accumulate in Postgres. For a clean slate:

```bash
mise run fresh          # down -v + up --build + re-migrate
pnpm bench:seed         # re-seed if you want to re-run
```

---

## Architecture

The Resources API is an Express 5 + TypeScript service backed by Postgres (Kysely) and Redis (ioredis). Five design decisions characterize it:

- **Layered decomposition.** Each feature module splits into `presentation` → `application` → `infrastructure`, with terminal cross-cutting layers (`src/shared/`, `src/infrastructure/`) holding driver-level primitives. Dependency direction is **lint-enforced** by ESLint `no-restricted-imports` — a violation is a build error, not a review comment.
- **Cache-aside with version-counter invalidation.** `GET /resources/:id` and `GET /resources` are wrapped by a `CachedResourceRepository` decorator over the Postgres repo. Detail entries use straightforward TTL + key DEL on write. List entries embed a monotonic `resource:list:version` counter in their key — every successful write does one Redis `INCR`, atomically invalidating every cached list page in one op (no `KEYS *` scanning).
- **Graceful degradation when Redis is unavailable.** Every Redis call is wrapped in `try`/`catch`. On failure the cache layer becomes a pass-through to Postgres, the request still succeeds, and the outage surfaces in `/healthz` rather than as a 500. Writes commit normally; cache invalidation failures are logged at `warn` and TTLs bound the staleness window.
- **Keyset (cursor) pagination, not offset.** `GET /resources` uses a composite `(created_at DESC, id DESC)` index with an opaque `nextCursor` token, so list latency stays flat regardless of how deep the caller paginates.
- **k6 benchmark suite as the performance contract.** Eight reusable k6 scenarios under `benchmarks/` cover smoke / read-load / write-load / mixed / spike / stress / cache-cold / cache-warm. The cache-cold vs cache-warm comparison is the empirical signal for whether the Redis layer earns its complexity cost. Methodology and laptop results live in [`Benchmark.md`](./Benchmark.md).

For the diagrams, data model, deployment topology, failure modes table, and the full layering rules, see → [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## API Endpoints

| Method | Path                       | Description              |
|--------|----------------------------|--------------------------|
| GET    | /healthz                   | Liveness + readiness     |
| GET    | /healthz?probe=liveness    | Liveness only (fast)     |
| POST   | /resources                 | Create a resource        |
| GET    | /resources                 | List resources (filtered, paginated) |
| GET    | /resources/:id             | Get resource by ID       |
| PATCH  | /resources/:id             | Partially update resource |
| DELETE | /resources/:id             | Delete resource          |

### List Resources — Filter Parameters

`GET /resources` accepts the following query parameters:

| Parameter      | Type     | Description                                                       |
|---------------|----------|-------------------------------------------------------------------|
| `type`        | string   | Exact match on `type` field                                       |
| `status`      | string   | Exact match on `status`; repeat for OR: `?status=active&status=pending` |
| `tag`         | string   | Tag must be present; repeat for AND: `?tag=red&tag=urgent` (all must match) |
| `ownerId`     | UUID     | Exact match on `ownerId`                                          |
| `createdAfter` | ISO-8601 | Inclusive lower bound on `createdAt`                             |
| `createdBefore` | ISO-8601 | Exclusive upper bound on `createdAt`                            |
| `limit`       | integer  | Page size `[1, 100]`, default `20`                                |
| `cursor`      | string   | Opaque keyset cursor from previous `nextCursor` response          |
| `sort`        | string   | One of: `-createdAt` (default), `createdAt`, `-updatedAt`, `updatedAt`, `name`, `-name` |

### Keyset Pagination

The list endpoint uses keyset (cursor-based) pagination, not offset. This ensures O(index-seek) performance regardless of page depth.

```bash
# First page
curl "http://localhost:3000/resources?limit=10"
# Response includes nextCursor: "eyJjcmVh..."

# Next page
curl "http://localhost:3000/resources?limit=10&cursor=eyJjcmVh..."
# When nextCursor is null, you have reached the last page
```

**Important:** The cursor is opaque — do not parse or modify it. If you change the `sort` parameter, the cursor from the previous sort becomes invalid and the server will return a `400 VALIDATION` error.

---

## Environment Variables

All variables are listed in `.env.example` with their defaults.

| Variable                        | Required | Default                                            | Description                         |
|---------------------------------|----------|----------------------------------------------------|-------------------------------------|
| `NODE_ENV`                      | No       | `development`                                      | Runtime environment                 |
| `PORT`                          | No       | `3000`                                             | HTTP listener port                  |
| `LOG_LEVEL`                     | No       | `info`                                             | Pino log level                      |
| `DATABASE_URL`                  | **Yes**  | `postgresql://postgres:postgres@localhost:5432/...` | Postgres connection URL             |
| `DB_POOL_MAX`                   | No       | `10`                                               | Max Postgres pool connections       |
| `REDIS_URL`                     | **Yes**  | `redis://localhost:6379`                           | Redis connection URL                |
| `CACHE_ENABLED`                 | No       | `true`                                             | Kill switch for the Redis cache     |
| `CACHE_DETAIL_TTL_SECONDS`      | No       | `300`                                              | TTL for `GET /resources/:id` cache  |
| `CACHE_LIST_TTL_SECONDS`        | No       | `60`                                               | TTL for `GET /resources` list cache |
| `CACHE_LIST_VERSION_KEY_PREFIX` | No       | `resource:list:version`                            | Redis key for list version counter  |
| `SHUTDOWN_TIMEOUT_MS`           | No       | `10000`                                            | Max ms to drain before force-exit   |
| `METRICS_ENABLED`               | No       | `true`                                             | Master toggle for Prometheus metrics. When `false`, `/metrics` is not mounted and the HTTP/cache/db instrumentation does nothing. |
| `METRICS_DEFAULT_METRICS`       | No       | `true`                                             | Whether to collect `prom-client`'s default Node.js metrics (CPU, heap, event loop lag, GC). Disable for narrower `/metrics` output. |
| `LOG_SCRUBBER_EXTRA_HEADERS`    | No       | (empty)                                            | Comma-separated extra header names to redact from error logs in addition to the built-in denylist (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `proxy-authorization`). Case-insensitive. |

### Database Migrations

```bash
mise run db:migrate                # Apply all pending migrations
mise run db:rollback               # Rollback the last migration
mise run db:reset                  # Rollback + re-apply all migrations
mise run db:make -- <description>  # Create a new migration file
```

**Migration filename format:** new migrations are prefixed with a UTC datetime in the
form `YYYYMMDD_HHMMSS_<description>.ts` (configured via `getMigrationPrefix` in
`kysely.config.ts`). For example, `mise run db:make -- add_users` generates
something like `migrations/20260411_143022_add_users.ts`. Kysely sorts migrations
lexicographically, so UTC datetime prefixes guarantee chronological execution order.
The legacy numeric file (`0001_create_resources.ts`) still sorts before any
datetime-prefixed file, so existing and new migrations coexist safely.

---

## Caching

`GET /resources/:id` and `GET /resources` are served through a Redis cache layer
implemented as a decorator over the Postgres repository. The cache is transparent
to callers — response bodies are identical whether the data came from Redis or
Postgres — but an `X-Cache` response header reports the outcome on every GET.

### Strategy

- **Cache-aside** (lazy). Reads check Redis first; on miss, the query runs
  against Postgres and the result is written back with a TTL. Writes commit
  to Postgres first, then invalidate affected cache entries.
- **Detail caching** (`GET /:id`). Keyed as `resource:v1:id:{uuid}`, TTL
  `CACHE_DETAIL_TTL_SECONDS` (default 300 s). Deleted on `PATCH` / `DELETE`.
- **List caching** (`GET /resources`). Keyed as
  `resource:v1:list:{version}:{sha256-16(normalizedFilters)}`, TTL
  `CACHE_LIST_TTL_SECONDS` (default 60 s). Filter tuples are normalized
  (keys sorted, array values sorted) before hashing, so `?status=a&status=b`
  and `?status=b&status=a` resolve to the same cache entry.
- **List invalidation via a version counter.** Instead of tracking which
  list pages contain a given resource, a single counter
  (`resource:list:version`) is embedded in every list key. Any write
  `INCR`s it, so every subsequent list request constructs a key with the
  new version and misses. Old keys orphan-expire via their TTL within 60 s.
  This trades a tiny amount of wasted Redis memory for near-zero
  invalidation bookkeeping.
- **In-process singleflight.** Concurrent cache misses on the same key
  coalesce into a single upstream query via an in-memory promise map,
  so a burst of N identical requests triggers at most one Postgres read.

### Graceful degradation

Every Redis operation is wrapped in try/catch. On failure the service logs
at `warn` and falls through to Postgres — reads survive and writes still
commit. The `cache` check on `/healthz` reports the outage separately, so
a Redis outage does **not** take down the GET path.

### `X-Cache` response header

When `NODE_ENV !== 'production'`, every successful `GET` on a resource route
carries an `X-Cache` header:

| Value    | Meaning                                                       |
|----------|---------------------------------------------------------------|
| `HIT`    | Served from Redis.                                            |
| `MISS`   | Fell through to Postgres; result was cached for next request. |
| `BYPASS` | The cache is disabled (`CACHE_ENABLED=false`).                |

```bash
curl -i http://localhost:3000/resources/{id} | grep X-Cache
# First call  → X-Cache: MISS
# Second call → X-Cache: HIT
# After PATCH → X-Cache: MISS  (detail entry was invalidated)
```

**Production suppression.** In `NODE_ENV=production` the header is omitted
to avoid disclosing cache state to clients (mild fingerprinting and
cache-poisoning recon signal). The cache layer still runs — only the
observability header is silenced. S05 benchmarks run against a
`NODE_ENV=development` target so k6 can still assert hit rates.

### Kill switch: `CACHE_ENABLED=false`

Starting the service with `CACHE_ENABLED=false` skips the cache layer
entirely: every GET runs against Postgres and responds with `X-Cache: BYPASS`,
and Redis is never read or written for resource data. The `cache` health
check still runs, because operators still want to know whether Redis
itself is reachable.

```bash
CACHE_ENABLED=false mise run dev
```

---

## Observability

The service exposes Prometheus metrics at `GET /metrics` in text exposition
format (`text/plain; version=0.0.4`). Metrics cover four layers:

- **HTTP:** `http_request_duration_seconds` (histogram) and
  `http_requests_total` (counter), labeled by `method`, `route` (Express
  route pattern — `/resources/:id`, NOT the raw URL), and `status_code`.
- **Cache:** `cache_operations_total{operation,result}` and
  `cache_operation_duration_seconds{operation}` — `operation` ∈
  `get|set|del|incr`, `result` ∈ `hit|miss|error`.
- **Database:** `db_query_duration_seconds{operation}`,
  `db_query_errors_total{operation,error_class}`, and `db_pool_size{state}`
  (sampled every 5 s). `operation` ∈ `select|insert|update|delete`;
  `error_class` is a bounded allowlist (Postgres SQLSTATE → named class;
  anything not listed collapses to `other`).
- **Domain:** `resources_operations_total{operation,outcome}` — `operation`
  ∈ `create|read|list|update|delete`, `outcome` ∈
  `success|not_found|validation_error|error`.

All label values come from service-controlled allowlists; no user input
(URL path, header, error message) ever becomes a label value directly.
This is what keeps the metrics cardinality bounded at `routes × methods ×
status codes` regardless of how many distinct UUIDs the API sees at
runtime — one of the cardinality tests in the integration suite
explicitly fires 25 requests with different UUIDs and asserts the
resulting `route` set stays under 10.

### Toggling metrics

```bash
# Default: metrics enabled, including prom-client's Node.js defaults.
mise run dev

# Skip Node.js defaults for narrower output (still emits custom metrics).
METRICS_DEFAULT_METRICS=false mise run dev

# Kill switch: /metrics is not mounted; instrumentation is a no-op.
METRICS_ENABLED=false mise run dev
```

### Running Prometheus locally

Docker Compose ships a `metrics` profile that brings up a pinned
`prom/prometheus:v2.54.1` container scraping `http://api:3000/metrics`
every 5 s. Scrape history is kept in a named volume so it survives
`down` / `up` cycles. Wipe with `docker compose down -v`.

```bash
# Bring up api + postgres + redis + prometheus
docker compose --profile metrics up -d

# Open the Prometheus UI
open http://localhost:9090

# Inside the UI, try these queries:
#   up{job="resources-api"}                              — target health
#   rate(http_requests_total[1m])                        — RPS by route
#   histogram_quantile(0.99, sum by (le, route)         — p99 per route
#     (rate(http_request_duration_seconds_bucket[5m])))
#   sum(rate(cache_operations_total{result="hit"}[1m])) — cache hit/s
#     / sum(rate(cache_operations_total{operation="get"}[1m]))
```

The scrape config at `deploy/prometheus/prometheus.yml` is deliberately
minimal — one job, no recording rules, no alerts. Extend it in a follow-up
change when specific SLOs are worth codifying.

### PromQL cheat sheet

| Question                                    | Query                                                                                                               |
|---------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| Request rate per route (last 1 m)           | `sum by (route) (rate(http_requests_total[1m]))`                                                                    |
| p99 latency per route (last 5 m)            | `histogram_quantile(0.99, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))`                     |
| Error rate (5xx) per route                  | `sum by (route) (rate(http_requests_total{status_code=~"5.."}[1m]))`                                                |
| Cache hit rate (last 1 m)                   | `sum(rate(cache_operations_total{operation="get",result="hit"}[1m])) / sum(rate(cache_operations_total{operation="get"}[1m]))` |
| DB pool utilization                         | `db_pool_size{state="idle"} / db_pool_size{state="total"}`                                                          |

### Production considerations

On a public internet deployment, `/metrics` should NOT be reachable from
untrusted networks — it exposes internal request volumes, route names,
and database error classes that are useful to an attacker doing recon.
Options, in order of preference:

1. **Separate port.** Run a second Express listener on an internal-only
   port (e.g. `9091`) that only hosts the metrics router, firewall the
   main port. Cleanest in production, skipped here because a
   local-dev-first brief doesn't need it.
2. **Interface binding.** Bind `/metrics` to `127.0.0.1` or an internal
   interface at the process level. Requires a reverse proxy in front.
3. **Reverse proxy ACL.** Let nginx/Envoy/Caddy strip the `/metrics`
   path from public traffic and allow it only from the scraper's
   network.

`METRICS_ENABLED=false` is the nuclear option: it short-circuits
instrumentation entirely (zero overhead), which is useful for a
head-to-head benchmark of "how much does Prometheus cost me?". The
`Benchmark.md` cold/warm comparison was run with metrics off; an
S07-follow-up comparison run would make the answer explicit.

---

## Error Contract

Every error response on this API matches a fixed shape. Clients should
treat the `code` field as the stable contract — strings in `message` are
human-readable but may evolve, while `code` values never change without a
deprecation cycle.

### Response shape

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Request validation failed",
    "requestId": "f7c9a2b1-3e4d-4a5b-9c8d-1e2f3a4b5c6d",
    "details": [
      { "path": "name", "code": "too_small", "message": "String must contain at least 1 character(s)" }
    ]
  }
}
```

Field rules:

| Field        | Always present? | Notes                                                                 |
|--------------|-----------------|-----------------------------------------------------------------------|
| `code`       | Yes             | One of the eight stable codes in the table below.                     |
| `message`    | Yes             | Human-readable, ≤ 200 chars (truncated with `...` when longer).       |
| `requestId`  | Yes             | Echoed from `X-Request-Id`; correlates the response with access logs. |
| `details`    | Only `VALIDATION` | Array of `{path, code, message}` per failed field.                  |
| `errorId`    | Only `5xx`      | UUID; matches the `errorId` in the dev-log entry for the same error.  |

The body is built from an **allowlist** in
`src/shared/to-public-response.ts`. Implementation details (stack frames,
file paths, SQL fragments, library names, raw exception text) are never
copied through, even when the underlying error contains them.
`tests/integration/errors/leak.test.ts` actively scans error bodies for
known leak indicators (`pg`, `kysely`, `SELECT `, `node_modules`, …) and
fails the build if any appear.

### Stable error codes

| Code                       | HTTP | When                                                                | Example response |
|----------------------------|------|---------------------------------------------------------------------|------------------|
| `VALIDATION`               | 400  | Request body / query / params fail Zod validation.                  | `{"error":{"code":"VALIDATION","message":"Request validation failed","requestId":"…","details":[{"path":"name","code":"too_small","message":"…"}]}}` |
| `BAD_REQUEST`              | 400  | Request is structurally invalid (malformed JSON, oversized body).   | `{"error":{"code":"VALIDATION","message":"Request body is malformed JSON","requestId":"…"}}` (body-parser failures normalize to `VALIDATION`) |
| `NOT_FOUND`                | 404  | Resource id does not exist.                                         | `{"error":{"code":"NOT_FOUND","message":"Resource not found","requestId":"…"}}` |
| `CONFLICT`                 | 409  | Unique-constraint violation, optimistic-lock failure.               | `{"error":{"code":"CONFLICT","message":"Resource conflict","requestId":"…"}}` |
| `UNPROCESSABLE_ENTITY`     | 422  | Request is well-formed but semantically rejected by the domain.     | `{"error":{"code":"UNPROCESSABLE_ENTITY","message":"Unprocessable entity","requestId":"…"}}` |
| `RATE_LIMIT`               | 429  | Reserved — no rate limiter wired in this revision.                  | `{"error":{"code":"RATE_LIMIT","message":"Too many requests","requestId":"…"}}` |
| `DEPENDENCY_UNAVAILABLE`   | 503  | Postgres deadlock, connection-pool exhaustion, query cancelled.     | `{"error":{"code":"DEPENDENCY_UNAVAILABLE","message":"Upstream dependency is temporarily unavailable","requestId":"…"}}` |
| `INTERNAL_ERROR`           | 500  | Anything unhandled. Always returns the generic message + `errorId`. | `{"error":{"code":"INTERNAL_ERROR","message":"Internal server error","requestId":"…","errorId":"…"}}` |

The full enum lives in `src/shared/error-codes.ts` as an `as const`
tuple, with the HTTP-status mapping in `ERROR_CODE_META`. New codes are
appended to the tuple; existing codes are never removed or renamed.

### `errorId` correlation flow

When a request hits a 5xx, the middleware:

1. Generates one UUID via `crypto.randomUUID()` — call it `errorId`.
2. Writes a `pino` log entry at `error` level whose JSON payload includes
   the `errorId`, the full error class, message, stack, walked `cause`
   chain, request id, route pattern, sanitized headers, query, body
   metadata (size + content type, never bytes), user-agent, remote
   address, and timestamp. See `src/shared/error-metadata.ts` for the
   exact field list.
3. Returns the same `errorId` in the response body.

A user reports "I got error `c9f1…`". An engineer pipes the JSON logs
through `jq 'select(.errorId == "c9f1…")'` and gets the full request
context immediately, without needing to reproduce the failure.

`errorId` is **only** present on 5xx responses. 4xx responses are the
client's fault and don't need server-side correlation; adding the field
to every response would create false-positive noise in alerting and
double UUID generation per request for no operational benefit.

### Sensitive header scrubbing

Before any error metadata is logged, request headers are passed through
`scrubHeaders()` (`src/shared/sanitizer.ts`). The built-in denylist is
case-insensitive and contains:

```
authorization, cookie, set-cookie, x-api-key, x-auth-token, proxy-authorization
```

Matching values become the literal string `"[REDACTED]"`. Operators can
extend the list at deploy time without a code change via the
`LOG_SCRUBBER_EXTRA_HEADERS` env var (comma-separated, also
case-insensitive). For example:

```bash
LOG_SCRUBBER_EXTRA_HEADERS=x-internal-secret,x-jwt-bearer
```

The scrubber operates on a denylist, but the surrounding **log payload**
operates on an allowlist: only fields explicitly built into
`buildErrorMetadata` are ever logged. Request bodies are never logged —
only `body.size` and `body.contentType`. The two strategies are
complementary: the allowlist prevents structural leaks, the denylist
prevents header-value leaks.

### How to throw errors in this codebase

Application code throws typed `AppError` subclasses; raw `throw new
Error(...)` is forbidden across the module boundary and a unit test
asserts every service-layer error is an `instanceof AppError`. The
infrastructure layer (`src/infrastructure/db/error-mapper.ts`) translates
Postgres errors into `AppError` subclasses at the data-access boundary,
so the service layer only ever sees typed errors. The middleware's job
is then reduced to: wrap any remaining unknown error in `InternalError`,
log, format response.
