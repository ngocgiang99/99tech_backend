## Context

problem6 is documented as a hexagonal / DDD architecture with four layers (`domain`, `application`, `infrastructure`, `interface`) and strict inward-only dependency arrows. `eslint-plugin-boundaries` is installed, `eslint.config.mjs` configures element patterns for each layer, and the `boundaries/dependencies` rule is set to `error` severity. The layering is part of the architectural claim.

A survey done before this change found five files in the `interface` layer that violate the contract in varying degrees:

- `leaderboard.controller.ts` imports `DATABASE` and `Database` from `src/database`, issues a Kysely query inline, and maps rows into a response DTO. This is the most visible violation — the controller is doing repository work.
- `leaderboard-stream.controller.ts` imports `LeaderboardUpdatesEmitter` (a concrete NATS-aware class) from `infrastructure/messaging/nats/`.
- `scoreboard.controller.ts` catches `IdempotencyViolationError` in its HTTP handler and calls `repository.findScoreEventByActionId(...)` directly to produce an idempotent-replay response. The imports are legal (the port is in `domain/ports/`) but the *behavior* is application-layer logic bleeding into the controller.
- `actions.controller.ts` injects `HmacActionTokenIssuer` (a concrete infra class) from `infrastructure/auth/`.
- `health.service.ts` imports `DATABASE`, `Redis`, `NatsConnection` clients directly — technically a violation, but its entire purpose is to probe infrastructure health.

An additional finding: running `pnpm eslint src/scoreboard/interface` today reports **zero violations** despite the code having multiple clear-cut breaches. Investigation shows two reasons:

1. The `interface` layer's `allow` list in `eslint.config.mjs` currently permits only `application` and `shared`. It does NOT include `domain`, which means correct controller imports of port types (`LeaderboardCache`, `UserScoreRepository`) would also fail lint. The fact that they don't suggests either the plugin isn't resolving the element types correctly, or the default `disallow` is being silently ignored for some category of import.
2. The `interface → infrastructure` path that should be disallowed by default is not tripping the rule on any of the five offending files.

So this change has two halves: **(a) fix the violations** by extracting ports, moving logic into the right layer, and relocating the health service; and **(b) fix the lint rule** so it actually catches what it claims to forbid going forward.

**Current state — interface layer imports that this change will change:**

```
leaderboard.controller.ts
  ├─ DATABASE, Database (from src/database)           ✗ infra
  ├─ LeaderboardCache port (from domain/ports)        ✓ ok
  ├─ JwtGuard (from infrastructure/auth)              ~ NestJS idiom
  └─ inline Kysely query + row-to-DTO mapping         ✗ application work

leaderboard-stream.controller.ts
  ├─ LEADERBOARD_CACHE_TOKEN, LeaderboardCache        ✓ ok
  ├─ JwtGuard                                         ~ NestJS idiom
  └─ LeaderboardUpdatesEmitter (concrete class)       ✗ infra
                                                         class leak

scoreboard.controller.ts
  ├─ IncrementScoreHandler (application/commands)     ✓ ok
  ├─ USER_SCORE_REPOSITORY, UserScoreRepository       ✓ ok (but used
  │                                                      for recovery
  │                                                      logic that
  │                                                      belongs in
  │                                                      the handler)
  ├─ IdempotencyViolationError (domain/errors)        ✓ ok
  ├─ Value objects (UserId, ScoreDelta, ActionId)     ✓ ok
  ├─ Guards (JwtGuard, ActionTokenGuard, RateLimit)   ~ NestJS idiom
  └─ InternalError (shared/errors)                    ✓ ok

actions.controller.ts
  ├─ HmacActionTokenIssuer (concrete class)           ✗ infra
  │                                                      class leak
  ├─ JwtGuard                                         ~ NestJS idiom
  └─ ConfigService (src/config)                       ✓ ok

health.service.ts
  ├─ DATABASE, Database (src/database)                ✗ infra
  ├─ Redis (ioredis)                                  ✗ infra
  ├─ NatsConnection (nats)                            ✗ infra
  └─ ReadinessService (shared/readiness)              ✓ ok
```

