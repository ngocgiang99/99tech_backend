## Why

problem6 is documented as a hexagonal / DDD architecture with strict layer boundaries enforced by `eslint-plugin-boundaries`. The plugin is installed, configured in `eslint.config.mjs`, and set to `error` severity. But a survey of the `interface` layer found five files that import directly from `infrastructure` (or call `Database`/`Kysely` directly) in ways the rule should reject. `pnpm eslint src/scoreboard/interface` reports zero violations, which means the rule is configured but not actually catching the boundary breaches. There are two related gaps that this change closes:

1. **Real layer violations in the interface layer.** Controllers are doing work that belongs in the application layer (query handlers, recovery logic) or in domain ports (concrete infra classes used where a port should be injected). This makes the "strict DDD layering" claim untrue in code.

2. **The lint rule is misconfigured.** The `interface` layer's `allow` list only permits `application` and `shared` — `domain` is missing (controllers legitimately need to import port types and value objects), and the `interface → infrastructure` path that should be disallowed by default is somehow not tripping the plugin. After fixing the violations, the rule itself needs fixing so future regressions fail CI.

The specific violations are:

- **`leaderboard.controller.ts` (🔴 high)** — imports `DATABASE` token and `Database` type from `src/database`, issues a Kysely query inline as the Redis-fallback path, and maps rows into the response DTO. The fallback logic duplicates sort/tie-break decisions already made by `LeaderboardRebuilder`, and the return type is erased to `unknown[]` because the two code paths produce different shapes. This is the entry point that sparked the whole review.

- **`leaderboard-stream.controller.ts` (🔴 high)** — imports `LeaderboardUpdatesEmitter` as a concrete class from `infrastructure/messaging/nats/leaderboard-updates.emitter`. The emitter is the in-process pub/sub bridge between the JetStream subscriber and the SSE fan-out, and the controller constructor-injects the concrete type. A port (interface) should own this shape; the concrete class is an implementation detail.

- **`scoreboard.controller.ts` (🟡 medium)** — the controller's `catch` block handles `IdempotencyViolationError` by calling `this.repository.findScoreEventByActionId(...)` directly to look up the prior score event and return it as an idempotent replay result. The imports are technically legal (the repository port is in `domain/ports/`), but the *behavior* — recovery logic driven by a business-domain exception — belongs inside `IncrementScoreHandler`, not in the controller. The controller should await the handler and return; the handler should own its own layer-2 replay semantics.

- **`actions.controller.ts` (🟡 medium)** — constructor-injects `HmacActionTokenIssuer` as a concrete class from `infrastructure/auth/hmac-action-token.issuer`. Same shape as the leaderboard-stream violation: a concrete infra class leaks into the interface layer where a port should be. The HMAC signing is an implementation detail; the controller should depend on an abstract `ActionTokenIssuer` port.

- **`health.service.ts` (🟢 low — intentional but misfiled)** — imports `DATABASE`, `Redis`, `NatsConnection` directly to run `SELECT 1` / `PING` / `streams.info('SCOREBOARD')` probes. This behavior is *inherently* infrastructure-aware (its whole purpose is to verify infra reachability), so the right fix isn't a new port — it's to relocate the file from `interface/health/` to `infrastructure/health/`. The HTTP controller stays at `interface/health/health.controller.ts` and calls the relocated service.

Two existing import patterns are **not** violations and stay as they are:

- **Controllers importing guards** (`JwtGuard`, `ActionTokenGuard`, `RateLimitGuard`) from `infrastructure/auth/` and `infrastructure/rate-limit/`. These are NestJS framework decorators applied via `@UseGuards(...)`; the guard classes implement cross-cutting request-lifecycle concerns that are semantically infrastructure (HMAC verification, Redis token bucket) but architecturally tied to the NestJS decorator system. Moving them to `interface/` would be indirection for its own sake. We exempt them via per-file eslint overrides on the import lines, with a comment explaining why.

- **Domain being imported by interface.** Controllers need to import value objects (`UserId`, `ScoreDelta`, `ActionId`) and port types (`LeaderboardCache`, `UserScoreRepository`) to type their parameters and DI tokens. The current lint rule forbids this — `interface → domain` is not in the `allow` list — so the rule needs updating even though the imports are correct DDD.

This change fixes all five violations, flips the lint rule to actually catch the patterns it already claims to forbid, and adds the `interface → domain` allow that was missing.

