# module-layered-architecture

## Purpose

Defines how the project organizes source code into layers: which directory
holds which kind of file, how feature modules are internally structured,
how dependencies flow between layers, how that direction is enforced at
build time, and how modules expose themselves to the composition root. The
goal is to make the architecture visible from the top-level `src/` listing
— a contributor should be able to open `src/` and understand the layering
without reading any source file.

This capability is deliberately *module-first*: each feature under
`src/modules/<name>/` owns a complete internal `presentation/application/
infrastructure/` slice, colocating the files a reader needs to understand
a single feature. Cross-cutting primitives live in `src/shared/` and
driver-level adapters in `src/infrastructure/`; both are terminal (modules
import them, they never import modules). A per-module factory
(`createResourcesModule` and peers) plugs into the existing `createApp` →
`buildApp` composition chain so the test suite's DI contract is preserved.

## Requirements

### Requirement: Top-Level Directory Layout

The project's `src/` directory SHALL contain the following top-level entries and no others: `config/`, `shared/`, `infrastructure/`, `http/`, `middleware/`, `modules/`, `app.ts`, and `index.ts`. Every source file in the project SHALL reside within one of these top-level scopes.

#### Scenario: Top-level listing is readable at a glance

- **WHEN** a contributor runs `ls src/` on a freshly checked-out branch after this change
- **THEN** the output lists exactly `config`, `shared`, `infrastructure`, `http`, `middleware`, `modules`, `app.ts`, `index.ts`
- **AND** no `src/cache/` or `src/db/` or `src/lib/` directory exists
- **AND** no loose `.ts` file exists directly in `src/` other than `app.ts` and `index.ts`

#### Scenario: Adding a file requires picking a top-level scope

- **WHEN** a contributor adds a new source file
- **THEN** the file must be placed inside one of the top-level entries
- **AND** the placement is guided by the file's role (config, cross-cutting primitive, driver, transport, middleware, feature, DI factory, or composition root)

### Requirement: Top-Level Infrastructure Holds Driver-Level Primitives