**Target state — same imports after the change:**

```
leaderboard.controller.ts
  ├─ GetLeaderboardTopHandler (application/queries)   ✓ new
  ├─ JwtGuard                                         ~ guarded idiom
  └─ (DATABASE and Kysely references deleted)

leaderboard-stream.controller.ts
  ├─ LEADERBOARD_CACHE_TOKEN, LeaderboardCache        ✓ ok
  ├─ LEADERBOARD_UPDATES_PORT, LeaderboardUpdatesPort ✓ new (from
  │                                                      domain/ports)
  ├─ JwtGuard                                         ~ guarded idiom
  └─ (LeaderboardUpdatesEmitter import deleted)

scoreboard.controller.ts
  ├─ IncrementScoreHandler                             ✓ ok
  ├─ Value objects + guards + DTOs                    ✓ ok
  └─ (USER_SCORE_REPOSITORY, UserScoreRepository,
      IdempotencyViolationError, InternalError catch
      block all deleted)

actions.controller.ts
  ├─ ACTION_TOKEN_ISSUER, ActionTokenIssuer            ✓ new (from
  │                                                      domain/ports)
  ├─ JwtGuard                                         ~ guarded idiom
  └─ (HmacActionTokenIssuer import deleted)

health.controller.ts (new import path for the service)
  └─ HealthService (from infrastructure/health)        ✓ infra → infra
                                                         is legal
```

**Constraints that shape every decision:**
- **NestJS guards must stay applicable via `@UseGuards(...)`**. Moving guards out of infrastructure would require a new set of interface-layer wrapper classes that delegate to the real guard — a ceremony tax for zero benefit.
- **eslint-plugin-boundaries must eventually catch the breaches.** If the plugin's semantics don't support what we need, we need to identify the gap during implementation and either (a) upgrade the plugin, (b) add explicit rules, or (c) document the gap and add custom CI checks.
- **Behavior is preserved end-to-end.** Integration tests that cover the HIT/MISS paths, the idempotent-replay flow, the SSE fan-out, and action token issuance must all pass without changes (unless the tests themselves were pinned to the old import shapes).
- **No new runtime deps.** All fixes are structural.
- **application/ports/ exists as an empty directory.** The original scaffolding anticipated a split between domain and application ports. This change deliberately does NOT use it (see Decision 1).

## Goals / Non-Goals

**Goals:**
- Every file in `src/scoreboard/interface/` has zero imports from `src/scoreboard/infrastructure/` except for NestJS guard classes used via `@UseGuards`.
- The four high/medium-severity violations are fixed by extracting ports and moving logic into the right layer.
- `health.service.ts` is relocated to `infrastructure/health/`; the HTTP controller stays at `interface/health/`.
- A new `GetLeaderboardTopHandler` exists in `application/queries/` and owns the cache-hit / Postgres-fallback logic.
- `IncrementScoreHandler` owns its own `IdempotencyViolationError` recovery — the controller no longer catches it.
- Two new ports exist in `domain/ports/`: `LeaderboardUpdatesPort` and `ActionTokenIssuer`.
- `UserScoreRepository` gains a `findTopN(limit)` method that both the new handler and `LeaderboardRebuilder` use — single source of truth for sort/tie-break.
- ESLint boundary rule is fixed so `pnpm eslint src/` catches `interface → infrastructure` breaches on any future regression.
- Existing integration and unit tests pass without functional changes (tests may need mock swaps from concrete classes to port interfaces).

**Non-Goals:**
- CQRS buses, mediator patterns, or framework-level command/query dispatch. Plain NestJS DI stays.
- Splitting `domain/ports/` and `application/ports/`. Single `domain/ports/` directory (School A).
- Moving NestJS guards to a neutral location. Per-file eslint overrides.
- Reviewing `src/shared/` or `src/config/` for violations. Out of scope; this change is about the `src/scoreboard/` bounded context.
- Upgrading `eslint-plugin-boundaries` to a new major version. First try to fix the current plugin's config; escalate only if we prove the plugin itself has a gap.
- Adding new ports for things that don't have violations. If a controller isn't importing concrete infra, we don't invent a port.
- Any runtime behavior change.
- Rewriting the existing `application/commands/increment-score.handler.ts` beyond the idempotency-replay addition.
- Adding integration tests for the refactor. Unit tests against the new handler + existing integration tests cover the behavior.
- `application/ports/` directory cleanup — if empty at the end, leave it. Removing empty directories is trivia.