## What Changes

- **NEW (capability)**: `scoreboard-architecture` — owns the hexagonal layering contract, the port definitions that cross layers (in the abstract — the actual ports live in `domain/ports/`), and the rules for what each layer is allowed to know about. This capability did not previously exist as a first-class spec; the layering claim lived only in ESLint config and prose. The new spec makes the rules explicit and testable.

- **NEW (code — domain ports)**:
    - `src/scoreboard/domain/ports/leaderboard-updates.port.ts` — a `LeaderboardUpdatesPort` interface with two methods: `subscribe(callback): Unsubscribe` and `emit(event: LeaderboardUpdateEvent): void`. Replaces the direct `LeaderboardUpdatesEmitter` dependency from the SSE controller and the JetStream subscriber.
    - `src/scoreboard/domain/ports/action-token-issuer.port.ts` — an `ActionTokenIssuer` interface with one method: `issue(input): Promise<IssuedActionToken>`. Replaces the direct `HmacActionTokenIssuer` dependency from `actions.controller.ts`.
    - `src/scoreboard/domain/ports/user-score.repository.ts` — **MODIFIED**: add a `findTopN(limit: number): Promise<TopEntry[]>` method to the existing interface. Used by the new query handler for the Redis-fallback path.

- **NEW (code — application query handler)**:
    - `src/scoreboard/application/queries/get-leaderboard-top.handler.ts` — a new `GetLeaderboardTopHandler` with `execute(limit: number): Promise<GetLeaderboardTopResult>` where `GetLeaderboardTopResult` is `{ source: 'hit' | 'miss', entries: TopEntry[] }`. The handler tries `LeaderboardCache.getTop(limit)` first; on any throw, it falls back to `UserScoreRepository.findTopN(limit)` and tags the result `miss`. This is symmetric with the existing `IncrementScoreHandler` command handler — the same layer, the same DI style, the same testing surface.
    - The `application/queries/` directory is already scaffolded (created in step-05 but left empty); this change fills it in.

- **MODIFIED (code — command handler)**: `src/scoreboard/application/commands/increment-score.handler.ts` takes ownership of `IdempotencyViolationError` recovery. The handler's `execute()` catches its own `IdempotencyViolationError`, calls `repo.findScoreEventByActionId(...)` to look up the prior outcome, and returns a result variant `{ result: 'idempotent-replay', ... }` alongside the existing `{ result: 'committed', ... }` shape. Callers (the controller) just `await handler.execute(cmd)` with no error-catching required for the layer-2 replay path.

- **NEW (code — infra adapter binding)**:
    - `LeaderboardUpdatesEmitter` (existing concrete class in `infrastructure/messaging/nats/`) is renamed `LeaderboardUpdatesInProcessAdapter` and marked `implements LeaderboardUpdatesPort`. No behavior change; just the interface assertion and the rename to signal it's an adapter, not a domain object.
    - `HmacActionTokenIssuer` (existing concrete class in `infrastructure/auth/`) is marked `implements ActionTokenIssuer`. No rename, no behavior change.
    - `KyselyUserScoreRepository` gains the `findTopN(limit)` implementation — a Kysely query mirroring the logic currently inlined in `leaderboard.controller.ts` and `LeaderboardRebuilder`. After this change, all three call sites share the same method.

- **MODIFIED (code — controllers)**:
    - `leaderboard.controller.ts` — rewritten to inject `GetLeaderboardTopHandler` and call `handler.execute(limit)`. The `DATABASE` import, the `Database` type import, the inline Kysely query, and the fallback-mapping code are all deleted. The `X-Cache-Status` header is set from the handler's returned `source` field (`hit` or `miss`). The return type becomes `{ entries: TopEntry[]; generatedAt: string }` — no more `unknown[]`.
    - `leaderboard-stream.controller.ts` — the `LeaderboardUpdatesEmitter` constructor parameter becomes `LEADERBOARD_UPDATES_PORT` injected via the token name. The import from `infrastructure/messaging/nats/` is deleted; the port import from `domain/ports/` replaces it. Behavior unchanged.
    - `scoreboard.controller.ts` — the `catch (IdempotencyViolationError)` block is deleted. The controller just awaits `handler.execute(cmd)` and returns. The `USER_SCORE_REPOSITORY` injection is removed from the constructor. The `InternalError` import stays only if the controller still needs it for other branches; if not, it's removed.
    - `actions.controller.ts` — the `HmacActionTokenIssuer` constructor parameter becomes `ACTION_TOKEN_ISSUER` injected via the token name. The import from `infrastructure/auth/` is deleted; the port import from `domain/ports/` replaces it. Behavior unchanged.

