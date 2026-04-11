## 1. New port: LeaderboardUpdatesPort

- [x] 1.1 Create `src/scoreboard/domain/ports/leaderboard-updates.port.ts`
- [x] 1.2 Export `interface LeaderboardUpdateEvent { top: TopEntry[]; updatedAt: Date; }`
- [x] 1.3 Export `type LeaderboardUpdateCallback = (event: LeaderboardUpdateEvent) => void`
- [x] 1.4 Export `type Unsubscribe = () => void`
- [x] 1.5 Export `interface LeaderboardUpdatesPort { subscribe(cb: LeaderboardUpdateCallback): Unsubscribe; emit(event: LeaderboardUpdateEvent): void; }`
- [x] 1.6 Export `const LEADERBOARD_UPDATES_PORT = Symbol('LEADERBOARD_UPDATES_PORT')`
- [x] 1.7 Re-export from `src/scoreboard/domain/ports/index.ts` and `src/scoreboard/domain/index.ts`

## 2. New port: ActionTokenIssuer

- [x] 2.1 Create `src/scoreboard/domain/ports/action-token-issuer.port.ts`
- [x] 2.2 Export `interface IssuedActionToken { actionId: string; actionToken: string; expiresAt: Date; maxDelta: number; }`
- [x] 2.3 Export `interface ActionTokenIssuer { issue(input: { sub: string; atp: string; mxd: number }): Promise<IssuedActionToken> }`
- [x] 2.4 Export `const ACTION_TOKEN_ISSUER = Symbol('ACTION_TOKEN_ISSUER')`
- [x] 2.5 Re-export from `src/scoreboard/domain/ports/index.ts` and `src/scoreboard/domain/index.ts`

## 3. Extend UserScoreRepository with findTopN

- [x] 3.1 Open `src/scoreboard/domain/ports/user-score.repository.ts`
- [x] 3.2 Export `interface TopEntry { rank: number; userId: string; score: number; updatedAt: Date; }` (or verify it already exists elsewhere in domain and reuse)
- [x] 3.3 Add `findTopN(limit: number): Promise<TopEntry[]>` to the `UserScoreRepository` interface
- [x] 3.4 Run `mise run typecheck` — expect TypeScript errors in `KyselyUserScoreRepository` (implementation not yet provided) and in `FakeUserScoreRepository` if it exists

## 4. Implement findTopN in KyselyUserScoreRepository

- [x] 4.1 Open `src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts`
- [x] 4.2 Add the `findTopN(limit: number): Promise<TopEntry[]>` method implementing the canonical SQL: `selectFrom('user_scores').select(['user_id', 'total_score', 'updated_at']).orderBy('total_score', 'desc').orderBy('updated_at', 'asc').limit(limit).execute()` then map rows to `TopEntry` with `rank: index + 1`
- [x] 4.3 Update or add a unit test: `test/unit/scoreboard/infrastructure/persistence/kysely/user-score.repository.test.ts` — assert the correct SQL is generated and the rank ordering matches expectations
- [x] 4.4 If a `FakeUserScoreRepository` exists in `test/` for handler unit tests, add an in-memory implementation of `findTopN` that sorts the fake store by score desc, updated_at asc
- [x] 4.5 Run `mise run typecheck` — confirm zero errors

## 5. GetLeaderboardTopHandler

- [x] 5.1 Create `src/scoreboard/application/queries/get-leaderboard-top.handler.ts`
- [x] 5.2 Export `interface GetLeaderboardTopResult { source: 'hit' | 'miss'; entries: TopEntry[]; }`
- [x] 5.3 Implement `@Injectable() class GetLeaderboardTopHandler` with constructor injecting `LeaderboardCache` (via `LEADERBOARD_CACHE_TOKEN`) and `UserScoreRepository` (via `USER_SCORE_REPOSITORY` token)
- [x] 5.4 Implement `async execute(limit: number): Promise<GetLeaderboardTopResult>` with a `try { cache.getTop(limit) → hit } catch { repo.findTopN(limit) → miss }` pattern
- [x] 5.5 Create `src/scoreboard/application/queries/index.ts` barrel exporting the handler and result type
- [x] 5.6 Create unit test `test/unit/scoreboard/application/queries/get-leaderboard-top.handler.test.ts` with three scenarios: (a) cache hit returns source: 'hit', (b) cache throws, repo succeeds → source: 'miss', (c) both throw → error propagates
- [x] 5.7 Run `mise run test -- test/unit/scoreboard/application/queries/` — all green

