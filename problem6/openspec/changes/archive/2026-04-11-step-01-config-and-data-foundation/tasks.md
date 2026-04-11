## 1. Add dependencies and tooling

- [x] 1.1 Add `zod`, `kysely`, `pg` to `package.json` `dependencies` (`pnpm add zod kysely pg`)
- [x] 1.2 Add `kysely-ctl`, `kysely-codegen`, `@types/pg` to `package.json` `devDependencies` (`pnpm add -D kysely-ctl kysely-codegen @types/pg`)
- [x] 1.3 Run `pnpm install` and verify `pnpm-lock.yaml` updates with the new entries
- [x] 1.4 Run `mise run typecheck` and confirm exit 0 (no broken imports yet — sanity check)

## 2. Config gateway implementation (capability: scoreboard-config)

- [x] 2.1 Create `src/config/schema.ts` defining `EnvSchema = z.object({...})` with one entry per env var from `README.md §13.3`, in the documented order. Use `z.string().url()` for URLs, `z.coerce.number().int().positive()` for numeric ports/timeouts, `z.string().min(32)` for `ACTION_TOKEN_SECRET`, `z.enum([...])` for `LOG_LEVEL`, `.optional()` for `OTEL_EXPORTER_OTLP_ENDPOINT`, `.default(...)` where the README shows a default value
- [x] 2.2 Export `type Config = z.infer<typeof EnvSchema>` from `schema.ts`
- [x] 2.3 Create `src/config/config.service.ts` with class `ConfigService` exposing `get<K extends keyof Config>(key: K): Config[K]` and a private frozen `config: Config` field. Constructor accepts a `Config` instance (parsed by the module factory)
- [x] 2.4 Create `src/config/config.module.ts` as a `@Global() @Module({...})` that uses `useFactory` to call `EnvSchema.parse(process.env)`, catches `ZodError`, formats it via `error.format()` to a multi-line message, writes to `process.stderr` via `console.error`, calls `process.exit(1)` on failure, and exports `ConfigService`
- [x] 2.5 Create `src/config/index.ts` re-exporting `ConfigService`, `ConfigModule`, and `Config` (the type)
- [x] 2.6 Import `ConfigModule` into `src/app.module.ts` (must be the FIRST import in the `imports` array so it's parsed before anything else)
- [x] 2.7 Verify the grep guard: `grep -r "process\.env" src/ --include="*.ts" | grep -v "src/config/"` returns zero matches
- [x] 2.8 Manual smoke test: `unset DATABASE_URL && mise run dev` → process exits non-zero, stderr names `DATABASE_URL` and the zod issue
- [x] 2.9 Manual smoke test: with `.env` populated, `mise run dev` boots successfully and `curl localhost:3000/` returns the 404 JSON envelope

## 3. Database wiring (capability: scoreboard-database)

- [x] 3.1 Create `kysely.config.ts` at `problem6/` root configuring `kysely-ctl` to use the `pg` driver, `migrationFolder: 'src/database/migrations'`, and `connectionString` read from `process.env.DATABASE_URL` (this file is the ONE place outside `src/config/` allowed to read env, since `kysely-ctl` runs as a CLI before the NestJS app)
- [x] 3.2 Create `src/database/database.factory.ts` that builds a `Kysely<DB>` from `ConfigService.get('DATABASE_URL')` using `PostgresDialect` + `pg.Pool`. Export the constructed instance behind a `'Database'` token
- [x] 3.3 Create `src/database/database.module.ts` as a `@Global() @Module({...})` providing `{ provide: 'Database', useFactory: (config) => buildDatabase(config), inject: [ConfigService] }` and exporting the `'Database'` token. Add `OnModuleDestroy` lifecycle hook that calls `db.destroy()` for clean shutdown
- [x] 3.4 Create `src/database/index.ts` re-exporting `DatabaseModule` and a `Database` type alias (`type Database = Kysely<DB>`) where `DB` is imported from `./types.generated`
- [x] 3.5 Import `DatabaseModule` into `src/app.module.ts` AFTER `ConfigModule`

## 4. First migration (capability: scoreboard-database)

- [x] 4.1 Create `src/database/migrations/0001_create_score_events_and_user_scores.ts` exporting `up(db: Kysely<any>): Promise<void>` and `down(db: Kysely<any>): Promise<void>` functions
- [x] 4.2 In `up()`: create `score_events` table with columns and constraints exactly matching `README.md §6.1` lines 229–237 (use `db.schema.createTable(...)` with `addColumn(...)`, `addUniqueConstraint(...)`, `addIndex(...)`)
- [x] 4.3 In `up()`: create `user_scores` table with columns and constraints matching `README.md §6.1` lines 240–247
- [x] 4.4 In `up()`: do NOT create `outbox_events` (deferred to a later change)
- [x] 4.5 In `down()`: drop `user_scores` then `score_events` (reverse order, no foreign-key constraints between them but order is convention)
- [x] 4.6 Run `mise run db:migrate` against the running Postgres container (from `step-00`'s `mise run infra:up`). Verify exit 0
- [x] 4.7 Verify schema with `docker exec problem6-postgres psql -U postgres -d scoreboard -c '\dt'` — must list `score_events`, `user_scores`, and `kysely_migration` (the runner's bookkeeping table). Must NOT list `outbox_events`
- [x] 4.8 Verify constraints: `docker exec problem6-postgres psql -U postgres -d scoreboard -c "\d score_events"` shows the unique constraint on `action_id` and the index on `(user_id, created_at DESC)`
- [x] 4.9 Run `mise run db:migrate` a SECOND time. Verify exit 0 and no schema changes (idempotency check)
- [x] 4.10 Run `mise run db:migrate:down`, verify both tables are dropped, then `mise run db:migrate` again to restore. Confirms the down() function works
- [x] 4.11 Insert a test row in `score_events` with a fixed `action_id`, then attempt a duplicate insert with the same `action_id`. The second insert MUST fail with Postgres SQLSTATE `23505` (unique violation)

## 5. Code generation (capability: scoreboard-database)

- [x] 5.1 Run `mise run db:codegen` against the migrated schema. Verify exit 0 and that `src/database/types.generated.ts` is created
- [x] 5.2 Inspect the generated file: it must export a `DB` type with keys `score_events` and `user_scores` (plus `kysely_migration` from the runner, which is fine), and the column types must match the migration
- [x] 5.3 Run `mise run db:codegen` a SECOND time. The generated file must be byte-identical (deterministic check) — `git diff src/database/types.generated.ts` shows no changes
- [x] 5.4 Stage the generated file with `git add src/database/types.generated.ts` (committed, NOT gitignored)
- [x] 5.5 Verify nothing in `.gitignore` excludes `src/database/types.generated.ts`. If it does (e.g. a wildcard), add an explicit `!src/database/types.generated.ts` exception

## 6. mise.toml setup task hygiene

- [x] 6.1 Read the current `[tasks.setup]` block in `problem6/mise.toml`. If it currently runs `db:codegen` as part of `setup` (which would fail on a fresh clone with no DB), patch it to run only `pnpm install --frozen-lockfile`
- [x] 6.2 Document in the task description that `db:migrate` and `db:codegen` are separate, ordered post-setup steps the developer must run on first DB use
- [x] 6.3 Compute the new SHA-256 of `mise.toml` and record it in the change archive notes (this is the second mise.toml deviation; document why)
- [x] 6.4 If no patch was needed (the existing `setup` task already excludes `db:codegen`), record that fact and skip 6.1–6.3

## 7. End-to-end validation

- [x] 7.1 From a clean state: `mise run infra:reset && mise run infra:up && mise run db:migrate && mise run db:codegen` — all four exit 0
- [x] 7.2 `mise run typecheck` exits 0 (the new config and database modules typecheck against the generated types)
- [x] 7.3 `mise run build` exits 0 and produces `dist/main.js`
- [x] 7.4 `mise run dev` boots the NestJS server with `ConfigModule` and `DatabaseModule` wired. Server logs show no errors during boot. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` returns `404`
- [x] 7.5 Stop the dev server. Run the grep guard one final time: `grep -r "process\.env" src/ --include="*.ts" | grep -v "src/config/" | grep -v "kysely.config.ts"` returns zero matches

## 8. Update File List and finalize

- [x] 8.1 Update the change's `proposal.md` Impact section if any LOC estimates changed materially
- [x] 8.2 Add a `## Validation Summary` to the change's `README.md` (or create one) listing: time-to-migrate, codegen file size, every grep guard exit code, every smoke test exit code
- [x] 8.3 Run `openspec validate step-01-config-and-data-foundation` (or `openspec validate --change step-01-config-and-data-foundation`) and ensure no errors
- [x] 8.4 Run `openspec status --change step-01-config-and-data-foundation` and confirm `isComplete: true` (all artifacts done, all tasks checked)
- [x] 8.5 Ready for `openspec archive step-01-config-and-data-foundation` (or wait for the next change to be implemented before archiving — depends on workflow preference)
