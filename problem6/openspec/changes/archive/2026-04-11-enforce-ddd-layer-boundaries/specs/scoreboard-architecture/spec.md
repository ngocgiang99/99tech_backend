## ADDED Requirements

### Requirement: Four-layer hexagonal architecture with inward-only dependency arrows

The scoreboard module SHALL be organized into exactly four layers: `domain`, `application`, `infrastructure`, and `interface`. Each layer SHALL live under `src/scoreboard/<layer>/`. Dependencies SHALL only point inward toward domain: `interface` may depend on `application`, `domain`, and `shared`; `application` may depend on `domain` and `shared`; `infrastructure` may depend on `domain`, `application`, and `shared`; `domain` may depend on nothing outside domain (no framework imports, no third-party libraries except pure utility types).

Cross-layer communication SHALL happen through ports: interfaces defined in `src/scoreboard/domain/ports/` and implemented by concrete classes in `src/scoreboard/infrastructure/`. Layers ABOVE the domain (application, interface) SHALL consume ports via NestJS dependency injection; they SHALL NOT import concrete infrastructure classes or connect directly to databases, Redis, or NATS.

#### Scenario: Domain layer imports nothing from outside domain
- **WHEN** every file under `src/scoreboard/domain/` is grep'd for `from '.*infrastructure|from '.*application|from '.*interface|from 'kysely|from 'ioredis|from 'nats|from '@nestjs|from 'fastify`
- **THEN** zero matches are returned
- **AND** domain files import only from `domain/**` or from TypeScript/Node core types

#### Scenario: Infrastructure imports nothing from interface or application
- **WHEN** every file under `src/scoreboard/infrastructure/` is grep'd for `from '.*interface`
- **THEN** zero matches are returned
- **AND** infrastructure files may import from `domain/`, `application/`, and `shared/`

#### Scenario: Interface layer imports nothing from infrastructure (except guards and the health controller's service)
- **WHEN** every file under `src/scoreboard/interface/` is grep'd for `from '.*infrastructure`
- **THEN** the ONLY matches are:
    - Guard imports (`JwtGuard`, `ActionTokenGuard`, `RateLimitGuard`) on lines preceded by an eslint-disable comment referencing "NestJS guard via @UseGuards"
    - The `health.controller.ts` import of `HealthService` from `infrastructure/health/`, preceded by an eslint-disable comment explaining the cross-cutting health-probe exemption
- **AND** no other import crosses the `interface → infrastructure` boundary

### Requirement: Ports live in domain/ports

All cross-layer ports (interfaces for services that cross layer boundaries) SHALL live under `src/scoreboard/domain/ports/`, regardless of whether they are conceptually "domain ports" (e.g., repositories) or "application ports" (e.g., action token issuer, leaderboard updates emitter). The `application/ports/` directory MAY exist as an empty scaffold but SHALL NOT be used for the ports introduced by this capability. Single source of truth for port definitions simplifies discoverability.

#### Scenario: domain/ports/ contains all cross-layer ports
- **WHEN** `ls src/scoreboard/domain/ports/` is run
- **THEN** the directory contains at least: `user-score.repository.ts`, `leaderboard-cache.ts`, `domain-event-publisher.ts`, `leaderboard-updates.port.ts`, `action-token-issuer.port.ts`

#### Scenario: application/ports/ is not populated by this change
- **WHEN** `ls src/scoreboard/application/ports/` is run after this change is applied
- **THEN** the directory is empty (or contains only an `index.ts` that exports nothing)

### Requirement: LeaderboardUpdatesPort abstracts the in-process pub/sub

The system SHALL provide a `LeaderboardUpdatesPort` interface in `src/scoreboard/domain/ports/leaderboard-updates.port.ts` with two methods: `subscribe(callback): Unsubscribe` and `emit(event: LeaderboardUpdateEvent): void`. The port SHALL be exported alongside an injection token (`LEADERBOARD_UPDATES_PORT = Symbol('LEADERBOARD_UPDATES_PORT')`). The concrete in-process implementation SHALL live in `src/scoreboard/infrastructure/messaging/nats/` and SHALL be named `LeaderboardUpdatesInProcessAdapter` with an `implements LeaderboardUpdatesPort` annotation. `LeaderboardStreamController` SHALL inject the port via the token, not the concrete class.

#### Scenario: Port interface has exactly two methods
- **WHEN** `leaderboard-updates.port.ts` is inspected
- **THEN** the `LeaderboardUpdatesPort` interface defines exactly `subscribe(callback: LeaderboardUpdateCallback): Unsubscribe` and `emit(event: LeaderboardUpdateEvent): void`
- **AND** it exports `LeaderboardUpdateEvent`, `LeaderboardUpdateCallback`, `Unsubscribe` types
- **AND** it exports `LEADERBOARD_UPDATES_PORT` symbol

