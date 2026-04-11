## 1. Domain layer — value objects (capability: scoreboard-domain)

- [x] 1.1 Create `src/scoreboard/domain/value-objects/user-id.ts` exporting `class UserId` with private constructor and static `of(raw: string): UserId` factory that validates UUID format via regex (no zod dependency in domain)
- [x] 1.2 Create `src/scoreboard/domain/value-objects/action-id.ts` exporting `class ActionId` with the same factory pattern
- [x] 1.3 Create `src/scoreboard/domain/value-objects/score.ts` exporting `class Score` with `of(n: number): Score` rejecting negatives, NaN, non-integers, and `> Number.MAX_SAFE_INTEGER`
- [x] 1.4 Create `src/scoreboard/domain/value-objects/score-delta.ts` exporting `class ScoreDelta` with `of(n: number): ScoreDelta` rejecting `< 1`, `> MAX_DELTA`, non-integers, NaN. Define `MAX_DELTA = 10000` as a module constant
- [x] 1.5 Create `src/scoreboard/domain/value-objects/index.ts` re-exporting all four

## 2. Domain layer — errors (capability: scoreboard-domain)

- [x] 2.1 Create `src/scoreboard/domain/errors/domain-error.ts` exporting `abstract class DomainError extends Error` with a `code: string` property
- [x] 2.2 Create `src/scoreboard/domain/errors/invalid-argument.error.ts` exporting `class InvalidArgumentError extends DomainError` with `code = 'INVALID_ARGUMENT'`
- [x] 2.3 Create `src/scoreboard/domain/errors/idempotency-violation.error.ts` exporting `class IdempotencyViolationError extends DomainError` with `code = 'IDEMPOTENCY_VIOLATION'` and a public `actionId: string` property
- [x] 2.4 Create `src/scoreboard/domain/errors/index.ts` re-exporting all error classes

## 3. Domain layer — events (capability: scoreboard-domain)

- [x] 3.1 Create `src/scoreboard/domain/events/score-credited.event.ts` exporting `class ScoreCredited` with readonly properties `{ userId, actionId, delta, newTotal, occurredAt }` and a constructor that accepts the same shape
- [x] 3.2 Create `src/scoreboard/domain/events/index.ts` re-exporting `ScoreCredited`

## 4. Domain layer — aggregate (capability: scoreboard-domain)

- [x] 4.1 Create `src/scoreboard/domain/user-score.aggregate.ts` exporting `class UserScore` with private fields `_userId, _totalScore, _lastActionId, _updatedAt, _events: ScoreCredited[]`
- [x] 4.2 Add a private constructor that runs the invariant check (`totalScore >= 0`) and throws `DomainError` if violated
- [x] 4.3 Add a static factory `UserScore.empty(userId): UserScore` that returns a fresh aggregate with `totalScore = 0, lastActionId = null, updatedAt = new Date(0)` and an empty events array
- [x] 4.4 Add a static factory `UserScore.rehydrate({ userId, totalScore, lastActionId, updatedAt }): UserScore` that validates the snapshot and constructs the instance (used by the repository when loading from Postgres)
- [x] 4.5 Add `.credit(actionId: ActionId, delta: ScoreDelta, occurredAt: Date): void` that mutates `_totalScore += delta.value`, sets `_lastActionId = actionId.value`, advances `_updatedAt = occurredAt`, and pushes a new `ScoreCredited` event
- [x] 4.6 Add `.pullEvents(): readonly ScoreCredited[]` that returns the events array and clears the internal collection
- [x] 4.7 Add public read-only getters: `userId`, `totalScore`, `lastActionId`, `updatedAt`
- [x] 4.8 Create `src/scoreboard/domain/ports/user-score.repository.ts` exporting `interface UserScoreRepository` with method signatures `findByUserId(userId: UserId): Promise<UserScore | null>` and `credit(aggregate: UserScore, event: ScoreCredited): Promise<void>`
- [x] 4.9 Create `src/scoreboard/domain/index.ts` re-exporting all domain symbols (the public surface)

