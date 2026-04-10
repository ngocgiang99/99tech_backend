# Resources API

An ExpressJS + TypeScript CRUD service backed by Postgres and Redis.

## Quick Start (5 steps)

**Prerequisites:** [mise](https://mise.jdx.dev/) and Docker / Docker Compose installed.

1. **Install the pinned toolchain**

   ```bash
   mise install
   ```

   This installs Node 22, pnpm 9, k6, and the OpenSpec CLI in exact versions pinned in `mise.toml`.

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

Install it with:

```bash
curl https://mise.run | sh
```

Then restart your shell and run `mise install` in the project root.

If you prefer not to use mise, manually install:
- **Node 22** (via nvm: `nvm install 22 && nvm use 22`)
- **pnpm 9** (`npm install -g pnpm@9`)
- Then run `pnpm install`

---

## Development Workflow

### Run locally (without Docker)

```bash
# Install dependencies
pnpm install

# Copy .env and configure DATABASE_URL / REDIS_URL to point at local instances
cp .env.example .env

# Start with live reload
pnpm dev
```

For readable logs during development, pipe through `pino-pretty`:

```bash
pnpm dev | npx pino-pretty
```

### Code quality checks

```bash
pnpm check          # typecheck + lint (must pass before committing)
pnpm typecheck      # TypeScript type check only
pnpm lint           # ESLint only
pnpm format         # Prettier format (auto-fixes)
pnpm build          # Compile TypeScript to dist/
```

### Docker operations

```bash
docker compose up -d          # Start the full stack in background
docker compose logs -f api    # Follow API logs
docker compose down           # Stop containers (volumes persist)
docker compose down -v        # Stop containers AND remove volumes
docker build -t resources-api .   # Rebuild the image
```

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

| Variable              | Required | Default                                            | Description                        |
|-----------------------|----------|----------------------------------------------------|-------------------------------------|
| `NODE_ENV`            | No       | `development`                                      | Runtime environment                |
| `PORT`                | No       | `3000`                                             | HTTP listener port                 |
| `LOG_LEVEL`           | No       | `info`                                             | Pino log level                     |
| `DATABASE_URL`        | **Yes**  | `postgresql://postgres:postgres@localhost:5432/...` | Postgres connection URL            |
| `DB_POOL_MAX`         | No       | `10`                                               | Max Postgres pool connections      |
| `REDIS_URL`           | **Yes**  | `redis://localhost:6379`                           | Redis connection URL               |
| `SHUTDOWN_TIMEOUT_MS` | No       | `10000`                                            | Max ms to drain before force-exit  |

### Database Migrations

```bash
pnpm db:migrate        # Apply all pending migrations
pnpm db:migrate:down   # Rollback all migrations
pnpm db:reset          # Rollback + re-apply all migrations
```