## 6. IncrementScoreHandler owns idempotency replay

- [x] 6.1 Open `src/scoreboard/application/commands/increment-score.handler.ts`
- [x] 6.2 Change `IncrementScoreResult` to `{ kind: 'committed' | 'idempotent-replay'; userId; newScore; rank: number | null; topChanged: boolean | null; }`
- [x] 6.3 Wrap the existing `repository.credit(...)` call in a try/catch
- [x] 6.4 In the catch block: if `err instanceof IdempotencyViolationError`, call `this.repo.findScoreEventByActionId(cmd.actionId)`; if the row exists, return `{ kind: 'idempotent-replay', userId, newScore: prior.totalScoreAfter, rank: null, topChanged: null }`; if the row is null, throw `new InternalError('Prior credit record not found for idempotent replay', { cause: err })`
- [x] 6.5 If `err` is NOT an `IdempotencyViolationError`, rethrow
- [x] 6.6 Ensure the happy path wraps its return in `{ kind: 'committed', ... }`
- [x] 6.7 Update `test/unit/scoreboard/application/commands/increment-score.handler.test.ts`: add scenarios for (a) replay returns idempotent-replay kind, (b) replay with missing prior row throws InternalError, (c) happy path returns committed kind
- [x] 6.8 Run `mise run test -- test/unit/scoreboard/application/commands/` — all green

## 7. Refactor leaderboard.controller.ts

- [x] 7.1 Open `src/scoreboard/interface/http/controllers/leaderboard.controller.ts`
- [x] 7.2 Delete the `DATABASE` import from `../../../../database`
- [x] 7.3 Delete the `Database` type import from `../../../../database`
- [x] 7.4 Add import `import { GetLeaderboardTopHandler } from '../../../application/queries'`
- [x] 7.5 Change the constructor to inject `private readonly handler: GetLeaderboardTopHandler` (remove the `@Inject(DATABASE)` and the direct `LeaderboardCache` injection — the handler holds the cache now)
- [x] 7.6 Replace the `try { cache.getTop(...) } catch { inline kysely fallback }` block with `const result = await this.handler.execute(parsed.limit)`; then `res.header('X-Cache-Status', result.source)` and `return { entries: result.entries, generatedAt: new Date().toISOString() }`
- [x] 7.7 Delete the inline Kysely query and the row-to-DTO mapping
- [x] 7.8 Update the return type signature to `Promise<{ entries: TopEntry[]; generatedAt: string }>` — drop the `unknown[]`
- [x] 7.9 Update `test/unit/interface/http/controllers/leaderboard.controller.test.ts` — mock `GetLeaderboardTopHandler`, assert it's called with the parsed limit, assert `X-Cache-Status` follows the mocked `source` field
- [x] 7.10 Run `mise run test -- test/unit/interface/http/controllers/leaderboard.controller.test.ts` — all green

## 8. Refactor leaderboard-stream.controller.ts

- [x] 8.1 Open `src/scoreboard/interface/http/controllers/leaderboard-stream.controller.ts`
- [x] 8.2 Delete the imports of `LeaderboardUpdatesEmitter` and `LeaderboardUpdateEvent` from `../../../infrastructure/messaging/nats/leaderboard-updates.emitter`
- [x] 8.3 Add `import { LEADERBOARD_UPDATES_PORT, type LeaderboardUpdatesPort, type LeaderboardUpdateEvent } from '../../../domain/ports/leaderboard-updates.port'`
- [x] 8.4 Change the constructor: `@Inject(LEADERBOARD_UPDATES_PORT) private readonly updates: LeaderboardUpdatesPort` (replacing the `emitter: LeaderboardUpdatesEmitter` parameter)
- [x] 8.5 Update the `this.emitter.subscribe(...)` call to `this.updates.subscribe(...)`
- [x] 8.6 Update the JWT guard import with the per-line eslint-disable comment (see Task 16.1)
- [x] 8.7 Run `mise run test -- test/unit/interface/http/controllers/leaderboard-stream.controller.test.ts` — update mocks if the test was pinned to the concrete class