## 5. Domain unit tests (capability: scoreboard-domain)

- [x] 5.1 Create `test/unit/domain/value-objects/score-delta.test.ts` covering all reject cases (`0`, `-1`, `2.5`, `NaN`, `MAX_DELTA + 1`) and the happy path
- [x] 5.2 Create `test/unit/domain/value-objects/user-id.test.ts`, `action-id.test.ts`, `score.test.ts` covering their reject and accept cases
- [x] 5.3 Create `test/unit/domain/user-score.aggregate.test.ts` covering: empty factory, rehydrate factory, credit happy path, credit accumulation, pullEvents drain, invariant rejection on negative total, the credit method emits exactly one event with the right shape
- [x] 5.4 Run `mise run test` (after `step-04` lands jest config — until then, run `pnpm jest test/unit/domain` directly with a temp config). Verify all tests pass and `--coverage` shows 100% lines/branches/functions for `src/scoreboard/domain/`
- [x] 5.5 Run the grep guard: `grep -rE "from '@nestjs|from '(kysely|pg|ioredis|nats|jose)'" src/scoreboard/domain/ --include="*.ts"` returns zero matches

## 6. Infrastructure — repository adapter (capability: scoreboard-write-path)

- [x] 6.1 Create `src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts` exporting `class KyselyUserScoreRepository implements UserScoreRepository`
- [x] 6.2 Constructor takes `@Inject('Database') private readonly db: Database` (typed Kysely instance from `step-01`)
- [x] 6.3 Implement `findByUserId(userId)` using `db.selectFrom('user_scores').where('user_id', '=', userId.value).selectAll().executeTakeFirst()`. If undefined, return null. Otherwise call `UserScore.rehydrate({...})` with the row fields
- [x] 6.4 Implement `credit(aggregate, event)` as a `db.transaction().execute(async (trx) => {...})` block
- [x] 6.5 Inside the transaction: run `SELECT user_id, total_score FROM user_scores WHERE user_id = $1 FOR UPDATE` (using Kysely's `.forUpdate()`)
- [x] 6.6 Inside the transaction: `INSERT INTO score_events (id, user_id, action_id, delta, created_at) VALUES (...)` — use `crypto.randomUUID()` for the `id`
- [x] 6.7 Inside the transaction: `INSERT INTO user_scores (user_id, total_score, last_action_id, updated_at) VALUES (...) ON CONFLICT (user_id) DO UPDATE SET total_score = user_scores.total_score + EXCLUDED.total_score, last_action_id = EXCLUDED.last_action_id, updated_at = EXCLUDED.updated_at`
- [x] 6.8 Wrap the entire `db.transaction()` call in a try/catch. In the catch: if `error.code === '23505'` (Postgres unique violation) AND the constraint name contains `score_events_action`, throw `new IdempotencyViolationError(event.actionId.value)`. Otherwise rethrow the original error
- [x] 6.9 Create `src/scoreboard/infrastructure/persistence/kysely/index.ts` re-exporting `KyselyUserScoreRepository`

## 7. Application layer — command and handler (capability: scoreboard-write-path)

- [x] 7.1 Create `src/scoreboard/application/commands/increment-score.command.ts` exporting `class IncrementScoreCommand` with constructor accepting `{ userId: UserId, actionId: ActionId, delta: ScoreDelta, occurredAt: Date }` and storing them as readonly properties
- [x] 7.2 Create `src/scoreboard/application/commands/increment-score.handler.ts` exporting `class IncrementScoreHandler` with `@Injectable()` decorator
- [x] 7.3 Constructor: `constructor(@Inject('UserScoreRepository') private readonly repo: UserScoreRepository) {}`
- [x] 7.4 Implement `async execute(cmd: IncrementScoreCommand): Promise<{ userId: string; newScore: number; rank: null; topChanged: null }>`
- [x] 7.5 Method body: `const aggregate = await this.repo.findByUserId(cmd.userId) ?? UserScore.empty(cmd.userId);`
- [x] 7.6 Method body: `aggregate.credit(cmd.actionId, cmd.delta, cmd.occurredAt);`
- [x] 7.7 Method body: `const events = aggregate.pullEvents();` then `await this.repo.credit(aggregate, events[0]);`
- [x] 7.8 Method body: `return { userId: cmd.userId.value, newScore: aggregate.totalScore, rank: null, topChanged: null };`
- [x] 7.9 Errors from `repo.credit` (including `IdempotencyViolationError`) propagate to the caller — do NOT swallow
- [x] 7.10 Create `src/scoreboard/application/commands/index.ts` re-exporting `IncrementScoreCommand` and `IncrementScoreHandler`

## 8. Module wiring (capability: scoreboard-write-path)

- [x] 8.1 Update `src/scoreboard/scoreboard.module.ts` to register providers
- [x] 8.2 Add provider `{ provide: 'UserScoreRepository', useClass: KyselyUserScoreRepository }`
- [x] 8.3 Add provider `IncrementScoreHandler` (class-based)
- [x] 8.4 Export `IncrementScoreHandler` so it's resolvable in `step-03`'s controller module
- [x] 8.5 Verify the module imports `DatabaseModule` (it should already be `@Global()` from `step-01`, so no explicit import needed — but verify by booting `mise run dev` and confirming no DI errors)

## 9. Handler unit tests (capability: scoreboard-write-path)

- [x] 9.1 Create `test/unit/application/fakes/fake-user-score.repository.ts` implementing `UserScoreRepository` with an internal `Map<string, UserScore>` and `Set<string>` (for actionIds)
- [x] 9.2 The fake's `findByUserId` returns the stored aggregate or null
- [x] 9.3 The fake's `credit` checks the actionId set; if present, throws `IdempotencyViolationError`; otherwise, stores the aggregate snapshot and adds the actionId
- [x] 9.4 Create `test/unit/application/increment-score.handler.test.ts` covering: happy path with existing user (rank/topChanged are null in the response), happy path with new user (uses `UserScore.empty`), idempotent replay raising `IdempotencyViolationError`, domain invariant violation (e.g. via a mocked aggregate that throws on `.credit`)
- [x] 9.5 Verify each test asserts the response shape includes `rank: null` and `topChanged: null` (will be populated in `step-05`)
- [x] 9.6 Run the tests via `pnpm jest test/unit/application` (or `mise run test` once `step-04` configures jest globally)

## 10. End-to-end validation

- [x] 10.1 `mise run typecheck` exits 0 (the new modules typecheck against `step-01`'s generated types)
- [x] 10.2 `mise run build` exits 0 and `dist/main.js` exists
- [x] 10.3 `mise run dev` boots the NestJS server. Server logs show no DI errors. `curl localhost:3000/` still returns 404 (no controllers yet — that's `step-03`)
- [x] 10.4 Manual smoke test using a one-shot script: write `scripts/smoke-credit.ts` that imports `IncrementScoreHandler` from the compiled `dist/`, builds a command for a fixed user, calls `.execute()`, and prints the result. Run it against the running Postgres. Verify both `score_events` and `user_scores` rows exist via `psql`
- [x] 10.5 Run the smoke test script TWICE with the same `actionId`. Verify the second run throws `IdempotencyViolationError` (proves the unique-violation translation works against real Postgres, even before `step-04`'s integration tests)
- [x] 10.6 Clean up `scripts/smoke-credit.ts` after verification (it's a one-shot, not a permanent fixture)

## 11. Finalize

- [x] 11.1 Run `openspec validate step-02-domain-and-write-path` and ensure it passes
- [x] 11.2 Run `openspec status --change step-02-domain-and-write-path` and confirm `isComplete: true`
- [x] 11.3 Update File List in change archive notes