#### Scenario: Concrete adapter implements the port
- **WHEN** `LeaderboardUpdatesInProcessAdapter` class is inspected
- **THEN** its declaration reads `class LeaderboardUpdatesInProcessAdapter implements LeaderboardUpdatesPort`
- **AND** both methods are present with matching signatures

#### Scenario: LeaderboardStreamController injects the port
- **WHEN** the controller's constructor is inspected
- **THEN** the constructor parameter is `@Inject(LEADERBOARD_UPDATES_PORT) private readonly updates: LeaderboardUpdatesPort`
- **AND** the import statement references `domain/ports/leaderboard-updates.port.ts`, NOT `infrastructure/messaging/nats/leaderboard-updates.emitter.ts`

### Requirement: ActionTokenIssuer port abstracts the HMAC signing

The system SHALL provide an `ActionTokenIssuer` interface in `src/scoreboard/domain/ports/action-token-issuer.port.ts` with one method: `issue(input: { sub: string; atp: string; mxd: number }): Promise<IssuedActionToken>`. The port SHALL be exported alongside an injection token (`ACTION_TOKEN_ISSUER = Symbol('ACTION_TOKEN_ISSUER')`). `HmacActionTokenIssuer` (existing class in `infrastructure/auth/`) SHALL be marked `implements ActionTokenIssuer`. `ActionsController` SHALL inject the port via the token, not the concrete class.

#### Scenario: Port interface exists with the expected shape
- **WHEN** `action-token-issuer.port.ts` is inspected
- **THEN** the `ActionTokenIssuer` interface defines `issue(input): Promise<IssuedActionToken>`
- **AND** `IssuedActionToken` has fields `actionId: string`, `actionToken: string`, `expiresAt: Date`, `maxDelta: number`
- **AND** `ACTION_TOKEN_ISSUER` symbol is exported

#### Scenario: HmacActionTokenIssuer implements the port
- **WHEN** the concrete class is inspected
- **THEN** its declaration reads `class HmacActionTokenIssuer implements ActionTokenIssuer`
- **AND** the `issue(input)` method signature matches the port exactly

#### Scenario: ActionsController injects the port
- **WHEN** the controller's constructor is inspected
- **THEN** the constructor parameter is `@Inject(ACTION_TOKEN_ISSUER) private readonly issuer: ActionTokenIssuer`
- **AND** the import statement does NOT reference `infrastructure/auth/hmac-action-token.issuer.ts`

### Requirement: UserScoreRepository.findTopN is the single source of truth for top-N reads from Postgres

The `UserScoreRepository` port in `src/scoreboard/domain/ports/user-score.repository.ts` SHALL expose a method `findTopN(limit: number): Promise<TopEntry[]>` that returns the top N users ordered by `total_score DESC, updated_at ASC` (the GAP-01 tie-break). `KyselyUserScoreRepository` SHALL implement this method. Both `GetLeaderboardTopHandler` (for the Redis-fallback path) and `LeaderboardRebuilder` (for cold rebuilds) SHALL call this method when they need to read the top N from Postgres. No other file SHALL issue an ad-hoc `selectFrom('user_scores').orderBy('total_score', 'desc')` query.

#### Scenario: Port defines findTopN
- **WHEN** `user-score.repository.ts` is inspected
- **THEN** the `UserScoreRepository` interface includes `findTopN(limit: number): Promise<TopEntry[]>`
- **AND** `TopEntry` is exported with fields `rank`, `userId`, `score`, `updatedAt`

#### Scenario: Implementation uses canonical SQL
- **WHEN** `KyselyUserScoreRepository.findTopN(10)` is called
- **THEN** it produces a SELECT with `ORDER BY total_score DESC, updated_at ASC LIMIT 10`
- **AND** the returned entries are in rank order starting at rank 1

#### Scenario: No duplicate queries exist in the codebase
- **WHEN** `grep -r "selectFrom('user_scores').*orderBy.*total_score" src/` is run
- **THEN** matches are found ONLY in `infrastructure/persistence/kysely/user-score.repository.impl.ts` (the `findTopN` implementation)
- **AND** no matches exist in `interface/` or `application/` directories

### Requirement: ESLint boundary rule catches interface-to-infrastructure violations

