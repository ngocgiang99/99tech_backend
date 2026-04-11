# step-01-config-and-data-foundation

Stories 1.3 + 1.4: typed config gateway with zod schema + Kysely wiring with initial migration for score_events and user_scores

## Validation Summary

Captured during implementation on 2026-04-11 against a fresh `mise run infra:reset && infra:up` stack.

### LOC actuals vs proposal estimates

| Area | Estimate | Actual | Notes |
|------|----------|--------|-------|
| `src/config/` | ~150 | 87 | schema.ts (31) + config.module.ts (37) + config.service.ts (16) + index.ts (3) |
| `src/database/` (factory + module + index) | ~120 | 45 | factory (17) + module (26) + index (2) — generics + NestJS providers compress well |
| `src/database/types.generated.ts` | — (generated) | 34 | `ScoreEvents`, `UserScores`, `DB` |
| `src/database/migrations/0001_*.ts` | ~50 | 48 | Kysely schema DSL matches README §6.1 |
| `kysely.config.ts` | — | 14 | at repo root; only `process.env` read outside `src/config/` |

Totals came in below the proposal estimate. No LOC-driven design changes; leaving `proposal.md` Impact section unchanged.

### Grep guards

| Guard | Command | Result |
|-------|---------|--------|
| Mid-implementation (task 2.7) | `grep -rn "process\.env" src/ --include="*.ts" \| grep -v "src/config/"` | exit 1, zero matches |
| Final (task 7.5) | `grep -rn "process\.env" src/ --include="*.ts" \| grep -v "src/config/" \| grep -v "kysely.config.ts"` | exit 1, zero matches |

`kysely.config.ts` lives at the repo root (not under `src/`), so the first grep already skips it — the second `grep -v` is defensive per the task spec.

### Smoke tests

| Test | Exit / Observation |
|------|--------------------|
| 2.8 — missing env vars | Simulated via `env -i` + direct `EnvSchema.parse(process.env)`: exit 1, stderr listed 7 missing required keys (DATABASE_URL, REDIS_URL, NATS_URL, JWKS_URL, JWT_ISSUER, JWT_AUDIENCE, ACTION_TOKEN_SECRET) with zod issue paths |
| 2.9 — full boot | Validated under task 7.4 (below) with JSON envelope |
| 4.6 — `mise run db:migrate` | exit 0, applied `0001_create_score_events_and_user_scores` |
| 4.7 — `\dt` | Lists `score_events`, `user_scores`, `kysely_migration`, `kysely_migration_lock`; no `outbox_events` |
| 4.8 — `\d score_events` | Shows `uq_score_events_action` UNIQUE on `action_id`, `idx_score_events_user_created` btree `(user_id, created_at DESC)`, `delta > 0` check |
| 4.9 — second `db:migrate` | exit 0, "Migration skipped: no new migrations found" |
| 4.10 — `db:migrate:down` then `db:migrate` | Both exit 0; tables dropped then recreated cleanly |
| 4.11 — duplicate `action_id` | First insert: `INSERT 0 1`. Second insert: `ERROR: duplicate key value violates unique constraint "uq_score_events_action"` (Postgres unique-violation class = SQLSTATE `23505`) |
| 5.1 — `db:codegen` | exit 0, wrote `src/database/types.generated.ts` with `ScoreEvents`, `UserScores`, `DB` |
| 5.2 — inspect generated file | `DB` keys = `score_events`, `user_scores`; column types match migration (uuid → `string`, `bigint` → `Int8`, `timestamptz` → `Timestamp`, `gen_random_uuid()` + `now()` wrapped in `Generated<>`) |
| 5.3 — determinism | Two consecutive runs produced byte-identical files (SHA-256 `3d987bb66426bad0d5c01d259a1d876abfa17d3fec03ad3d893dd976863e276f`); `git diff` reported no changes |
| 5.5 — `.gitignore` check | `git check-ignore -v src/database/types.generated.ts` → exit 1 (file is NOT ignored); no wildcard patches required |
| 7.1 — clean-slate E2E | `infra:reset` → `infra:up` → postgres ready in 1s → `db:migrate` exit 0 → `db:codegen` exit 0 (generated file unchanged vs staged) |
| 7.2 — `mise run typecheck` | exit 0 |
| 7.3 — `mise run build` | exit 0, produced `dist/main.js` (after tsconfig.build.json exclude fix, see below) |
| 7.4 — boot built image | `PORT=3099 node dist/main.js` with `.env` loaded — ConfigModule, DatabaseModule, ScoreboardModule all initialize cleanly; `curl /` → HTTP 404 with JSON envelope `{"message":"Cannot GET /","error":"Not Found","statusCode":404}` |
| 7.5 — final grep guard | see above |

### Codegen file size

`src/database/types.generated.ts`: 34 lines, 873 bytes (after first run against the migrated schema).

### mise.toml patch (tasks 6.1–6.3)

The pre-patch `[tasks.setup]` block ran `pnpm install --frozen-lockfile` followed by `mise run db:codegen` — broken on a fresh clone because `db:codegen` requires a live migrated Postgres. Patched `[tasks.setup]` to run only `pnpm install --frozen-lockfile`, with an inline comment documenting the ordered post-setup steps.

| | SHA-256 of `mise.toml` |
|-|-|
| Before patch | `a757b15b118f15be1ec0acd5bb1c7bd3cd0dd3a012bddace21813c1886f5cc02` |
| After patch | `53bbd8f322d02758b752cde67bd8cee95e70b8be295f30b4c2c512afd6bafb17` |

This is the second `mise.toml` deviation from `step-00` (the first was the stub task set); both are now documented in the change archive.

### Implementation notes / deviations

1. **`tsconfig.build.json` exclude addition.** Introducing `kysely.config.ts` at the project root caused `nest build` to auto-infer `rootDir = .` (instead of `src/`), which shifted the emit to `dist/src/main.js` and broke `node dist/main.js`. Fix: added `"kysely.config.ts"` to `tsconfig.build.json`'s `exclude` list. The file is still typechecked by the base `tsconfig.json` during `mise run typecheck`, so it cannot drift silently. This is a small, local change not anticipated in `design.md`; recording it here for reviewer context.

2. **`src/main.ts` had a pre-existing `process.env.PORT` read** from the `step-00` scaffold. Removed as part of task 2.6 and replaced with `config.get('PORT')`; without this, the grep guard in task 2.7 would have failed.

3. **`src/database/types.generated.ts` stub.** The factory imports `type { DB } from './types.generated'`, which could not exist before codegen ran. Created a 1-line stub (`export interface DB {}`) in Section 3 so the module compiled; Section 5's codegen cleanly overwrote it with the real types. The stub is not committed (overwritten before `git add` in task 5.4).

4. **`Config` export for NestJS DI.** `ConfigService` is instantiated via `useFactory` (not NestJS's automatic class constructor DI) because the constructor argument is a plain `Config` object, not another provider. The factory performs the zod parse once at module-init time and returns a frozen service. On failure, it formats `err.issues` into a multi-line message and calls `process.exit(1)` — no logger dependency yet.

5. **`DatabaseModule.onModuleDestroy`.** Uses constructor-injection (`@Inject(DATABASE)`) to get the Kysely instance, then calls `db.destroy()` on shutdown. This is the canonical NestJS pattern for lifecycle-aware providers and closes the `pg.Pool` cleanly.
