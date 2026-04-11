## Context

`step-01` established the typed `ConfigService` and the `Database` (Kysely) injectable. The Postgres schema is migrated and `types.generated.ts` is committed. The empty `ScoreboardModule` placeholder from `step-00` is wired into `AppModule` but provides nothing. The DDD folder tree is in place (from `step-00`'s scaffolding) with `.gitkeep` files marking the empty leaves.

This change populates three of those leaves:
- `src/scoreboard/domain/` — pure TypeScript, no framework imports
- `src/scoreboard/application/commands/` — depends on domain only
- `src/scoreboard/infrastructure/persistence/kysely/` — depends on domain (port) + framework (NestJS DI + Kysely)

The work is constrained by:
- **Hexagonal layering**: domain depends on nothing; application depends only on domain; infrastructure may depend on application + domain to implement ports; interface depends on application. Enforced by `eslint-plugin-boundaries` once `step-04` lands; until then, the dev must self-enforce.
- **NFR-11**: domain layer must reach 100% line coverage (it's pure logic — no excuse not to).
- **No HTTP yet**: there are no controllers, no auth, no error filter. The handler must work standalone via `await handler.execute(cmd)`.

## Goals / Non-Goals

**Goals:**
- A `UserScore` aggregate that cannot exist in an invalid state (constructor + factory both reject `totalScore < 0`).
- Value objects (`UserId`, `ActionId`, `Score`, `ScoreDelta`) that encapsulate parsing rules and prevent primitive obsession in callers.
- A `.credit(actionId, delta, occurredAt)` method that mutates state, advances `updatedAt`, and emits a `ScoreCredited` domain event (collected on the aggregate, drained by the handler).
- A `KyselyUserScoreRepository` whose `.credit(userId, scoreEvent)` writes both `score_events` and `user_scores` in a single transaction. RMW pattern: SELECT ... FOR UPDATE the `user_scores` row, INSERT the `score_events` row, UPDATE the `user_scores.total_score`, COMMIT.
- A clean `IdempotencyViolationError` raised when the unique constraint on `score_events.action_id` rejects a duplicate insert. The repository catches `pg`'s `error.code === '23505'` and converts it.
- An `IncrementScoreHandler.execute(cmd)` that orchestrates: load aggregate (or create empty one if user has no row yet) → call `.credit()` → persist via repository → drain domain events → return DTO.
- Unit tests covering: domain happy path, every domain invariant violation, every value-object validation rule, the handler happy path, the handler idempotent-replay path, the handler invariant-failure path. All using an in-memory `FakeUserScoreRepository` (no Postgres).

**Non-Goals:**
- Real-Postgres integration tests — `step-04`.
- Idempotency layer 1 (Redis SETNX) — `step-03`.
- Idempotency layer 3 (JetStream dedup) — `step-05`/`step-06`.
- Concurrency safety beyond `SELECT FOR UPDATE` — no MVCC tuning, no isolation level overrides.
- Caching the aggregate in memory between requests — every request reads fresh from Postgres.
- Domain-event publication beyond local drain on the aggregate — `step-05`/`step-06` introduce the outbox + JetStream publisher.
- Any HTTP/REST surface — `step-03`.

## Decisions

### Decision 1: Aggregate root mutability and event collection

**What**: `UserScore` is a class with private mutable state (`totalScore: number`, `lastActionId: string | null`, `updatedAt: Date`) and a private `_events: ScoreCredited[]` array. `.credit()` mutates state in place and pushes a new event. The handler calls `.pullEvents()` after persistence to drain.

**Why**:
- Mutability is fine inside an aggregate — DDD doesn't mandate immutability, only that mutation goes through methods that enforce invariants.
- The event-collection pattern (versus an event-sourced design) is the standard for transactional outbox: events are produced as a side-effect of state mutation and drained after persistence so they go in the same DB transaction (will land in `step-05` when the outbox table is added).
- Pulling events after persistence (not inside `.credit()`) prevents accidental double-publish if the aggregate is re-saved.

**Alternatives considered**:
- **Event-sourced aggregate** (rebuild state from events). Rejected — overkill for a single-aggregate module with one mutation type.
- **Returning new aggregate instances from each method** (immutable). Rejected — adds copy overhead and forces the handler to track which instance is current.

### Decision 2: Value objects with `.of()` factories, not constructors

**What**: Each value object exposes a static `.of(raw): VO` factory that validates and constructs. The constructor is private. `ScoreDelta.of(0)` throws `InvalidArgumentError`; `UserId.of('not-a-uuid')` throws.

**Why**:
- Factories give the validator a name (`UserId.of`) which is greppable in stack traces.
- Private constructors enforce that all instances pass through validation — no sneaky `new UserId('x')` workarounds.
- Mirrors the pattern used in `kysely-codegen`'s generated types and the `zod` schema in `step-01` — consistency across the codebase.

**Alternatives considered**:
- **Branded types** (`type UserId = string & { __brand: 'UserId' }`). Rejected — gives compile-time safety but no runtime validation; we want both.
- **Public constructors with validation**. Rejected — `new UserId(x)` doesn't communicate "this might throw" the way `UserId.of(x)` does.

### Decision 3: Repository's `credit()` signature takes the aggregate, not a DTO

**What**: `UserScoreRepository.credit(aggregate: UserScore, event: ScoreCredited): Promise<void>`. The handler passes the post-mutation aggregate; the repository inspects it to derive the SQL.

**Why**:
- Keeps the application layer ignorant of SQL shape.
- The aggregate already has `userId`, `totalScore`, `updatedAt`, `lastActionId` — no DTO mapping needed.
- The event carries `actionId`, `delta`, `occurredAt` for the `score_events` insert.

**Alternatives considered**:
- **Repository takes a `(userId, delta, actionId, occurredAt)` flat tuple**. Rejected — leaks aggregate internals into the call site, harder to extend.
- **Repository takes only the event** (no aggregate). Rejected — the repository would need to read `total_score` from Postgres again, defeating the RMW pattern; or the handler would have to compute the new total and pass it, which puts business logic in the handler.

### Decision 4: Repository uses `SELECT ... FOR UPDATE` for the `user_scores` row inside the transaction

**What**: The transaction body is:
```sql
BEGIN;
SELECT total_score FROM user_scores WHERE user_id = $1 FOR UPDATE;  -- existing row, or no rows
INSERT INTO score_events (id, user_id, action_id, delta, created_at) VALUES (...);  -- raises 23505 if action_id duplicate
INSERT INTO user_scores (user_id, total_score, last_action_id, updated_at)
  VALUES ($1, $delta, $action_id, now())
  ON CONFLICT (user_id) DO UPDATE SET
    total_score = user_scores.total_score + EXCLUDED.total_score,
    last_action_id = EXCLUDED.last_action_id,
    updated_at = EXCLUDED.updated_at;
COMMIT;
```

**Why**:
- `SELECT ... FOR UPDATE` blocks concurrent transactions on the same `user_id`, ensuring the read-modify-write is serializable for that row.
- `ON CONFLICT (user_id) DO UPDATE` handles both "new user" and "existing user" cases in one statement (no client-side branching).
- The `INSERT INTO score_events` runs BEFORE the `user_scores` upsert so the unique-constraint check on `action_id` happens early — if it fails, the upsert is skipped and the transaction rolls back.

**Alternatives considered**:
- **Optimistic locking with a version column on `user_scores`**. Rejected — adds a column to the schema for a problem `FOR UPDATE` solves cleanly. Revisit if NFR-02 load tests show row-lock contention.
- **`INSERT ... ON CONFLICT` without the SELECT FOR UPDATE**. Rejected — works but doesn't serialize concurrent inserts to the same `user_id` cleanly.
- **Two separate transactions** (one for `score_events`, one for `user_scores`). Rejected — violates FR-08's "atomic with audit" requirement.

### Decision 5: Handler returns `null` for `rank` and `topChanged` in this change

**What**: The DTO returned by `IncrementScoreHandler.execute()` is `{ userId: string, newScore: number, rank: null, topChanged: null }`. The `rank` and `topChanged` fields are typed `number | null` and `boolean | null` respectively.

**Why**:
- Story 2.4 (in `step-05`) populates these by calling `LeaderboardCache.getRank()` and `getTop()` after the post-commit ZADD. Until the leaderboard cache exists, the handler can't compute them.
- Returning `null` (rather than omitting the keys) keeps the response shape stable across changes — no breaking-API moment when `step-05` populates them.
- The HTTP controller (in `step-03`) can serialize `null` directly into JSON without conditional logic.

**Alternatives considered**:
- **Omit the keys until `step-05`**. Rejected — the controller would need to know which version of the handler is in play.
- **Return a discriminated union** (`{ committed: true, ...} | { committed: true, withRank: true, rank, topChanged }`). Rejected — complexity for no benefit at this stage.

## Risks / Trade-offs

- **[Risk]** Without integration tests against real Postgres, the `IdempotencyViolationError` translation logic is only verified by mocking pg's error shape → **Mitigation**: `step-04`'s Testcontainers test suite is the first end-to-end check. The `pg.DatabaseError` shape is well-documented (`code: '23505'`); the mock matches the real driver. If the mock drifts from reality, `step-04` catches it.

- **[Risk]** The `SELECT ... FOR UPDATE` pattern serializes writes per-user-id. Under NFR-02 (1500 writes/sec) with skewed traffic (one popular user), this could become the bottleneck → **Mitigation**: skewed traffic is unlikely in a per-user score-credit model (users credit their own scores). Revisit if `step-07`'s k6 load tests reveal contention.

- **[Risk]** The `ScoreCredited` event is collected on the aggregate but never published in this change → **Mitigation**: explicitly documented as "drained but discarded" until `step-05` adds the outbox. The handler test asserts `pullEvents().length === 1` so the collection logic doesn't silently break.

- **[Trade-off]** 100% domain coverage is a hard target. With 4 value objects + 1 aggregate + 1 event, that's roughly 60 test assertions. Worth the time — the domain is the one place where bugs are cheapest to find and most expensive to ship.

- **[Trade-off]** No interfaces for the value objects (`UserId`, etc.) — they're concrete classes. If a future change wants to swap implementations (e.g. for cross-context use), this would require refactoring. Accepted because YAGNI: there's exactly one bounded context in v1.

## Open Questions

- **Q1: Should `UserScore` enforce a maximum total score?** `BIGINT` in Postgres can hold up to ~9.2e18, but the application could enforce a tighter cap (e.g. `MAX_SAFE_INTEGER` to keep JSON serialization safe). **Default decision**: enforce `Number.MAX_SAFE_INTEGER` as a soft cap in `Score.of()` and document it. Revisit if a real cap requirement emerges.

- **Q2: Where should `MAX_DELTA` (the per-action max delta cap) be defined?** `ScoreDelta.of(n)` enforces `1 <= n <= MAX_DELTA`. The action token (`step-03`) carries a per-action `mxd` claim, so `MAX_DELTA` is more like an absolute ceiling. **Default decision**: hardcode `MAX_DELTA = 10000` in `ScoreDelta.ts` for v1. The action token's `mxd` claim can be tighter on a per-action basis. Add to config schema only if v2 needs runtime tuning.

- **Q3: Should the handler emit a log line on idempotent replay?** **Default decision**: yes — at `info` level, with the original `actionId` and `userId`. Helps diagnostics. Will use the Pino logger from `step-04` once it lands; until then, `console.info` is acceptable.

- **Q4: How should the in-memory `FakeUserScoreRepository` simulate the unique-violation case?** **Default decision**: keep an internal `Set<actionId>`; on `.credit()`, check if the actionId is already in the set, and if so, throw `IdempotencyViolationError` directly (skipping the SQL-translation step). The point of the fake is to exercise the handler's error-handling path, not the repository's translation logic — the latter is verified in `step-04`.