## Decisions

### Decision 1 — Single `domain/ports/` directory (School A, not School B)

**Decision**: All ports — whether domain-conceptual (`UserScoreRepository`, `LeaderboardCache`), domain-infrastructure (`DomainEventPublisher`), application-orchestration (`ActionTokenIssuer`, `LeaderboardUpdatesPort`), or anything else — live under `src/scoreboard/domain/ports/`. The `application/ports/` directory stays empty; we do not add a file to it in this change.

**Rationale**: School A (single port directory) is simpler and the existing codebase is already mostly there. The distinction between "domain port" (conceptually part of the domain model) and "application port" (used only to orchestrate external systems from application handlers) is academic for a project this size. Forcing it adds directory cognitive load without gain.

The few ports I'm adding here — `LeaderboardUpdatesPort` and `ActionTokenIssuer` — are *arguably* application-scoped (no aggregate or domain service touches them), but putting them in `domain/ports/` alongside `UserScoreRepository` is consistent with how `DomainEventPublisher` is already scoped. The real test is "does any layer *above* domain need to know about this port?" and the answer for all our ports is "the application and infrastructure layers need to know; the domain layer defines the contract." That's the same shape across all ports.

**Alternatives rejected**:
- *School B — application/ports/ for ActionTokenIssuer and LeaderboardUpdatesPort*: rejected as a split that buys no clarity for this codebase size. Future scale-up can migrate if needed; it's a find-and-replace.
- *Put the new ports in `src/scoreboard/shared/ports/`*: rejected — `shared/` doesn't exist at the scoreboard level as a ports home; introducing it creates a third location.

### Decision 2 — `GetLeaderboardTopHandler` is an application query handler with a tagged result

**Decision**: The new handler lives at `src/scoreboard/application/queries/get-leaderboard-top.handler.ts` with this shape:

```typescript
// application/queries/get-leaderboard-top.handler.ts
@Injectable()
export class GetLeaderboardTopHandler {
  constructor(
    @Inject(LEADERBOARD_CACHE_TOKEN)
    private readonly cache: LeaderboardCache,
    @Inject(USER_SCORE_REPOSITORY)
    private readonly repo: UserScoreRepository,
  ) {}

  async execute(limit: number): Promise<GetLeaderboardTopResult> {
    try {
      const entries = await this.cache.getTop(limit);
      return { source: 'hit', entries };
    } catch {
      const entries = await this.repo.findTopN(limit);
      return { source: 'miss', entries };
    }
  }
}

export interface GetLeaderboardTopResult {
  source: 'hit' | 'miss';
  entries: TopEntry[];
}
```

The handler is injected into `LeaderboardController`. The controller calls `handler.execute(limit)` and uses the returned `source` field to set `X-Cache-Status: hit|miss`. This preserves the behavior of the existing code exactly (HIT when the cache answers, MISS when it throws and Postgres is consulted).

**Rationale**: The handler is dead-simple but it earns its keep by living in `application/queries/`. The controller becomes a thin adapter: parse the DTO, call the handler, set one header, return. The handler is testable without mocking Kysely or ioredis — pass mock ports. The fallback decision logic moves out of the HTTP layer. `LeaderboardRebuilder` can reuse the same `findTopN` port method for its rebuild scan.

**Alternatives rejected**:
- *Bake the fallback into `LeaderboardCacheImpl.getTop`*: rejected — the cache adapter would need a dependency on the repository adapter, which means two infrastructure adapters talking to each other. Awkward and couples unrelated concerns.
- *Return `TopEntry[]` directly from the handler, infer hit/miss in the controller by catching an exception*: rejected — that just moves the `try/catch` from the handler to the controller. Tagged-union return is cleaner and eliminates exception-as-control-flow at the controller boundary.
- *Return `{ entries, isFallback: boolean }`*: rejected as a synonym for the `source` enum; `'hit' | 'miss'` strings make logging and metric labels trivially correct.

