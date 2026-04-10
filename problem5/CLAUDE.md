# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory (`problem5/` — the Resources API).

This directory is one of several sibling problem solutions under the parent `99tech_backend` home-assignment repo. Scope all work described here to `problem5/`; sibling directories (`problem-4/`, other worktrees) are unrelated.

## Resources API

ExpressJS 5 + TypeScript CRUD service backed by Postgres (Kysely) and Redis, built as an ESM project (`"type": "module"`, Node 22+, pnpm 9+).

### Commands

Day-to-day commands are exposed as **mise tasks** (see `mise.toml`). Run
`mise tasks` to list them all. The underlying `package.json` scripts and
`docker compose` invocations still exist — mise is a thin wrapper so the
Dockerfile and CI can call `pnpm` / `docker` directly — but prefer
`mise run <task>` when working locally so everyone hits the same commands.

```bash
# Dev loop
mise run dev                # tsx watch src/index.ts — live reload
mise run dev:pretty         # same, piped through pino-pretty
mise run check              # typecheck + lint — MUST pass before committing
mise run lint               # eslint src --ext .ts
mise run format             # prettier --write src
mise run build              # tsc --project tsconfig.build.json → dist/
mise run start              # node dist/index.js (requires build)
mise run install            # pnpm install --frozen-lockfile

# Database migrations (Kysely via kysely-ctl, reads kysely.config.ts)
mise run db:migrate                    # kysely migrate:latest
mise run db:rollback                   # kysely migrate:rollback
mise run db:reset                      # rollback + latest
mise run db:make -- <description>      # Create new migration file
                                       # → emits migrations/YYYYMMDD_HHMMSS_<description>.ts (UTC)

# Full stack via Docker
mise run up                 # api + postgres + redis, private network, healthchecks
mise run up:build           # same, rebuilding images first
mise run ps                 # docker compose ps
mise run down               # stop containers, keep volumes
mise run down:volumes       # stop + wipe volumes
mise run fresh              # down:volumes → up:build (full reset)
mise run docker:build       # build runtime image standalone (no compose)
mise run health             # curl /healthz against the running stack
docker compose logs -f api  # tail api logs (no mise wrapper — use direct)

# Escape hatch — call pnpm / docker directly if you need a flag not exposed
pnpm <script>               # package.json scripts are still there
docker compose <subcommand> # still works, mise doesn't shadow it
```

Toolchain is pinned via `mise.toml` (Node 22, pnpm 9, k6, OpenSpec CLI). Run `mise install` to match. ESM imports in `src/` use explicit `.js` suffixes — preserve this when adding new imports.

There is **no test runner wired up yet** (tests arrive in OpenSpec change `s04-add-test-suite`). Do not add `pnpm test` invocations until that change lands.

### Architecture

`src/index.ts` is the composition root — it wires config, logger, DB pool, health registry, shutdown manager, and Express app in strict order, then delegates signal handling to `ShutdownManager`. **All dependencies are constructor-injected**; there are no module-level singletons. When adding new wiring, follow the numbered `main()` sequence.

**Layered request path:**

```
HTTP → requestIdMiddleware → pino-http → express.json(64kb)
     → route (e.g. /resources) → controller → service → repository → Kysely → pg.Pool
     → errorHandler (last middleware)
```

**Feature modules** live under `src/modules/<name>/` with a fixed file set: `router.ts` (wires DI, mounts routes), `controller.ts` (Zod validation, DTO mapping, calls service), `service.ts` (business rules, throws `AppError`), `repository.ts` (Kysely queries, returns DB rows), `schema.ts` (Zod + DTOs), and optional helpers like `cursor.ts`. `src/modules/resources/` is the canonical example — new modules should mirror its shape.

**Error handling** is centralized. Throw `AppError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`) from `src/lib/errors.ts`; the middleware in `src/middleware/error-handler.ts` serializes them into `{ error: { code, message, requestId, details? } }` responses. **Never** construct JSON error bodies in controllers — `next(err)` and let the handler format it. The handler also intercepts body-parser `entity.too.large` / `entity.parse.failed` as 400 `VALIDATION` errors.

**Validation boundary** is the controller. `*.safeParse()` → on failure, `handleZodError()` → `ValidationError` with per-field details. DB row → response DTO conversion happens via module-local `toDto()` helpers that rename `owner_id`/`created_at` to camelCase and ISO-serialize dates. Keep this boundary: repositories return raw DB types; everything past the controller should see DTOs.