- **MOVED (code — health service relocation)**:
    - `src/scoreboard/interface/health/health.service.ts` → `src/scoreboard/infrastructure/health/health.service.ts`. No content change; just file location + import path updates in `health.module.ts` and `health.controller.ts`. The HTTP controller stays at `interface/health/health.controller.ts` and now imports the service from `infrastructure/health/`.
    - `interface/health/health.module.ts` — the provider for `HealthService` now references the infrastructure path.

- **MODIFIED (config — eslint boundaries)**:
    - `eslint.config.mjs` — add `domain` to the `interface` layer's `allow` list. The new rule becomes `interface → [application, domain, shared, external, core]`. This is the missing-arrow fix that lets controllers legitimately import port types and value objects without lint errors.
    - `eslint.config.mjs` — investigate and fix why `interface → infrastructure` is not currently tripping the boundary rule. This may require adjusting the element pattern, adding explicit disallow rules, or upgrading the plugin. The goal is: after this change, running `pnpm eslint src/` against any file that contains `from '.../infrastructure/...'` in the interface layer must report an error.
    - Per-file eslint-disable comments on the guard-import lines of `actions.controller.ts`, `leaderboard.controller.ts`, `leaderboard-stream.controller.ts`, and `scoreboard.controller.ts`. Each comment has the form `// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards, see docs/architecture.md`.

- **NOT CHANGED**: Domain layer (aggregate, value objects, events, services) — clean, no imports outside domain. Infrastructure layer — clean, no imports from interface/application. The `application/commands/` handler (other than the IdempotencyViolationError change to `IncrementScoreHandler`) — clean. NestJS DI container, module topology, tests' Jest config, docker-compose, database schema, env vars, all external-facing contracts (URLs, response bodies, headers).

## Capabilities

### New Capabilities

- `scoreboard-architecture`: The hexagonal layering contract. Defines what each of the four layers (`domain`, `application`, `infrastructure`, `interface`) is allowed to know about, which ports cross which layer boundaries, how NestJS guards and decorators are accommodated, and what the `eslint-plugin-boundaries` configuration must enforce. Acts as the source of truth for "can module X import from module Y?" questions.

### Modified Capabilities