## 9. Refactor scoreboard.controller.ts

- [x] 9.1 Open `src/scoreboard/interface/http/controllers/scoreboard.controller.ts`
- [x] 9.2 Delete the `USER_SCORE_REPOSITORY` and `UserScoreRepository` imports from `../../../application/commands` and `../../../domain/ports/user-score.repository`
- [x] 9.3 Delete the `IdempotencyViolationError` import
- [x] 9.4 Delete the `@Inject(USER_SCORE_REPOSITORY) private readonly repository: UserScoreRepository` constructor parameter
- [x] 9.5 Delete the `try/catch` block handling `IdempotencyViolationError` — replace with a direct `const result = await this.handler.execute(cmd)`
- [x] 9.6 Strip the `kind` field before returning the response (e.g. `const { kind, ...rest } = result; return rest`)
- [x] 9.7 Increment `scoreIncrementTotal` with `result: 'committed' | 'idempotent'` based on the `kind` field (the metric label uses 'idempotent' not 'idempotent-replay' for brevity; align with existing metric semantics)
- [x] 9.8 Verify the guard imports (`JwtGuard`, `ActionTokenGuard`, `RateLimitGuard`) all have the per-line eslint-disable comment (see Task 16.1)
- [x] 9.9 Update `test/unit/interface/http/controllers/scoreboard.controller.test.ts`: delete the tests for the removed catch block; assert the handler is called and its result is returned
- [x] 9.10 Run `mise run test -- test/unit/interface/http/controllers/scoreboard.controller.test.ts` — all green

## 10. Refactor actions.controller.ts

- [x] 10.1 Open `src/scoreboard/interface/http/controllers/actions.controller.ts`
- [x] 10.2 Delete the `HmacActionTokenIssuer` import from `../../../infrastructure/auth/hmac-action-token.issuer`
- [x] 10.3 Add `import { ACTION_TOKEN_ISSUER, type ActionTokenIssuer } from '../../../domain/ports/action-token-issuer.port'`
- [x] 10.4 Change the constructor: `@Inject(ACTION_TOKEN_ISSUER) private readonly issuer: ActionTokenIssuer` (replacing the concrete class injection)
- [x] 10.5 Call sites (`this.issuer.issue(...)`) are unchanged — the method signature is identical
- [x] 10.6 Verify the `JwtGuard` import has the per-line eslint-disable comment (see Task 16.1)
- [x] 10.7 Update `test/unit/interface/http/controllers/actions.controller.test.ts` — mock `ActionTokenIssuer` via the token, not the concrete class
- [x] 10.8 Run `mise run test -- test/unit/interface/http/controllers/actions.controller.test.ts` — all green

## 11. Mark HmacActionTokenIssuer as implementing the port

- [x] 11.1 Open `src/scoreboard/infrastructure/auth/hmac-action-token.issuer.ts`
- [x] 11.2 Add `import type { ActionTokenIssuer, IssuedActionToken } from '../../domain/ports/action-token-issuer.port'`
- [x] 11.3 Change the class declaration to `class HmacActionTokenIssuer implements ActionTokenIssuer`
- [x] 11.4 Verify the `issue()` method signature matches the port's signature
- [x] 11.5 Run `mise run typecheck` — confirm zero errors

## 12. Rename LeaderboardUpdatesEmitter to LeaderboardUpdatesInProcessAdapter

- [x] 12.1 Open `src/scoreboard/infrastructure/messaging/nats/leaderboard-updates.emitter.ts`
- [x] 12.2 Rename the class from `LeaderboardUpdatesEmitter` to `LeaderboardUpdatesInProcessAdapter`
- [x] 12.3 Add `import type { LeaderboardUpdatesPort, LeaderboardUpdateEvent, LeaderboardUpdateCallback, Unsubscribe } from '../../../domain/ports/leaderboard-updates.port'`
- [x] 12.4 Change the class declaration to `class LeaderboardUpdatesInProcessAdapter implements LeaderboardUpdatesPort`
- [x] 12.5 Delete the local `LeaderboardUpdateEvent` type export (use the one from the port)
- [x] 12.6 Rename the file to `leaderboard-updates.adapter.ts` (optional — decide based on convention in the directory) OR keep the existing file name
- [x] 12.7 Update all references across the codebase: `jetstream.subscriber.ts`, `nats.module.ts`, `index.ts`
- [x] 12.8 Run `mise run test -- test/unit/scoreboard/infrastructure/messaging/` — all green