**Kysely schema** lives in `src/db/schema.ts` as a typed `Database` interface. Add new tables here and extend `Database`. Migrations are TypeScript files in `migrations/` (see `0001_create_resources.ts` for the pattern). `kysely.config.ts` at the project root is consumed by `kysely-ctl` at CLI time and requires `DATABASE_URL` in the environment.

**Migration filenames** use a UTC datetime prefix — `YYYYMMDD_HHMMSS_<description>.ts` — configured via `getMigrationPrefix` in `kysely.config.ts`. Create new migrations with `pnpm exec kysely migrate:make <description>`. Kysely sorts migrations lexicographically, so any zero-padded datetime prefix yields chronological order. The legacy `0001_create_resources.ts` still sorts before any datetime file, so the two formats coexist safely — do not retroactively rename it.

**Kysely has no schema auto-diff.** Unlike Prisma Migrate, Drizzle Kit, TypeORM `schema:sync`, or Atlas, Kysely does not generate migrations from a model definition. The canonical workflow is hand-authored migrations as the source of truth, and — if needed — regenerating `src/db/schema.ts` from the live database via `kysely-codegen`. Treat `schema.ts` as generated output whenever you use codegen; do not hand-edit it in the same PR as a migration that changes its shape. See README §Database Migrations for the workflow.

**List/pagination** uses keyset (cursor) pagination, not offset. The cursor is an opaque string encoding `{ createdAt, id, sort }`; the service decodes it and hands a typed payload to the repository, which builds a composite `WHERE` predicate over `(sort_column, id)` to guarantee stable ordering across sort modes (see `repository.ts:applyCursorPredicate`). Preserve this pattern when adding sortable list endpoints.

**Config** is validated once at startup by `loadConfig()` in `src/config/env.ts` using Zod. On failure the process exits with a formatted error before the logger is even created. Add new env vars to the Zod schema, `.env.example`, and the README table together.

**Graceful shutdown** is driven by `ShutdownManager` (`src/lib/shutdown.ts`). Register hooks in reverse-of-startup order in `index.ts` (HTTP server first, then DB pool). Shutdown is bounded by `SHUTDOWN_TIMEOUT_MS`.

**Health checks** use an extensible `HealthCheckRegistry` (`src/lib/health.ts`). Register checks in `index.ts` after creating each dependency. `GET /healthz?probe=liveness` is the fast path used by Docker healthchecks and should not hit dependencies.

### Work Tracking — OpenSpec

This project is planned and executed via **OpenSpec** change artifacts under `openspec/`:

- `openspec/changes/<id>/` — in-flight changes. Each has `proposal.md`, `design.md`, `specs/`, `tasks.md`. The `tasks.md` checklist is the source of truth for implementation progress.
- `openspec/specs/` — main specs (currently `project-bootstrap`, `local-dev-environment`). Changes produce delta specs that get synced here on archival.
- `openspec/changes/archive/` — completed changes (e.g. `2026-04-11-s01-add-project-scaffold`).

The active roadmap is `s02` (resources CRUD, currently being implemented) through `s08` (error handling). When implementing work, check `tasks.md` in the relevant change directory for the authoritative task list rather than inferring from code state. Use the `/opsx:*` skills (`/opsx:explore`, `/opsx:apply`, `/opsx_custom:verify`, `/opsx_custom:preflight`) for OpenSpec workflows — the team uses `/opsx:explore` as the starting point for new work and `/opsx_custom:verify` to validate implementations before archiving.

### Conventions Worth Preserving

- **ESM `.js` import suffixes** in TypeScript source (e.g. `import { foo } from './bar.js'`) — the project emits native ESM and this is required.
- **DI via factory functions**, not classes with static state. Routers take dependencies as arguments (`createResourcesRouter(db)`).
- **Strict Zod schemas** (`.strict()`) on request bodies so unknown keys fail loudly.
- **Body parser limit is 64 KB** — raising it requires reviewing the `VALIDATION` error path and the metadata size limits in `resources/schema.ts`.
- **64 KB request / 16 KB metadata** size caps are enforced at the Zod layer, not at the DB. If you relax one, check both.
