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

4. **Verify the service is live**

   ```bash
   curl http://localhost:3000/healthz
   ```

   Expected response:

   ```json
   {"status":"ok","checks":{}}
   ```

5. **You're done.** The API is accepting requests at `http://localhost:3000`.

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
  http/
    app.ts            # Express application factory
    routes/
      health.ts       # GET /healthz endpoint
  lib/
    health.ts         # HealthCheckRegistry (extensible for DB/Redis checks)
    logger.ts         # Pino JSON logger
    shutdown.ts       # Graceful shutdown manager
  middleware/
    error-handler.ts  # Central error handler middleware
    request-id.ts     # X-Request-Id propagation middleware
  modules/            # Feature modules land here (Change 2+)
  index.ts            # Process entry point
```

---

## API Endpoints

| Method | Path                       | Description              |
|--------|----------------------------|--------------------------|
| GET    | /healthz                   | Liveness + readiness     |
| GET    | /healthz?probe=liveness    | Liveness only (fast)     |

Resource CRUD endpoints are introduced in Change 2.

---

## Environment Variables

All variables are listed in `.env.example` with their defaults.

| Variable              | Required | Default                                            | Description                        |
|-----------------------|----------|----------------------------------------------------|-------------------------------------|
| `NODE_ENV`            | No       | `development`                                      | Runtime environment                |
| `PORT`                | No       | `3000`                                             | HTTP listener port                 |
| `LOG_LEVEL`           | No       | `info`                                             | Pino log level                     |
| `DATABASE_URL`        | **Yes**  | `postgresql://postgres:postgres@localhost:5432/...` | Postgres connection URL            |
| `REDIS_URL`           | **Yes**  | `redis://localhost:6379`                           | Redis connection URL               |
| `SHUTDOWN_TIMEOUT_MS` | No       | `10000`                                            | Max ms to drain before force-exit  |
