## Context

`problem6/` already has the NestJS 11 + Fastify scaffold (from `step-00`'s scaffolding work) and a working local Postgres + Redis + NATS stack via `mise run infra:up`. There is no application code beyond an empty `ScoreboardModule`. The existing scaffold has placeholder directories at `src/config/` and `src/database/` (with `.gitkeep` files) waiting to be populated.

Two parallel concerns must be addressed before any business logic ships:

1. **No safe way to read env vars.** Today, anyone could call `process.env.DATABASE_URL` directly, get `string | undefined`, and ship a "works locally, NPE in CI" bug. The architecture (`README.md §13.3`) lists 20 required env vars, several of which have non-trivial constraints (URLs, integer ranges, secret length). A typed gateway eliminates this entire class of bugs.

2. **No persistence layer at all.** The DDD architecture says the domain port `UserScoreRepository` will be implemented by `KyselyUserScoreRepository` in `src/scoreboard/infrastructure/persistence/kysely/`. That can't exist until Kysely is wired, the schema is migrated, and the generated types are committed.

Both belong to the same change because:
- Neither is useful without the other (a config without a DB to configure is half a solution; a DB factory hand-coded without a config gateway re-introduces the `process.env` problem).
- They share `DATABASE_URL` as the contract surface (config validates it; database consumes it).
- They both unblock `step-02` (domain + write path) which is the next change in the sequence.

**Constraints inherited from earlier work:**
- TypeScript strict-plus mode (`noUnusedLocals`, `noImplicitReturns`, `strict: true`, `module: nodenext`) — see `tsconfig.json`
- DDD layering: domain depends on nothing framework-y; application/infrastructure may import NestJS — see `step-00`'s scaffolding
- mise is the canonical task runner; no `scripts` in `package.json` — see `mise.toml`
- All env vars enumerated in `README.md §13.3` (20 keys); local Postgres on host port `55432` per `compose.override.yml`

## Goals / Non-Goals

**Goals:**
- Single, typed `ConfigService` whose `.get(key)` return type is the inferred type from the zod schema (no `string | undefined`, no casting).
- App boot fails with a non-zero exit code AND a human-readable error message when any required env var is missing or malformed. The error must list every offending key, not just the first one.
- Zero direct `process.env` reads anywhere in `src/` outside `src/config/`. Verifiable via grep.
- Kysely instance built from `ConfigService` (not from raw env). Injectable via NestJS DI.
- First migration creates exactly the v1 schema from `README.md §6.1`: `score_events` (with `UNIQUE(action_id)` + `(user_id, created_at DESC)` index) and `user_scores` (with `(total_score DESC, updated_at ASC)` index). **Not** `outbox_events` (deferred to Epic 2).
- `mise run db:codegen` produces a committed `src/database/types.generated.ts` whose `ScoreEvents` and `UserScores` types match the migrated schema 1:1.
- The whole change can be exercised end-to-end with: `mise run infra:up && mise run db:migrate && mise run db:codegen && mise run typecheck && mise run build`. All four exit 0, generated file is unchanged on second run.

**Non-Goals:**
- Reading any env var **at module-construction time** other than what `ConfigModule` itself needs for its own zod parse. (Lazy-init is for `step-02` and beyond.)
- Postgres connection pooling tuning (default `pg.Pool` settings are fine for v1; `step-07`'s prod-readiness change can revisit if NFR-02 load tests reveal a problem).
- Read replicas, PgBouncer, or any HA topology — the v1 architecture uses a single primary.
- Any application of the schema beyond the migration itself — no inserts, no queries, no repository methods.
- Test coverage. `step-04` introduces Jest configuration and the first integration test. `step-01`'s validation is operational (`mise run db:migrate` succeeds; `psql \dt` shows the tables; `mise run typecheck` passes).
- Migration rollback machinery beyond what `kysely-ctl` provides out of the box.

## Decisions

### Decision 1: Zod schema with `z.object({...}).parse(process.env)` at module init time

**What**: `ConfigModule.forRoot()` runs `Schema.parse(process.env)` exactly once during NestJS bootstrap. The parsed result is frozen and stored on a singleton `ConfigService`. All `.get(key)` calls return the frozen value.

**Why**:
- **Fail-fast**: The parse runs before NestJS finishes wiring providers. A missing `DATABASE_URL` crashes the process immediately with a `ZodError` (formatted into a multi-line message via `z.ZodError.format()`), not 30 seconds later when the Kysely factory tries to connect.
- **Type inference**: `z.infer<typeof Schema>` gives the exact result type, which `ConfigService.get<K extends keyof Config>(key: K): Config[K]` narrows on. No `as string` casts anywhere downstream.
- **Mutability lock**: Freezing the parsed object prevents any caller from accidentally mutating config (e.g. tests that monkey-patch `process.env.LOG_LEVEL`). Tests must use `ConfigService.override()` (a test-only escape hatch behind an env-flag, not exposed in production builds).

**Alternatives considered**:
- **`@nestjs/config` package** with `validationSchema` (Joi or class-validator). Rejected because (a) it adds a third validation framework alongside `zod` (which I plan to use elsewhere), (b) its type inference is weaker — `ConfigService<{...}>` is a parameterized type but still returns `string | undefined` from `.get()` unless you cast, (c) it has a heavier API surface than we need.
- **Plain TS object literal with manual `if (!process.env.X) throw`**. Rejected because it doesn't validate the *shape* of values (e.g. `RATE_LIMIT_PER_SEC` must be a positive integer; `JWKS_URL` must be a URL). zod handles these via `z.coerce.number().positive()` etc.
- **`envalid` library**. Considered, but its TypeScript inference is also weaker than zod's, and adding it duplicates the validation library count.

**Trade-off**: Module-init validation means tests cannot import `ConfigModule` without a fully populated `process.env`. Mitigation: provide a `ConfigModule.forTest({ overrides: {...} })` static factory in `step-04` (when test infra lands) that bypasses the parse and directly hydrates the singleton from a test fixture.

### Decision 2: One zod schema file, one variable per row, mirror `README.md §13.3` ordering

**What**: `src/config/schema.ts` defines a single `EnvSchema = z.object({...})` whose keys appear in the same order as the table in `README.md §13.3` (Runtime → Datastores → NATS → Auth → Rate Limiting → Observability). Each key has a one-line comment with its purpose, sourced from the README.

**Why**:
- The README is the authoritative env-var contract. Mirroring its order makes drift visible in PR review (a reordered schema = a re-ordered README, or vice versa).
- One file, ~80 lines, scrollable in one screen. No "config sub-modules" until v1 ships.
- The grep-check in the proposal (`grep -r "process\.env" src/ | grep -v "src/config/"`) is easier to enforce when there's literally one file.

**Alternatives considered**:
- **Sub-schemas per concern** (`PostgresConfigSchema`, `RedisConfigSchema`, …) merged at the end. Rejected for v1 — we have 20 vars, not 200; sub-schemas add ceremony for no gain.
- **Inline `z.object` in `config.module.ts`**. Rejected because `schema.ts` is also where the type export `Config = z.infer<typeof EnvSchema>` lives, and downstream consumers should import the type without pulling in the NestJS module.

### Decision 3: Kysely migrations live in `src/database/migrations/` with a sequential timestamp prefix

**What**: First migration file is `src/database/migrations/0001_create_score_events_and_user_scores.ts`. Subsequent migrations use `0002_*`, `0003_*`, etc. The numeric prefix is the lexical sort order; no datestamps.

**Why**:
- Sequential numbers work better than datestamps for a small team — no merge conflicts on a YYYYMMDDHHMMSS prefix when two devs author migrations in parallel; the second to merge bumps to `NNNN+1`.
- Numbers ≤ 9999 are sufficient for a single-context module (we have ≤10 migrations expected for v1).
- `kysely-ctl` doesn't care about the prefix format — it just lexically sorts the directory.

**Alternatives considered**:
- **Datestamp prefix** (`20260411000001_*`). Rejected because it's noise for a small project and handles a problem we don't have (parallel-team migration conflicts).
- **No prefix, alphabetical** (`create-score-events.ts`, `add-outbox.ts`). Rejected — order becomes opaque and rename-fragile.

### Decision 4: `kysely-codegen` is a manual `mise run db:codegen` step, NOT a postinstall hook

**What**: Generated types live at `src/database/types.generated.ts`, are **committed to the repo**, and are regenerated only when the developer runs `mise run db:codegen` after a migration. Not run automatically in `mise run setup`, not a `postinstall` script.

**Why**:
- **CI determinism**: a committed generated file means CI can typecheck without needing a live Postgres connection. This is important because `step-04`'s test infrastructure includes Testcontainers, but `mise run typecheck` should work on a laptop with no Docker running.
- **PR visibility**: when a migration changes the schema, the next commit also touches `types.generated.ts`. Reviewers see both files in the diff, which makes schema drift obvious.
- **Failure mode**: if a dev forgets to run `db:codegen` after a migration, `mise run typecheck` fails next time anyone tries to use the new column. That's a fast, local feedback loop. Adding a CI check that re-runs codegen and diffs is a `step-04` follow-up.

**Alternatives considered**:
- **Run codegen as part of `mise run setup`**. Rejected — `setup` is currently broken on a fresh clone (it tries to run `db:codegen` without a Postgres). The whole reason `step-00` left `mise run setup` flagged for revisit is that `db:codegen` requires a live DB. We need to either (a) patch `setup` to skip codegen and rely on the committed file, or (b) make codegen lazy. Option (a) is simpler — `mise run setup` becomes `pnpm install` and the dev is told to run `db:migrate && db:codegen` separately on first DB use.
- **Don't commit the generated file, regenerate in CI**. Rejected because CI would need to spin up a Postgres just to typecheck. Slow + flaky.
- **Use `pg-typed` or another runtime introspection lib**. Rejected — Kysely already has `kysely-codegen`, and the architecture (ADR-01) explicitly chose Kysely.

### Decision 5: `DatabaseModule` is global; `Database` is injectable via `@Inject('Database')`

**What**: `DatabaseModule` is decorated with `@Global()` so its single `Database` provider can be injected into any other module without re-importing. The provider uses a string token `'Database'` rather than a class because Kysely's `Kysely<DB>` is parameterised by the database type and class-based DI doesn't carry the generic.

**Why**:
- **One pool, one process**: there must be exactly one `pg.Pool` per Node process. A module-level `@Global()` enforces this; non-global modules risk creating one pool per import.
- **Generic-aware injection**: `@Inject('Database') db: Database` (where `type Database = Kysely<DB>` and `DB` comes from `types.generated.ts`) is the cleanest way to get the typed Kysely instance into a service.
- **Testability**: tests override the provider with `{ provide: 'Database', useValue: testKysely }` — simpler than mocking a class.

**Alternatives considered**:
- **Class-based provider** (`DatabaseService` wrapping Kysely). Rejected because it adds an indirection that hides the Kysely API from consumers, and makes it harder to use Kysely's transaction helpers.
- **Non-global module imported per consumer**. Rejected because it risks pool duplication and there's no scoping benefit (we have one DB).

## Risks / Trade-offs

- **[Risk]** `mise run setup` is currently broken end-to-end because it calls `db:codegen` which needs a running Postgres → **Mitigation**: This change includes a small `mise.toml` patch to remove `db:codegen` from `setup`'s `run` chain. The `step-00` story already has a deviation note flagging this; we're closing the loop here. New `mise.toml` SHA-256 will be recorded in the change archive.

- **[Risk]** Module-init validation crashes the process before any logger is wired → **Mitigation**: The `ConfigModule.forRoot()` catches `ZodError`, formats it via `error.format()`, writes the multi-line message to `process.stderr` via plain `console.error`, and calls `process.exit(1)`. No Pino dependency at this point in the boot. The error message is the same shape regardless of whether one or many keys failed.

- **[Risk]** Committing `types.generated.ts` means schema drift between the migration and the committed file is invisible until someone runs `mise run typecheck` → **Mitigation**: Document in `CONTRIBUTING.md` (or `README.md §13.2`) that `mise run db:codegen` MUST be run after every migration. `step-04` adds a CI guardrail that re-runs codegen and fails if the file diffs.

- **[Trade-off]** zod adds ~20KB gzipped to the bundle. This is a server-side module, so bundle size is irrelevant. Accepted.

- **[Trade-off]** `kysely-ctl` is an "unofficial" Kysely CLI maintained by the community (as of CLI version `0.x`), not part of the core `kysely` package. There's a small risk of abandonment → **Mitigation**: The CLI is thin (it just executes migration files); replacing it with a hand-rolled `ts-node migrate.ts` is a 30-line escape hatch if needed.

- **[Risk]** Migration order is implicit (lexical sort by filename). If two devs author `0002_*` simultaneously, the merge conflict is on the directory listing → **Mitigation**: Numeric prefix is single source of truth; PR reviewers must verify the new migration's number > all existing ones. `step-04` can add a CI check.

## Migration Plan

This is a foundational change with no existing data to migrate. The "migration plan" is the **boot order** for a new dev or a CI run:

1. `mise install` — installs Node 22.11.0, pnpm 9.12.0
2. `mise run infra:up` — Postgres + Redis + NATS healthy
3. `cp .env.example .env` — creates the local env file (already documented in `step-00`)
4. `pnpm install` — installs `zod`, `kysely`, `pg`, `kysely-ctl`, `kysely-codegen`, `@types/pg`
5. `mise run db:migrate` — applies migration `0001_*`, creates `score_events` and `user_scores`
6. `mise run db:codegen` — regenerates `src/database/types.generated.ts` (should produce the same file already committed; any diff = drift)
7. `mise run typecheck` — exits 0
8. `mise run build` — exits 0, produces `dist/main.js`
9. `mise run dev` — starts NestJS, `ConfigModule` parses env vars, `DatabaseModule` connects to Postgres, server listens on `:3000`. `curl localhost:3000/` still returns 404 JSON (no routes yet — that comes in `step-03`).

**Rollback**: `kysely migrate:down` rolls back the last migration. For this change, that means dropping `score_events` and `user_scores`. Safe because no data has been written yet.

**Forward compatibility**: Adding a new env var to `schema.ts` is backward-compatible IF the new key has a default value. Adding a key WITHOUT a default is a breaking change for existing `.env` files — must be coordinated with a `.env.example` update and a release note.

## Open Questions

- **Q1: Should `kysely.config.ts` live at `problem6/` root or under `src/database/`?** `kysely-ctl` looks for `kysely.config.ts` at the project root by default; moving it under `src/database/` requires a `--config` flag in `mise.toml`. **Default decision**: keep it at `problem6/` root for convention compatibility. Revisit if it feels out of place in `step-02` reviews.

- **Q2: Should `ConfigService.get` accept a default value as a second argument?** e.g. `configService.get('LOG_LEVEL', 'info')`. **Default decision**: No. Defaults belong in the zod schema (`z.string().default('info')`), not at call sites. A second argument would let two call sites disagree on the default.

- **Q3: Do we need a `ConfigService.getAll(): Config` method?** Useful for logging the full config at boot (with secrets redacted). **Default decision**: Yes, but redact `ACTION_TOKEN_SECRET` automatically via a `Symbol.for('redacted')` marker on the relevant zod fields. Simpler alternative: log at boot with a hardcoded redaction list. Defer the choice to implementation; both are ~10 LOC.

- **Q4: Should the `Database` provider expose `.transaction()` directly, or wrap it in a `TransactionalUnitOfWork`?** **Default decision**: Expose Kysely's native `db.transaction().execute(async (trx) => ...)` directly. Story 1.6's repository can use it without an indirection. If the indirection becomes useful for testing, add it in `step-04`.