- `scoreboard-leaderboard`: The `GET /v1/leaderboard/top` endpoint now routes through `GetLeaderboardTopHandler` (application layer) instead of reaching directly for the Kysely `Database` handle in the controller. Behavior is preserved — same response shape, same headers, same fallback semantics — but the layering is clean.
- `scoreboard-write-path`: `IncrementScoreHandler` now owns its own `IdempotencyViolationError` recovery. Callers (the scoreboard controller) no longer need to catch the domain error to look up the prior score event. The result type gains an `'idempotent-replay'` variant alongside the existing `'committed'` variant.
- `scoreboard-quality`: ESLint boundary enforcement is tightened. The `interface → domain` allow is added (was a bug — controllers can't import port types without it). The `interface → infrastructure` disallow is made actually work. CI running `mise run lint` fails on any future reintroduction of a boundary violation.

## Impact

**New code (~250 LOC):**
- `src/scoreboard/domain/ports/leaderboard-updates.port.ts` (~25 LOC — interface + event type)
- `src/scoreboard/domain/ports/action-token-issuer.port.ts` (~20 LOC)
- `src/scoreboard/application/queries/get-leaderboard-top.handler.ts` (~60 LOC — handler with fallback logic + result type)
- `src/scoreboard/application/queries/index.ts` (~5 LOC — barrel)
- `src/scoreboard/domain/ports/user-score.repository.ts` (+20 LOC for `findTopN` + return type)
- `test/unit/scoreboard/application/queries/get-leaderboard-top.handler.test.ts` (~80 LOC — hit path, miss path, both-fail path)
- `test/unit/scoreboard/infrastructure/persistence/kysely/user-score.repository.findTopN.test.ts` or an extension of the existing repository test (~40 LOC)

**Modified code (~200 LOC):**
- `leaderboard.controller.ts` (~60 LOC — full rewrite, net ~30 LOC after removing fallback block)
- `leaderboard-stream.controller.ts` (~5 LOC — swap constructor param to port)
- `scoreboard.controller.ts` (~30 LOC — remove catch block + repository injection)
- `actions.controller.ts` (~5 LOC — swap constructor param to port)
- `increment-score.handler.ts` (~30 LOC — add internal catch + result variant)
- `user-score.repository.impl.ts` (~25 LOC — add `findTopN` method)
- `leaderboard-updates.emitter.ts` (~3 LOC — rename + implements annotation)
- `hmac-action-token.issuer.ts` (~2 LOC — implements annotation)
- `scoreboard.module.ts` (~15 LOC — register new ports by token, wire handler, update interface-layer providers)
- `health.module.ts` (~5 LOC — update service import path)
- `eslint.config.mjs` (~15 LOC — add `domain` to interface allow, add `import/resolver.typescript` settings block, add explicit `disallow` rule with message; investigation already complete — see design.md Decision 7)

**New dev dependency (one package):**
- `eslint-import-resolver-typescript@^4.4.4` — required for `eslint-plugin-boundaries` to resolve TypeScript relative imports. Without this package the `boundaries/dependencies` rule silently passes all violations because imports resolve to `unknown`. This package is already installed in the working tree at the time this change applies; the `package.json` + `pnpm-lock.yaml` entries were added during pre-change verification

**Moved files (~0 LOC net — just file relocation):**
- `src/scoreboard/interface/health/health.service.ts` → `src/scoreboard/infrastructure/health/health.service.ts`
- Existing tests for health service (if any) move to the corresponding infra test path

**Modified tests (~100 LOC):**
- `test/unit/interface/http/controllers/leaderboard.controller.test.ts` — existing tests against the direct Kysely path are replaced by tests against a mocked `GetLeaderboardTopHandler`. The controller test becomes much smaller.
- `test/unit/interface/http/controllers/leaderboard-stream.controller.test.ts` — swap the mocked emitter for a mocked port; no behavior test changes.
- `test/unit/interface/http/controllers/scoreboard.controller.test.ts` — delete the tests that asserted the layer-2 replay catch block; move those scenarios into the handler's test file.
- `test/unit/interface/http/controllers/actions.controller.test.ts` — swap the mocked issuer for a mocked port.
- `test/unit/scoreboard/application/commands/increment-score.handler.test.ts` — add scenarios for the internal `IdempotencyViolationError` handling (happy path, replay path, prior-not-found edge case).
- `test/unit/scoreboard/infrastructure/health/health.service.test.ts` — move from `interface/health/` test path to `infrastructure/health/` path; same content.

**Operational consequences:**
- Zero public API changes — response bodies, headers, status codes, endpoints are all unchanged.
- Zero runtime dependency changes — no new packages, no upgrades.
- Zero database schema changes.
- Zero env var changes.
- **Behavior-preserving refactor**: the integration tests that cover end-to-end happy-path and fallback paths should all pass unchanged.
- CI gets stricter — `mise run lint` will start failing on any file that violates the layer rules. This is the point of the change. Future PRs that reach for `DATABASE` from a controller will fail CI before review.

**No breaking changes** from an external perspective. This is a pure architecture hygiene change.

**Out of scope:**
- Splitting `domain/ports/` vs `application/ports/` into two directories (School B). We chose School A — one directory, simpler mental model. `application/ports/` stays empty or gets removed as an unused directory in a follow-up.
- Introducing query objects, CQRS read models, or separate read/write paths beyond what already exists (writes via `IncrementScoreHandler`, reads via the new `GetLeaderboardTopHandler`).
- Moving NestJS guards out of `infrastructure/` into a neutral location. Accepted as a framework-idiom exemption with per-file eslint disables.
- Rewriting the `scoreboard-write-path` flow to use CQRS buses, mediator patterns, or any framework beyond plain NestJS DI.
- Adding interface segregation to the `LeaderboardUpdatesPort` (separate publisher and subscriber interfaces). Overkill for two callers.
- Fixing the `interface → infrastructure` eslint silence by switching plugins. First attempt is to fix the current plugin's config; if that fails, the task list includes an escalation path.
- Auditing `src/shared/` or `src/config/` for similar violations. Those layers are outside the scoreboard module's bounded context — they can be audited in a future change if needed.
- `application/ports/` directory cleanup (empty today). Leave as scaffolded; if a future change needs an application-only port, it has a home.