`eslint.config.mjs` SHALL configure `eslint-plugin-boundaries` such that running `pnpm eslint src/` on any file that violates the inward-arrow rule reports an error. Specifically: any `interface` file that imports from `infrastructure` (other than the documented exceptions for NestJS guards and the health controller's service import) SHALL fail lint with a clear message. The rule SHALL include an explicit `disallow` for `interface → infrastructure` rather than relying on the plugin's `default: disallow` semantics.

The `allow` list for `interface` SHALL include `application`, `domain`, and `shared` (plus `external` and `core`). The missing `domain` entry in the current config is a bug that this change fixes.

#### Scenario: Explicit disallow rule is present
- **WHEN** `eslint.config.mjs` is inspected
- **THEN** the `boundaries/dependencies` rule block contains an explicit entry:
    - `from: { type: 'interface' }`
    - `disallow: [{ to: { type: 'infrastructure' } }]`
    - `message: <human-readable explanation>`

#### Scenario: Interface allow list includes domain
- **WHEN** the `interface` `from` entry in the rules array is inspected
- **THEN** its `allow` list includes `domain` alongside `application` and `shared`

#### Scenario: Synthetic violation fails lint
- **GIVEN** a temporary test file `src/scoreboard/interface/http/controllers/tmp-violation.controller.ts` that imports `import { redisClient } from '../../../infrastructure/persistence/redis/redis.client'`
- **WHEN** `pnpm eslint src/scoreboard/interface/http/controllers/tmp-violation.controller.ts` is run
- **THEN** the lint exit code is non-zero
- **AND** the error message references the `boundaries/dependencies` rule
- **AND** the error message includes the configured `message` explaining the rule
- **NOTE**: This scenario is verified manually during the implementation task; the temp file is deleted after verification

#### Scenario: Real controllers pass lint after the refactor
- **GIVEN** the four refactored controllers (`leaderboard.controller.ts`, `leaderboard-stream.controller.ts`, `scoreboard.controller.ts`, `actions.controller.ts`)
- **WHEN** `pnpm eslint src/scoreboard/interface/http/controllers/` is run
- **THEN** the lint exit code is 0
- **AND** all boundary-rule violations are either fixed or marked with a per-line eslint-disable comment with a rationale

### Requirement: Per-file eslint-disable comments are the escape hatch for documented exemptions

Exemptions from the boundary rule SHALL be expressed as per-line `// eslint-disable-next-line boundaries/dependencies` comments with an explicit rationale in the comment body. Exemptions SHALL NOT be expressed via config-file overrides that hide the exemption from casual readers. The two documented exemption categories are:

1. **NestJS guard imports** — controllers that use `@UseGuards(JwtGuard | ActionTokenGuard | RateLimitGuard)` import those classes from `infrastructure/auth/` or `infrastructure/rate-limit/`. The guard classes implement cross-cutting request-lifecycle concerns tied to the NestJS decorator system.
2. **Health controller importing its service** — `src/scoreboard/interface/health/health.controller.ts` imports `HealthService` from `src/scoreboard/infrastructure/health/`. The health service is inherently infrastructure-aware (its purpose is to probe infra health).

Any new exemption SHALL be approved via architecture review and documented both in the per-line comment and in this spec.

#### Scenario: Every guard import has a rationale comment
- **WHEN** `grep -B1 "from '.*infrastructure/auth" src/scoreboard/interface/http/controllers/` is run
- **THEN** every match is preceded by a line matching `eslint-disable-next-line boundaries/dependencies .* NestJS guard`

#### Scenario: Health controller's service import has a rationale comment
- **WHEN** `src/scoreboard/interface/health/health.controller.ts` is inspected
- **THEN** the line importing `HealthService` from `infrastructure/health/` is immediately preceded by `// eslint-disable-next-line boundaries/dependencies -- health controller is a thin HTTP adapter over infra probes`

#### Scenario: No other exemptions exist
- **WHEN** `grep -r "eslint-disable.*boundaries" src/` is run
- **THEN** the matches are ONLY the documented exemptions above
- **AND** no file has an eslint-disable comment without a rationale explaining the exemption

### Requirement: Health service lives in infrastructure/health, not interface/health

`HealthService` (the class that probes Postgres, Redis, and NATS via `SELECT 1`, `PING`, `streams.info`) SHALL live at `src/scoreboard/infrastructure/health/health.service.ts`. The HTTP `HealthController` SHALL remain at `src/scoreboard/interface/health/health.controller.ts` and SHALL import the service from its infrastructure location. Relocating the service reflects that its behavior is inherently infrastructure-aware; only the HTTP surface is interface-layer concern.

#### Scenario: Service file is at the expected path
- **WHEN** the codebase is inspected
- **THEN** `src/scoreboard/infrastructure/health/health.service.ts` exists with the `HealthService` class
- **AND** `src/scoreboard/interface/health/health.service.ts` does NOT exist

#### Scenario: Controller imports from the new path
- **WHEN** `health.controller.ts` is inspected
- **THEN** it contains `import { HealthService } from '../../../infrastructure/health/health.service'`
- **AND** the import line is preceded by the documented per-line eslint-disable comment

#### Scenario: HealthModule wiring is updated
- **WHEN** `src/scoreboard/interface/health/health.module.ts` is inspected
- **THEN** the provider registration for `HealthService` references the infrastructure path