### Decision 3 — `IncrementScoreHandler` owns its own `IdempotencyViolationError` recovery

**Decision**: Move the controller's `catch (IdempotencyViolationError)` block into `IncrementScoreHandler.execute()`. The handler's method becomes:

```typescript
async execute(cmd): Promise<IncrementScoreResult> {
  try {
    const result = await this.commitCredit(cmd);
    return { kind: 'committed', ...result };
  } catch (err) {
    if (err instanceof IdempotencyViolationError) {
      const prior = await this.repo.findScoreEventByActionId(cmd.actionId);
      if (!prior) {
        throw new InternalError(
          'Prior credit record not found for idempotent replay',
        );
      }
      return {
        kind: 'idempotent-replay',
        userId: prior.userId,
        newScore: prior.totalScoreAfter,
        rank: null,
        topChanged: null,
      };
    }
    throw err;
  }
}
```

The result type gains a `kind` discriminator (`'committed' | 'idempotent-replay'`) so callers can pattern-match if needed. The controller awaits the handler and returns — no catch block needed.

**Rationale**: Idempotent-replay recovery is application-layer logic. It depends on the repository (to look up the prior score event) and the domain error (to know *when* to recover). The controller had to do the work only because there was no application-layer owner; the handler is the correct owner.

Moving this into the handler also tightens the test surface: the replay case becomes a unit test against `IncrementScoreHandler` with a mocked repository, rather than an integration test of the controller + handler + repository chain.

**Alternatives rejected**:
- *Leave it in the controller*: rejected — the whole point of this change is to not have business logic in HTTP adapters.
- *Introduce a separate `IdempotencyReplayHandler`*: rejected — two handlers for one command is over-decomposition.
- *Use the tagged-result pattern for the controller to branch the response shape*: the handler's return already signals replay vs. commit via `kind`, and the response shape is identical in both cases, so no branching is needed in the controller.

### Decision 4 — `LeaderboardUpdatesPort` is one interface with both `subscribe` and `emit`

**Decision**: The port is:

```typescript
// domain/ports/leaderboard-updates.port.ts
export interface LeaderboardUpdateEvent {
  top: TopEntry[];
  updatedAt: Date;
}

export type LeaderboardUpdateCallback = (event: LeaderboardUpdateEvent) => void;
export type Unsubscribe = () => void;

export interface LeaderboardUpdatesPort {
  subscribe(callback: LeaderboardUpdateCallback): Unsubscribe;
  emit(event: LeaderboardUpdateEvent): void;
}

export const LEADERBOARD_UPDATES_PORT = Symbol('LEADERBOARD_UPDATES_PORT');
```

The concrete class `LeaderboardUpdatesEmitter` in `infrastructure/messaging/nats/` is renamed to `LeaderboardUpdatesInProcessAdapter` and marked `implements LeaderboardUpdatesPort`. The rename is small but signals that it's an adapter, not a domain concept.

**Rationale**: Two methods in one interface is simpler than split pub/sub interfaces. Interface segregation (separate `LeaderboardUpdatesPublisher` and `LeaderboardUpdatesSubscriber` interfaces) is a valid principle but overkill for exactly two call sites (the JetStream subscriber emits; the SSE controller subscribes). The principle's value scales with the number of consumers; two is not enough.

The rename from `LeaderboardUpdatesEmitter` to `LeaderboardUpdatesInProcessAdapter` is optional but valuable — "emitter" sounds like a first-class concept; "in-process adapter" signals it's the in-process implementation of a port that could have other implementations (e.g., a Redis pub/sub version for cross-pod fan-out).

**Alternatives rejected**:
- *Two ports — publisher and subscriber*: rejected for the reasons above.
- *Keep the emitter as a concrete class and just move it to `shared/`*: rejected — that's hiding the problem, not fixing the layering.

### Decision 5 — `ActionTokenIssuer` is a minimal port

**Decision**: The port is:

