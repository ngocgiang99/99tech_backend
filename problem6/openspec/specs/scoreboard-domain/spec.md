# scoreboard-domain

## Purpose

The pure domain layer for the scoreboard module. Owns the `UserScore` aggregate, all value objects (`UserId`, `ActionId`, `Score`, `ScoreDelta`), the `ScoreCredited` domain event, the `UserScoreRepository` port (interface only), and the `DomainError` taxonomy. Imports nothing framework-y (no NestJS, no Kysely, no pg).

## Requirements

### Requirement: UserScore aggregate enforces non-negative total

The `UserScore` aggregate SHALL refuse to construct or rehydrate any instance whose `totalScore` is less than zero. The constructor SHALL throw `DomainError` BEFORE returning, so an invalid instance never escapes.

#### Scenario: Constructor rejects negative total
- **WHEN** `new UserScore({ userId: 'u1', totalScore: -5, ... })` is called (or its factory equivalent)
- **THEN** the call throws `DomainError` with a message naming `totalScore`
- **AND** no instance is returned

#### Scenario: Constructor accepts zero total for new users
- **WHEN** `UserScore.empty(userId)` is called
- **THEN** the returned instance has `totalScore === 0` and `lastActionId === null`
- **AND** `pullEvents()` returns an empty array (no events yet)

### Requirement: Credit method advances state and emits an event

The `UserScore.credit(actionId, delta, occurredAt)` method SHALL increase `totalScore` by `delta`, update `lastActionId` to the given `actionId`, advance `updatedAt` to `occurredAt`, and append a `ScoreCredited` event to the aggregate's internal event collection.

#### Scenario: Credit increments total and emits event
- **GIVEN** a `UserScore` with `totalScore = 10`
- **WHEN** `.credit(actionId='a1', delta=5, occurredAt=now)` is called
- **THEN** `totalScore` is `15`
- **AND** `lastActionId` is `'a1'`
- **AND** `updatedAt` equals `occurredAt`
- **AND** `pullEvents()` returns one `ScoreCredited` event with `{ userId, actionId: 'a1', delta: 5, newTotal: 15, occurredAt }`

#### Scenario: Multiple credits accumulate events
- **GIVEN** an empty `UserScore`
- **WHEN** `.credit('a1', 5, t1)` then `.credit('a2', 3, t2)` are called
- **THEN** `totalScore` is `8`
- **AND** `pullEvents()` returns two events in call order

#### Scenario: pullEvents drains the collection
- **GIVEN** an aggregate with one collected event
- **WHEN** `pullEvents()` is called
- **THEN** the returned array has one event
- **AND** a subsequent call to `pullEvents()` returns an empty array

### Requirement: ScoreDelta value object enforces bounds

The `ScoreDelta.of(n)` factory SHALL accept only positive integers within `[1, MAX_DELTA]` and throw `InvalidArgumentError` for any other input.

#### Scenario: Zero delta is rejected
- **WHEN** `ScoreDelta.of(0)` is called
- **THEN** it throws `InvalidArgumentError`

#### Scenario: Negative delta is rejected
- **WHEN** `ScoreDelta.of(-1)` is called
- **THEN** it throws `InvalidArgumentError`

#### Scenario: Non-integer delta is rejected
- **WHEN** `ScoreDelta.of(2.5)` is called
- **THEN** it throws `InvalidArgumentError`

#### Scenario: Delta above MAX_DELTA is rejected
- **WHEN** `ScoreDelta.of(MAX_DELTA + 1)` is called
- **THEN** it throws `InvalidArgumentError`

#### Scenario: Valid delta returns a typed instance
- **WHEN** `ScoreDelta.of(50)` is called
- **THEN** it returns a `ScoreDelta` instance whose `.value` is `50`

### Requirement: UserId, ActionId, and Score value objects validate their inputs

`UserId.of`, `ActionId.of`, and `Score.of` factories SHALL reject malformed inputs (non-UUID strings for IDs, negative or non-integer values for `Score`) and produce typed instances on success.

#### Scenario: UserId rejects non-UUID strings
- **WHEN** `UserId.of('not-a-uuid')` is called
- **THEN** it throws `InvalidArgumentError`

#### Scenario: UserId accepts a valid UUID
- **WHEN** `UserId.of('550e8400-e29b-41d4-a716-446655440000')` is called
- **THEN** it returns a `UserId` instance

#### Scenario: ActionId rejects non-UUID strings
- **WHEN** `ActionId.of('xyz')` is called
- **THEN** it throws `InvalidArgumentError`

#### Scenario: Score rejects negative values
- **WHEN** `Score.of(-1)` is called
- **THEN** it throws `InvalidArgumentError`

### Requirement: Domain layer imports nothing framework-y

The domain layer (`src/scoreboard/domain/`) SHALL NOT import from `@nestjs/*`, `kysely`, `pg`, `ioredis`, `nats`, or any other framework or infrastructure dependency. The only allowed external imports are TypeScript standard library types.

#### Scenario: Grep guard catches framework imports in domain
- **WHEN** `grep -r "from '@nestjs" src/scoreboard/domain/ --include="*.ts"` is run
- **THEN** zero matches are returned

#### Scenario: Grep guard catches infrastructure imports in domain
- **WHEN** `grep -rE "from '(kysely|pg|ioredis|nats|jose)'" src/scoreboard/domain/ --include="*.ts"` is run
- **THEN** zero matches are returned

### Requirement: Domain code has 100% line coverage

The unit test suite under `test/unit/domain/` SHALL achieve 100% line coverage of `src/scoreboard/domain/`. This is enforced by Jest's per-directory coverage threshold (configured in `step-04`'s test infrastructure).

#### Scenario: Domain coverage report shows 100%
- **WHEN** `mise run test:coverage` is run after `step-04` lands
- **THEN** the coverage report for `src/scoreboard/domain/**/*.ts` shows 100% lines, branches, functions, and statements
- **AND** any uncovered branch causes the build to fail