## 13. Relocate HealthService to infrastructure/health/

**Note:** `health.service.ts` imports `DATABASE` from `src/database/` — a top-level path that does not match any `boundaries/elements` pattern. The plugin classifies it as an unresolvable `unknown` import and the lint rule does NOT catch this violation (see Group 15 Task 15.6 for the gap explanation). The relocation is a **hand-driven task**, not a lint-driven one. Do not wait for a lint error to remind you; verify the move via grep and manual file-tree inspection.

- [x] 13.1 Create `src/scoreboard/infrastructure/health/` directory
- [x] 13.2 Move `src/scoreboard/interface/health/health.service.ts` to `src/scoreboard/infrastructure/health/health.service.ts` — no content change
- [x] 13.3 Update the import path in `src/scoreboard/interface/health/health.controller.ts`: change to `import { HealthService } from '../../../infrastructure/health/health.service'`
- [x] 13.4 Add the per-line eslint-disable comment on the HealthService import: `// eslint-disable-next-line boundaries/dependencies -- health controller is a thin HTTP adapter over infra probes, see design.md Decision 6`. NOTE: this comment is documentation-only for the current rule gap; even without it, lint currently passes on this import because the resolved target lives outside the scoreboard element patterns. Add it anyway so the intent is textual
- [x] 13.5 Update `src/scoreboard/interface/health/health.module.ts`: change the provider registration to reference the new path
- [x] 13.6 Move or update the unit test: `test/unit/scoreboard/infrastructure/health/health.service.test.ts` replaces `test/unit/interface/health/health.service.test.ts` if it existed
- [x] 13.7 Run `mise run test -- test/unit/scoreboard/infrastructure/health/` — all green
- [x] 13.8 **Manual verification** — grep the working tree for `from '.*interface/health/health\.service'` and `src/scoreboard/interface/health/health\.service\.ts`. Both should return zero matches after the move

## 14. DI module registrations

- [x] 14.1 Open `src/scoreboard/scoreboard.module.ts` (or the module where providers are registered)
- [x] 14.2 Register `LEADERBOARD_UPDATES_PORT` as a provider token bound to `LeaderboardUpdatesInProcessAdapter`
- [x] 14.3 Register `ACTION_TOKEN_ISSUER` as a provider token bound to `HmacActionTokenIssuer`
- [x] 14.4 Register `GetLeaderboardTopHandler` in the providers list
- [x] 14.5 Export `GetLeaderboardTopHandler` if the controllers are registered in a separate module
- [x] 14.6 Remove any `provide: HmacActionTokenIssuer, useClass: HmacActionTokenIssuer` that no longer matches the new binding
- [x] 14.7 Run `mise run typecheck && mise run test` — confirm module boot succeeds in every test that uses the full module

## 15. ESLint boundary rule — verification and baseline capture

**Note:** The investigation from the original task list was completed during a pre-change verification pass. The root cause is known, the fix is already applied to `eslint.config.mjs`, and `eslint-import-resolver-typescript` is already installed as a dev dependency. This group is now a verification-and-baseline step, not an investigation step.

- [x] 15.1 Verify `eslint-import-resolver-typescript` is installed: `pnpm list eslint-import-resolver-typescript` should show a version (expected: ≥ 4.4.4). If missing, run `pnpm add -D eslint-import-resolver-typescript`
- [x] 15.2 Verify `eslint.config.mjs` contains the `settings['import/resolver'].typescript` block with `alwaysTryTypes: true` and `project: './tsconfig.json'`. If missing, add it per design.md Decision 7
- [x] 15.3 Verify `eslint.config.mjs` interface rule `allow` list contains `domain` (not just `application` and `shared`). If missing, add it per design.md Decision 7
- [x] 15.4 Verify `eslint.config.mjs` interface rule has an explicit `disallow: [{ to: { type: 'infrastructure' } }]` entry with a `message` field. If missing, add it per design.md Decision 7
- [x] 15.5 **Baseline capture** — run `pnpm eslint src/scoreboard/interface/` BEFORE any refactor work. Confirm the 8 expected violations (verified during pre-change exploration):
    - `actions.controller.ts:10:39` — HmacActionTokenIssuer import
    - `actions.controller.ts:11:26` — JwtGuard import
    - `leaderboard-stream.controller.ts:18:26` — JwtGuard import
    - `leaderboard-stream.controller.ts:22:8` — LeaderboardUpdatesEmitter import
    - `leaderboard.controller.ts:7:26` — JwtGuard import
    - `scoreboard.controller.ts:23:34` — ActionTokenGuard import
    - `scoreboard.controller.ts:24:26` — JwtGuard import
    - `scoreboard.controller.ts:25:32` — RateLimitGuard import
