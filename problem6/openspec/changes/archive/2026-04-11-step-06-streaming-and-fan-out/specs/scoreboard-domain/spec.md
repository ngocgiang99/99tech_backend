## ADDED Requirements

### Requirement: DomainEventPublisher port lives in the domain layer

The system SHALL define a `DomainEventPublisher` port at `src/scoreboard/domain/ports/domain-event-publisher.ts` as an `interface` with method `publish(event: DomainEvent, options: { msgId: string }): Promise<void>`. The port SHALL NOT import any framework or infrastructure symbols. The interface establishes the contract that EVERY implementation must support `Nats-Msg-Id` style dedup via the `msgId` option.

#### Scenario: Port file imports nothing framework-y
- **WHEN** `grep -r "from '@nestjs\\|from '(kysely\\|pg\\|ioredis\\|nats)'" src/scoreboard/domain/ports/domain-event-publisher.ts` is run
- **THEN** zero matches are returned

#### Scenario: DomainEvent has subject and payload
- **WHEN** the port file is read
- **THEN** it exports `interface DomainEvent { subject: string; payload: Record<string, unknown> }` (or imports a more refined type from elsewhere in domain)

#### Scenario: publish accepts msgId option
- **WHEN** the interface is read
- **THEN** the `publish` method signature includes `options: { msgId: string }`
- **AND** the JSDoc explains that `msgId` is used by infrastructure for dedup
