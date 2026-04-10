# Architecture

This document describes the layered architecture of the Resources API. It is the authoritative reference for directory layout, dependency direction, layer enforcement, and the decisions behind what this project explicitly does *not* do.

For day-to-day commands and the project's operational surface, see [`README.md`](./README.md). For project-specific conventions that affect automated tooling, see [`CLAUDE.md`](./CLAUDE.md).

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
│   ├── request-id.ts
│   └── x-cache.ts
├── modules/
│   └── resources/                       # Feature module: resources
│       ├── presentation/                # HTTP adapters — router, controller, mapper
│       │   ├── router.ts
│       │   ├── controller.ts
│       │   └── mapper.ts                # toDto: DB row → response DTO
│       ├── application/                 # Business orchestration, cursor, request context
│       │   ├── service.ts
│       │   ├── cursor.ts
│       │   └── request-context.ts
│       ├── infrastructure/              # Feature-local data access + caching
│       │   ├── repository.ts
│       │   ├── cached-repository.ts
│       │   └── cache-keys.ts
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

2. **Infrastructure cannot import from application or presentation.** Files under `src/modules/*/infrastructure/` may not import from `**/application/**` or `**/presentation/**`. Type-only imports are allowed so `cached-repository.ts` can reference `import type { RequestContext }` and `repository.ts` can reference `import type { CursorPayload }`.

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