- [x] 15.6 **Gap note** — lint does NOT catch `src/scoreboard/interface/health/health.service.ts` even though it imports `DATABASE` from `src/database/` (a top-level path). The plugin classifies this as an unresolvable `unknown` import, so the rule is silent. This is an intentional limitation; Group 13 handles the health service via a hand-driven relocation rather than a lint-driven one. Do not attempt to "fix the lint rule" to catch `src/database` imports — adjusting `boundaries/elements` to match top-level paths would over-classify unrelated files
- [x] 15.7 **Final validation** (run AFTER all refactor groups complete) — `pnpm eslint src/scoreboard/` exits 0 because (a) the 6 guard imports now carry per-line eslint-disable comments (Group 16), (b) the 2 real architectural violations (`HmacActionTokenIssuer`, `LeaderboardUpdatesEmitter`) have been replaced with port imports from `domain/ports/`

## 16. Per-file eslint-disable comments

- [x] 16.1 For each controller that uses a guard via `@UseGuards`, add a comment immediately above the guard import line. Format:
    ```
    // eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see design.md Decision 8
    import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
    ```
- [x] 16.2 Files to update:
    - `src/scoreboard/interface/http/controllers/actions.controller.ts` (JwtGuard)
    - `src/scoreboard/interface/http/controllers/leaderboard.controller.ts` (JwtGuard)
    - `src/scoreboard/interface/http/controllers/leaderboard-stream.controller.ts` (JwtGuard)
    - `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` (JwtGuard, ActionTokenGuard, RateLimitGuard — three separate disable comments)
- [x] 16.3 Health controller's service import also gets the comment (done in Task 13.4)
- [x] 16.4 Run `grep -rn "eslint-disable.*boundaries" src/scoreboard/` and verify each match has a rationale after the `--` that explains the exemption

## 17. End-to-end validation

- [x] 17.1 Run `mise run typecheck` — exit 0
- [x] 17.2 Run `mise run lint` — exit 0, zero warnings on touched files
- [x] 17.3 Run `mise run test` (unit) — exit 0
- [x] 17.4 Run `mise run test:integration` — exit 0
- [~] 17.5 Run `mise run test:coverage` — the per-directory thresholds (domain 100%, shared/errors 95+, shared/resilience 85+) are met; the new `GetLeaderboardTopHandler` lands at 100/100/100/100. The **global** branch threshold currently sits at 79.68% vs 80% required. Verified on pre-change HEAD (commit b33badc) via `git stash` + rerun: baseline was 79.2%, so this change IMPROVED branch coverage by +0.48pp. The pre-existing gap is in `shared/readiness` (0% branches) and decorator metadata in controllers; neither is caused by this change. Documented here; a follow-up change can lift the global back to 80% by either adding readiness service tests or lowering the global threshold to match the measured baseline.
- [~] 17.6 Manual smoke: `mise run dev`, hit `curl -i http://localhost:3000/v1/leaderboard/top?limit=10` with a valid JWT. Confirm `X-Cache-Status: hit`. Stop Redis, curl again, confirm `X-Cache-Status: miss`. Restart Redis. **DEFERRED**: user must run this with a live JWT; integration test `leaderboard-controller.test.ts` covers the HIT/MISS paths via mocked handler.
- [~] 17.7 Manual smoke: issue an action token, call `POST /v1/scores:increment` twice with the same actionId, confirm both responses are HTTP 200 with the same body (idempotent-replay path works without the controller catch block). **DEFERRED**: user must run this with a live action token; unit test `increment-score.handler.test.ts` covers the idempotent-replay recovery path directly against the handler.
- [x] 17.8 Git diff review — confirm files changed are exactly: the three new port files, the new handler, the five modified controllers, the handler modification, the repository implementation extension, the renamed/moved files, the DI module updates, the eslint config, and the openspec directory
- [x] 17.9 No unrelated files are touched (no database migrations, no env vars, no package.json, no docker-compose)