`src/infrastructure/` SHALL hold driver-level infrastructure that is shared across all feature modules: the database client and health check, the cache client, health check, and cache-level utilities. `src/infrastructure/` SHALL NOT contain feature-specific adapters (those live inside the respective module's own `infrastructure/` layer).

#### Scenario: DB client lives in src/infrastructure/db

- **WHEN** a reader opens `src/infrastructure/db/`
- **THEN** it contains `client.ts`, `health.ts`, and `schema.ts` (the Kysely Database interface)
- **AND** it does not contain any file referencing a specific feature table's queries

#### Scenario: Cache client lives in src/infrastructure/cache

- **WHEN** a reader opens `src/infrastructure/cache/`
- **THEN** it contains `client.ts`, `health.ts`, and `singleflight.ts`
- **AND** it does not contain any file referencing feature-specific cache keys

#### Scenario: Feature repository does not live at top level

- **WHEN** a reader searches `src/infrastructure/` for `resources.repository.ts` or similar
- **THEN** no such file exists
- **AND** the resources repository is found at `src/modules/resources/infrastructure/repository.ts`

### Requirement: Shared Directory Holds Cross-Cutting Primitives

`src/shared/` SHALL hold framework-agnostic primitives used by multiple layers and modules: error types, the health-check registry, the logger factory, and the shutdown manager. It SHALL NOT hold HTTP-specific code, DB-specific code, or feature-specific code.

#### Scenario: Errors, health, logger, shutdown live in shared

- **WHEN** a reader opens `src/shared/`
- **THEN** it contains at minimum `errors.ts`, `health.ts`, `logger.ts`, and `shutdown.ts`
- **AND** every file in `src/shared/` is framework-agnostic (no Express types, no Kysely types, no Redis client imports)

#### Scenario: No src/lib/ directory exists

- **WHEN** a reader checks for `src/lib/`
- **THEN** the directory does not exist
- **AND** every file formerly in `src/lib/` is now in `src/shared/` with its contents unchanged

### Requirement: Feature Modules Use Internal Three-Layer Structure

Every feature module under `src/modules/` SHALL organize its files into three internal layer directories: `presentation/`, `application/`, and `infrastructure/`. Module-root files are permitted only for `index.ts` (the module factory) and `schema.ts` (the shared Zod schemas and inferred types).

#### Scenario: Resources module has three layer directories

- **WHEN** a reader opens `src/modules/resources/`
- **THEN** the directory contains `presentation/`, `application/`, `infrastructure/`, `schema.ts`, and `index.ts`
- **AND** it contains no other directories
- **AND** it contains no other files at the module root

#### Scenario: Presentation layer contains router, controller, mapper

- **WHEN** a reader opens `src/modules/resources/presentation/`
- **THEN** it contains `router.ts`, `controller.ts`, and `mapper.ts`
- **AND** `mapper.ts` exports the `toDto` function that was previously inline in `controller.ts`

#### Scenario: Application layer contains service and use-case helpers

- **WHEN** a reader opens `src/modules/resources/application/`
- **THEN** it contains `service.ts` and `request-context.ts`

#### Scenario: Infrastructure layer contains repositories, cache keys, and cursor codec

- **WHEN** a reader opens `src/modules/resources/infrastructure/`
- **THEN** it contains `repository.ts`, `cached-repository.ts`, `cache-keys.ts`, and `cursor.ts`
- **AND** `cursor.ts` lives here (not in `application/`) because only the raw repository uses it — the service, cached decorator, and controller all speak the opaque base64url string form and never touch the decoded `CursorPayload`

### Requirement: Module Schema File Stays at Module Root

Each feature module SHALL keep its Zod schemas and inferred DTO/input types in a `schema.ts` file at the module root, not inside any layer directory, so both the presentation and application layers can import from it without violating layer direction.

#### Scenario: schema.ts is imported by both presentation and application

- **WHEN** the codebase is searched for imports of `./schema.js` relative to `src/modules/resources/presentation/controller.ts` and `src/modules/resources/application/service.ts`
- **THEN** both files import types from `../schema.js`
- **AND** neither reaches into a sibling layer directory to find schema types

#### Scenario: schema.ts contains only schemas and inferred types

- **WHEN** a reader opens `src/modules/resources/schema.ts`
- **THEN** the file exports Zod schemas (`CreateResourceSchema`, `UpdateResourceSchema`, `ListResourcesQuerySchema`, `ResourceSchema`) and their inferred TypeScript types
- **AND** it does not export any runtime behavior (no controllers, no handlers, no mappers)

### Requirement: Module Factory Plugs Into The Existing DI Chain

Each feature module SHALL expose a single public factory function from its `index.ts` that takes external dependencies and returns the wired module, and `src/http/app.ts` SHALL call these factories to mount module routers. The top-level `src/app.ts` `createApp(deps)` factory and the `buildApp(...)` function in `src/http/app.ts` SHALL continue to work as the composition chain's public surface.

#### Scenario: Resources module exposes createResourcesModule

- **WHEN** a reader opens `src/modules/resources/index.ts`
- **THEN** the file exports a function `createResourcesModule(deps)` that returns `{ router }` (at minimum)
- **AND** the function constructs the internal repository, cached repository, service, controller, and router in dependency order
- **AND** no other file from `src/modules/resources/` is exported from `index.ts`

#### Scenario: createApp contract is preserved

- **WHEN** the test suite's integration fixtures import `createApp` from `src/app.ts`
- **THEN** the `createApp(deps)` signature is unchanged: it accepts `{ config, logger, db, redis }` and returns `{ app, healthRegistry }`
- **AND** every integration test continues to instantiate the app the same way it did before the refactor

#### Scenario: buildApp calls the module factory instead of the flat router factory

- **WHEN** a reader opens `src/http/app.ts`
- **THEN** the function mounts `/resources` by calling `createResourcesModule({ db, cache, logger, config }).router`
- **AND** it no longer calls the old `createResourcesRouter(db, cache, logger)` signature
- **AND** it does not import from `src/modules/resources/presentation/*`, `src/modules/resources/application/*`, or `src/modules/resources/infrastructure/*` directly

### Requirement: Dependency Direction Enforced by Lint

ESLint SHALL be configured with `no-restricted-imports` (or equivalent) rules that enforce the layered dependency direction at build time. A violation SHALL cause `pnpm lint` to fail.

#### Scenario: Presentation cannot import from infrastructure directly

- **WHEN** a contributor adds an import from `src/modules/<feature>/presentation/*` to `src/modules/<feature>/infrastructure/*`
- **THEN** `pnpm lint` fails with a clear error message directing the contributor to route through the application layer

#### Scenario: Infrastructure cannot import from application

- **WHEN** a contributor adds an import from `src/modules/<feature>/infrastructure/*` to `src/modules/<feature>/application/*`
- **THEN** `pnpm lint` fails with a clear error message

#### Scenario: Cross-module imports are forbidden

- **WHEN** a contributor adds an import from `src/modules/featureA/*` to `src/modules/featureB/*`
- **THEN** `pnpm lint` fails with a clear error message directing the contributor to extract the shared code into `src/shared/` or make it a function passed through dependencies

#### Scenario: Infrastructure and shared cannot import from modules

- **WHEN** a contributor adds an import from `src/infrastructure/*` or `src/shared/*` to `src/modules/*`
- **THEN** `pnpm lint` fails, because the dependency direction must point from modules toward infrastructure and shared, never the reverse

#### Scenario: Composition root and DI factory are exempt

- **WHEN** `src/index.ts`, `src/app.ts`, or `src/http/app.ts` import from multiple scopes as part of their wiring responsibilities
- **THEN** the lint rules allow these specific files, because they are the composition layer at different levels

### Requirement: No Runtime Behavior Change

The refactor SHALL preserve every existing runtime behavior exactly. Every HTTP endpoint, every response body, every error format, every database query, every cache interaction, every log line, every configuration validation, and every health-check output MUST be identical after the refactor compared to before.

#### Scenario: Resources CRUD contract is unchanged

- **WHEN** a client issues `POST /resources`, `GET /resources/{id}`, `GET /resources`, `PATCH /resources/{id}`, or `DELETE /resources/{id}` against a running service
- **THEN** the request/response contract is identical to the pre-refactor behavior defined in the `resources-management` capability spec
- **AND** the `X-Cache` header is emitted identically (HIT, MISS, BYPASS) per the `response-caching` capability spec

#### Scenario: Health endpoint behavior unchanged

- **WHEN** a client calls `GET /healthz?probe=liveness` or `GET /healthz`
- **THEN** the response format and semantics match the pre-refactor behavior

#### Scenario: Error format unchanged

- **WHEN** a request triggers a validation, not-found, or internal error
- **THEN** the error response body shape (`{ error: { code, message, requestId, details? } }`) is identical to pre-refactor

### Requirement: Test Suite Continues To Pass

All unit and integration tests SHALL continue to pass after the refactor without modification to test assertions, test fixtures, or test data. Only test *imports* are permitted to change, and only because the source paths they reference have moved.

#### Scenario: Unit tests pass after import rewrites

- **WHEN** `pnpm test` runs the unit test suite against the refactored codebase
- **THEN** every unit test passes with zero assertion failures
- **AND** the only changes in the unit test files are import-path updates

#### Scenario: Integration tests pass with unchanged createApp contract

- **WHEN** `pnpm test` runs the integration test suite (Testcontainers-backed)
- **THEN** every integration test passes with zero assertion failures
- **AND** `tests/integration/fixtures/app.ts` still imports `createApp` from `src/app.js` with the same signature

#### Scenario: Test directory structure mirrors the source tree

- **WHEN** a contributor looks for the tests of a moved source file
- **THEN** the corresponding test file is found at a mirrored path under `tests/`
  - `src/infrastructure/cache/singleflight.ts` → `tests/unit/infrastructure/cache/singleflight.test.ts`
  - `src/shared/errors.ts` → `tests/unit/shared/errors.test.ts`
  - `src/modules/resources/infrastructure/cursor.ts` → `tests/unit/modules/resources/infrastructure/cursor.test.ts`
  - `src/modules/resources/infrastructure/cache-keys.ts` → `tests/unit/modules/resources/infrastructure/cache-keys.test.ts`

### Requirement: ARCHITECTURE.md Documents the Layering

A root-level `ARCHITECTURE.md` file SHALL document the directory layout, the dependency direction, the lint enforcement, and the explicit non-goals (no DDD, no DI container, no domain layer, no separate ports/adapters split).

#### Scenario: ARCHITECTURE.md exists at the project root

- **WHEN** a contributor opens the repository's root directory
- **THEN** the file `ARCHITECTURE.md` is present alongside `README.md` and `CLAUDE.md`
- **AND** it is not hidden inside a `docs/` subdirectory

#### Scenario: ARCHITECTURE.md explains the two-level infrastructure split

- **WHEN** a reader opens `ARCHITECTURE.md`
- **THEN** it contains a section that explains why `src/infrastructure/` (driver-level) and `src/modules/<feature>/infrastructure/` (feature-level) both exist and what distinguishes them

#### Scenario: ARCHITECTURE.md lists the explicit non-goals

- **WHEN** a reader opens `ARCHITECTURE.md`
- **THEN** it contains a section titled "What this architecture is NOT" (or similar) that explicitly names: no DDD, no DI container, no domain layer, no formal ports/adapters split, no CQRS
- **AND** each non-goal has a one-sentence justification

#### Scenario: ARCHITECTURE.md links from README

- **WHEN** a reader opens `README.md`
- **THEN** the README contains a short "Architecture" section with a link to `ARCHITECTURE.md`

### Requirement: In-Flight OpenSpec Changes Reference the New Paths

Every in-flight OpenSpec change under `openspec/changes/` (specifically `s05`, `s06`, `s07`, `s08`, `s09`) whose `proposal.md` or `tasks.md` references file paths that move in this refactor SHALL be updated to reference the new paths, as part of this change.

#### Scenario: s07 modified-files list is updated

- **WHEN** a reader opens `openspec/changes/s07-add-prometheus-metrics/proposal.md` after this refactor lands
- **THEN** the "Impact → Modified files" list references `src/infrastructure/db/client.ts`, `src/modules/resources/presentation/controller.ts`, `src/modules/resources/infrastructure/cached-repository.ts` (rather than the pre-refactor paths)

#### Scenario: s08 tasks reference final paths

- **WHEN** a reader opens `openspec/changes/s08-add-error-handling/tasks.md` after this refactor lands
- **THEN** task descriptions that reference `src/cache/`, `src/db/`, `src/lib/`, or any flat `src/modules/resources/<file>.ts` path are rewritten to use the post-refactor paths

#### Scenario: Every affected change still validates

- **WHEN** `openspec validate` is run against `s05`, `s06`, `s07`, `s08`, and `s09` after this refactor lands
- **THEN** each change reports as valid with zero errors

### Requirement: CLAUDE.md Reflects New Layout

`problem5/CLAUDE.md` SHALL be updated to describe the new directory layout in its Architecture section so that AI-assisted development uses the correct paths.

#### Scenario: CLAUDE.md references the new structure

- **WHEN** a reader opens `problem5/CLAUDE.md`
- **THEN** the Architecture section describes `src/infrastructure/` (driver-level), `src/shared/`, and the `presentation/application/infrastructure/` layering inside `src/modules/<feature>/`
- **AND** the "Feature modules" description reflects the three-layer internal structure and the `index.ts` factory pattern