```typescript
// domain/ports/action-token-issuer.port.ts
export interface IssuedActionToken {
  actionId: string;
  actionToken: string;
  expiresAt: Date;
  maxDelta: number;
}

export interface ActionTokenIssuer {
  issue(input: { sub: string; atp: string; mxd: number }): Promise<IssuedActionToken>;
}

export const ACTION_TOKEN_ISSUER = Symbol('ACTION_TOKEN_ISSUER');
```

`HmacActionTokenIssuer` (existing class in `infrastructure/auth/`) is marked `implements ActionTokenIssuer`. No rename — "Hmac" in the class name is fine because it describes the implementation strategy.

The controller's `@Inject(HmacActionTokenIssuer)` becomes `@Inject(ACTION_TOKEN_ISSUER)`.

**Rationale**: One method, minimal surface. The port exists solely to sever the concrete-class dependency in `actions.controller.ts`. Future asymmetric-key implementations (Ed25519) can swap in without touching the controller.

**Alternatives rejected**:
- *Port with multiple methods (issue, revoke, verify)*: rejected — `verify` is a separate concept owned by `ActionTokenGuard`; `revoke` is out of scope.
- *Generic `TokenIssuer<TClaims, TResult>`*: rejected — premature abstraction.

### Decision 6 — Relocate `health.service.ts` from `interface/` to `infrastructure/`

**Decision**: Move the file from `src/scoreboard/interface/health/health.service.ts` to `src/scoreboard/infrastructure/health/health.service.ts`. The HTTP controller at `interface/health/health.controller.ts` updates its import path to reference the new location. The `HealthModule` (currently at `interface/health/`) also updates its provider wiring.

No content change in the service itself. The `sql\`SELECT 1\``, `redis.ping()`, and `jsm.streams.info(...)` all stay as-is.

**Rationale**: The health service's entire behavior is infrastructure-aware — its purpose is to probe infrastructure. Keeping it in `interface/health/` was a misfile. Relocating it to `infrastructure/health/` is the simplest fix: no new port, no exemption rule, no indirection. The controller in `interface/` imports from `infrastructure/` which is allowed by the `interface → infrastructure` rule once we document that as permitted for health probes OR we let the import resolve naturally because the service is now marked as an infrastructure element.

Wait — this creates a wrinkle. If `health.service.ts` is in `infrastructure/`, then `health.controller.ts` (in `interface/`) importing it is an `interface → infrastructure` import, which is exactly what the lint rule forbids.

**Resolution**: The controller's import becomes a deliberate exception with a per-file eslint-disable comment, same mechanism as the guard imports. The comment explains that the health endpoint is a cross-cutting concern and the service is a documented infrastructure probe. This is conceptually clean because the HTTP controller is just a thin adapter that exposes the infra probes over HTTP; the controller has no business logic.

**Alternatives rejected**:
- *Introduce a `HealthPort` interface*: rejected as over-engineering for three hardcoded probes.
- *Put the whole health module under `infrastructure/health/` including the controller*: rejected because NestJS controllers are conventionally in the interface layer, and the project's directory convention reflects that.
- *Use NestJS's `@nestjs/terminus` plugin*: rejected as outside this change's scope; introduces a new dependency for no immediate benefit.

### Decision 7 — ESLint boundary rule fixes (investigation complete — root cause known)

**Decision**: The pre-change investigation identified the exact root cause and applied the fix during verification. `eslint.config.mjs` has already been updated with the three required edits and the new `eslint-import-resolver-typescript` dev dependency is already installed. The implementation session inherits a working lint rule that reports the 8 ground-truth violations on day zero.

**Root cause**: `eslint-plugin-boundaries` v6 delegates import resolution to `eslint-plugin-import`, which reads `settings['import/resolver']`. If no resolver is registered, relative TypeScript imports (e.g. `../../../infrastructure/auth/jwt.guard`) resolve to `{ path: null, isUnknown: true }` and the rule silently passes because the target's element type cannot be determined. The fix is to install `eslint-import-resolver-typescript` and register it in `settings`:

```js
settings: {
  // ...existing boundaries/elements...
  'import/resolver': {
    typescript: {
      alwaysTryTypes: true,
      project: './tsconfig.json',
    },
  },
},
```