## 18. OpenSpec validation

- [x] 18.1 Run `openspec validate enforce-ddd-layer-boundaries` from inside `problem6/` — confirm exit 0
- [x] 18.2 Confirm all four spec files parse: `specs/scoreboard-architecture/spec.md` (ADDED), `specs/scoreboard-write-path/spec.md` (MODIFIED), `specs/scoreboard-leaderboard/spec.md` (MODIFIED), `specs/scoreboard-quality/spec.md` (MODIFIED)
- [ ] 18.3 Archive the change after the implementation tasks are complete

## 19. Remove unsafe casts from production code (in-scope cleanup)

During a post-refactor audit the user flagged `as unknown` / `as never` casts in production code as a code smell. None of these casts were introduced by this change, but all five occurrences were removed in-scope so the DDD-layering change ships a clean production surface.

- [x] 19.1 Create `src/scoreboard/interface/http/authenticated-request.ts` exporting `AuthenticatedRequest` interface (extends `FastifyRequest` with `userId?: unknown`), `getAuthenticatedUserId(req)` (throws `UnauthenticatedError` if missing), and `peekAuthenticatedUserId(req)` (returns `string | undefined` for informational logging)
- [x] 19.2 Update `JwtGuard.canActivate` to narrow the Fastify request via a local `JwtAttachedRequest` type alias (`FastifyRequest & { userId?: string }`) — the infrastructure layer never reaches up into `interface/`, so the attachment contract is duplicated locally; `AuthenticatedRequest` is the interface-layer view of the same shape
- [x] 19.3 Refactor `ScoreboardController.incrementScore(@Req() req: AuthenticatedRequest)` — replace `(req as unknown as { userId: string }).userId` with `getAuthenticatedUserId(req)`; `@Req()` parameter typed as `AuthenticatedRequest`
- [x] 19.4 Refactor `ActionsController.issueActionToken(@Req() req: AuthenticatedRequest)` — same replacement, same typed parameter
- [x] 19.5 Refactor `LeaderboardStreamController.stream(@Req() req: AuthenticatedRequest)` — replace `(req as unknown as { userId?: string }).userId` in the slow-client warning log with `peekAuthenticatedUserId(req)`; remove the now-unused `FastifyRequest` import
- [x] 19.6 Split `buildErrorMetadata(err, request, errorId)` in `src/scoreboard/shared/errors/error-metadata.ts` into two typed entry points sharing a private `buildFromSource(err, src, errorId)` core:
    - `buildErrorMetadata(err, request, errorId)` — HTTP path, consumes `FastifyRequest`
    - `buildBackgroundErrorMetadata(err, context, errorId)` — background path, consumes `BackgroundContext = { source?: string }`
    - Both funnel through a private `MetadataSource` intermediate — a plain object with `requestId`, `method`, `route`, `rawHeaders`, `query`, `userAgent`, `remoteAddr` — so the shared metadata-assembly code has one type path
- [x] 19.7 Export `buildBackgroundErrorMetadata` and `BackgroundContext` from `src/scoreboard/shared/errors/index.ts`
- [x] 19.8 Rewrite `src/scoreboard/shared/resilience/log-with-metadata.ts` to call `buildBackgroundErrorMetadata(appErr, { source }, randomUUID())` — delete the `{...} as unknown as FastifyRequest & { requestId?: string }` synthetic stub
- [x] 19.9 Fix `outbox.publisher.service.ts:264` — the `top as unknown as Record<string, unknown>` cast existed because `LeaderboardEntry` has a `Date` field that's not structurally assignable to a JSON index signature. Replace with an explicit `serializedTop` mapping that converts `updatedAt` to an ISO string; JetStream's `JSONCodec` round-trips the shape cleanly
- [x] 19.10 Verify `grep -rn "as unknown\|as never" src/scoreboard/` returns zero matches
- [x] 19.11 Run full check: `mise run typecheck`, `mise run lint`, `mise run test` (364 pass), `mise run test:integration` (52 pass) — all green
