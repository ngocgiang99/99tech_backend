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
| `mise run check` | Typecheck + lint — **must pass before committing** |
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

## Project Structure

```
src/
  config/
    env.ts            # Zod-validated environment configuration
  db/
    client.ts         # Kysely + pg Pool factory
    health.ts         # DB health check (SELECT 1 with 1s timeout)
    schema.ts         # Kysely Database type definitions
  http/
    app.ts            # Express application factory
    routes/
      health.ts       # GET /healthz endpoint
  lib/
    errors.ts         # AppError taxonomy (ValidationError, NotFoundError, ConflictError)
    health.ts         # HealthCheckRegistry
    logger.ts         # Pino JSON logger
    shutdown.ts       # Graceful shutdown manager
  middleware/
    error-handler.ts  # Central error handler (maps AppError → spec shape)
    request-id.ts     # X-Request-Id propagation middleware
  modules/
    resources/
      cursor.ts       # Keyset cursor encode/decode
      controller.ts   # Express RequestHandler wrappers (Zod → service → HTTP)
      repository.ts   # Kysely-backed ResourceRepository
      router.ts       # Mounts 5 endpoints at /resources
      schema.ts       # Zod schemas: Create/Update/List/Resource
      service.ts      # Business logic (throws typed errors)
  index.ts            # Process entry point
migrations/
  0001_create_resources.ts  # Creates resources table + 5 indexes
kysely.config.ts      # kysely-ctl migration config
```

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