This was verified by running `ESLINT_PLUGIN_BOUNDARIES_DEBUG=1 pnpm eslint src/scoreboard/interface/__tmp-violation.ts` before and after installing the resolver. Before: `isUnknown: true`, no error reported. After: `type: 'infrastructure'`, error reported with the configured message.

**Three edits to `eslint.config.mjs`** (already applied in the working tree at the time of this change's apply phase):

1. **`import/resolver` block added** to the `settings` section of the boundaries rule config. The `project` points at `./tsconfig.json`.

2. **`domain` added to the `interface` `allow` list.** The current rule was:
   ```js
   { from: { type: 'interface' }, allow: [{ to: { type: ['application', 'shared'] } }, ...] }
   ```
   Is now:
   ```js
   { from: { type: 'interface' }, allow: [{ to: { type: ['application', 'domain', 'shared'] } }, ...] }
   ```
   This was a pre-existing bug — controllers legitimately need to import port types and value objects from `domain/`. Without the `domain` entry, every correct port-based controller refactor would fail lint immediately after the resolver fix landed.

3. **Explicit `disallow` rule added** to make the intent textual rather than relying on the `default: disallow` semantic:
   ```js
   {
     from: { type: 'interface' },
     allow: [{ to: { type: ['application', 'domain', 'shared'] } }, ...],
     disallow: [{ to: { type: 'infrastructure' } }],
     message: 'Interface layer cannot import from infrastructure. Define a port in domain/ports/ and inject it.',
   }
   ```
   The `message` field surfaces in lint output so developers know why the rule exists without needing to read this design doc.

**A gap in lint coverage, not in this change's scope**: `src/scoreboard/interface/health/health.service.ts` imports `DATABASE` from `src/database/` — a top-level path that does NOT match any `boundaries/elements` pattern. The plugin classifies the target as `unknown` and the rule is silent. This means the health service's architectural violation is caught by the grep-based survey but NOT by the lint rule. The relocation to `infrastructure/health/` (Decision 6) is the right fix, but it's a hand-driven task. Group 13 in tasks.md calls this out explicitly.

**Rationale**: Fixing the violations without fixing the rule means the rule-is-live claim is still false. Future regressions would slip through. The belt-and-braces explicit disallow makes the intent textually obvious; even readers who don't know eslint-plugin-boundaries' default semantics can understand what the rule enforces. The resolver fix is the load-bearing change — without it, the rule could not catch *any* relative-import violation regardless of how many disallow entries were added.

**Alternatives rejected**:
- *Leave the resolver unconfigured and hope*: rejected — the plugin would continue to silently pass all violations. Tested and disproven.
- *Upgrade to `eslint-plugin-import-x` with `createTypeScriptImportResolver()`*: newer alternative API. Rejected as unnecessary churn; the current `import/resolver` + `eslint-import-resolver-typescript` combination is the stable path.
- *Write a custom AST rule to replace `eslint-plugin-boundaries`*: rejected as excessive effort; the plugin works once the resolver is registered.
- *Upgrade `eslint-plugin-boundaries` past v6*: not needed; the current version works correctly with the resolver registered.

### Decision 8 — Per-file eslint overrides for guard and health-service imports

**Decision**: Every controller that uses NestJS guards via `@UseGuards(InfraGuard)` gets a per-file eslint-disable comment on the specific import line:

```typescript
// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see design.md Decision 8
import { JwtGuard } from '../../../infrastructure/auth/jwt.guard';
```

Same treatment for `health.controller.ts`:

```typescript
// eslint-disable-next-line boundaries/dependencies -- health controller is a thin HTTP adapter over infra probes, see design.md Decision 6
import { HealthService } from '../../../infrastructure/health/health.service';
```

**Rationale**: Per-line overrides with explicit rationale are the standard escape hatch. They make the exemption textual (a grep for `eslint-disable-next-line boundaries/dependencies` surfaces every exemption), auditable, and reversible. Moving the rule into a config-file exemption would hide the exemption; making it a per-line comment forces reviewers to see it every time they touch the file.

The alternative — wrapper guards in `interface/` that delegate to `infrastructure/` — is indirection without benefit.

**Alternatives rejected**:
- *Config-file exemption via a `from.filePattern` override*: rejected because the exemption becomes invisible to file readers.
- *Introduce interface-layer guard wrappers*: rejected as ceremony.
- *Move guards physically into `interface/`*: rejected — guards genuinely contain infra logic (HMAC, Redis); they're not a naming issue.

### Decision 9 — `findTopN` method on the existing `UserScoreRepository` port

**Decision**: Add a new method to `UserScoreRepository`:

```typescript
// domain/ports/user-score.repository.ts
export interface UserScoreRepository {
  // ...existing methods
  findTopN(limit: number): Promise<TopEntry[]>;
}

export interface TopEntry {
  rank: number;
  userId: string;
  score: number;
  updatedAt: Date;
}
```

Implemented by `KyselyUserScoreRepository.findTopN(limit)` with the exact same SQL that's currently inlined in `leaderboard.controller.ts` and `LeaderboardRebuilder`:

```sql
SELECT user_id, total_score, updated_at
FROM user_scores
ORDER BY total_score DESC, updated_at ASC
LIMIT $1
```

**Rationale**: Both `GetLeaderboardTopHandler` (for the fallback path) and `LeaderboardRebuilder` (for the cold rebuild) need the exact same logic. Today they duplicate it — the rebuilder has its own version, the controller has its own version. Consolidating into a single port method means a future GAP-01 tie-break change is a one-file edit.

**Tie-break**: `ORDER BY total_score DESC, updated_at ASC`. This matches the existing controller fallback. The rebuilder already uses this; the port method makes it the single canonical choice.

**Alternatives rejected**:
- *Separate `findTopNForRebuild()` and `findTopNForFallback()`*: rejected — the two call sites want identical logic.
- *Put the method on a new port*: rejected — it's about `user_scores` rows, which is already `UserScoreRepository`'s concern.

### Decision 10 — No changes to the DI module topology except new registrations

**Decision**: `ScoreboardModule` and its sub-modules gain new provider registrations for the new ports (`LEADERBOARD_UPDATES_PORT`, `ACTION_TOKEN_ISSUER`) and the new handler (`GetLeaderboardTopHandler`). Existing registrations are updated to use the token names rather than the concrete class names where the concrete class was previously injected.

No new modules are created. The existing `HealthModule` updates the `HealthService` import path. The existing `NatsModule` updates to bind `LeaderboardUpdatesInProcessAdapter` to the port token. The existing `AuthModule` updates to bind `HmacActionTokenIssuer` to the `ACTION_TOKEN_ISSUER` token.

**Rationale**: Minimum structural churn. The DI tree stays the same shape.

**Alternatives rejected**:
- *Split `ScoreboardModule` along layer boundaries (DomainModule, ApplicationModule, InfrastructureModule, InterfaceModule)*: rejected — NestJS modules are a feature-scale organizing tool, not a layer-scale one. Existing modularity is fine.

## Risks / Trade-offs

- **[Tests pinned to concrete class names may fail mock-wise]** → Mitigation: tests that currently mock `LeaderboardUpdatesEmitter` as a concrete class need to mock `LeaderboardUpdatesPort` instead. This is a find-replace. If the test uses deep mocking (`jest.mock('../../infrastructure/.../leaderboard-updates.emitter')`), that path disappears and the mock surface moves to the port token. Task list has explicit steps for each test file.
- **[eslint-plugin-boundaries may have a real bug]** → Mitigation: Decision 7's investigation task will surface the root cause. If the plugin is broken, fallback paths in the task list include upgrading it or switching to a stricter rule configuration. The escalation path is documented.
- **[`IncrementScoreHandler` internal catch may re-introduce the InternalError-when-prior-not-found case that the controller currently handles]** → Mitigation: the handler's catch block returns the same `InternalError('Prior credit record not found for idempotent replay')` that the controller currently throws. The edge case is preserved, just relocated.
- **[`health.controller.ts` importing from `infrastructure/`]** → Mitigation: this is exactly the kind of "interface → infrastructure" import the rule is supposed to forbid, and we're exempting it via a per-line override. The trade-off is explicit: "health probes are inherently infra-aware" is documented at the import site.
- **[Rename of `LeaderboardUpdatesEmitter` → `LeaderboardUpdatesInProcessAdapter`]** → Mitigation: the class rename is a mechanical edit. All references (subscriber, controller, module, tests) need updating. The task list has explicit steps.
- **[Behavior drift in `findTopN`]** → Mitigation: the new port method uses identical SQL to the current inlined query. An integration test (or a unit test against `KyselyUserScoreRepository`) asserts the SQL produces the same result shape as the existing controller fallback.
- **[Larger-than-usual change surface (~200 LOC touched across 12 files)]** → Mitigation: grouped by task group in tasks.md so each commit is independently reviewable. The change is structurally uniform — each fix follows the same pattern (port + injection token + controller swap) — so reviewers can skim after the first few fixes.
- **[Port token symbols vs string tokens]** → NestJS's `@Inject()` accepts both `Symbol` and `string` tokens. Existing code uses a mix. The new ports use `Symbol` (e.g., `ACTION_TOKEN_ISSUER = Symbol('ACTION_TOKEN_ISSUER')`) for type safety and collision avoidance. Existing string tokens stay.
- **[Increased cognitive load from more ports]** → Every new port is a small layer of indirection. For two new ports (`LeaderboardUpdatesPort`, `ActionTokenIssuer`) and one new method (`findTopN`), the indirection tax is small and the benefit — a testable, mockable, swappable interface — is obvious.

## Migration Plan

This is a purely structural refactor; no data migration, no config change, no env var change.

1. Ensure `restructure-error-handling-for-observability` and `add-runtime-resilience-utilities` are applied first (both already applied as of the branch state). This change depends on the domain error classes and the singleflight primitive being in place but does not re-modify them.
2. Apply this change's task groups in order:
    - Group 1: add new port interfaces (`LeaderboardUpdatesPort`, `ActionTokenIssuer`, `findTopN` on `UserScoreRepository`)
    - Group 2: implement `findTopN` in `KyselyUserScoreRepository`
    - Group 3: rename `LeaderboardUpdatesEmitter` to `LeaderboardUpdatesInProcessAdapter`, mark as implementing the port
    - Group 4: mark `HmacActionTokenIssuer` as implementing the port
    - Group 5: create `GetLeaderboardTopHandler` in `application/queries/`
    - Group 6: modify `IncrementScoreHandler` to own idempotency replay
    - Group 7: refactor `leaderboard.controller.ts` to use the handler
    - Group 8: refactor `leaderboard-stream.controller.ts` to inject the port
    - Group 9: refactor `scoreboard.controller.ts` to remove the catch block
    - Group 10: refactor `actions.controller.ts` to inject the port
    - Group 11: relocate `health.service.ts` from `interface/` to `infrastructure/`
    - Group 12: update DI module registrations (`ScoreboardModule`, `HealthModule`, etc.)
    - Group 13: update all affected tests (controller mocks, handler additions, relocated health service test)
    - Group 14: fix `eslint.config.mjs` — add `domain` to interface allow, debug and fix the missing disallow, add explicit disallow as belt-and-braces
    - Group 15: add per-file eslint-disable comments on guard imports and the health controller's service import
    - Group 16: run `mise run typecheck && mise run lint && mise run test && mise run test:integration`; confirm all green
    - Group 17: `openspec validate enforce-ddd-layer-boundaries`
3. Merge as one commit (or a sequence of commits per task group, whichever the operator prefers).

**Rollback**: Every step is revertible via `git revert`. No data to roll forward or back. The only irreversible state is commits; standard git discipline applies.

## Open Questions

None unresolved. The seven scoping questions were answered in the exploration session. The only unknown is the root cause of eslint-plugin-boundaries not firing today, which is explicitly called out as an investigation task in Group 14 of tasks.md. If the investigation reveals a plugin bug, the task list has escalation paths (explicit disallow rule, plugin upgrade, or custom AST check as a last resort).
