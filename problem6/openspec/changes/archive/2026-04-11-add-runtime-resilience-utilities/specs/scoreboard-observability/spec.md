## ADDED Requirements

### Requirement: logWithMetadata helper exists for non-HTTP error paths

The system SHALL provide a `logWithMetadata(logger, level, err, context?)` helper at `src/scoreboard/shared/resilience/log-with-metadata.ts` that emits the same structured error log payload as the HTTP exception filter, for use in non-HTTP contexts (background workers, JetStream message handlers, bootstrap code, shutdown hooks, scheduled jobs). This helper SHALL depend on the `scoreboard-errors` primitives (`wrapUnknown`, `buildErrorMetadata`) introduced by the `restructure-error-handling-for-observability` change; it is not applicable until that change has been applied.

The helper SHALL coerce any thrown value (not just `Error` instances) into a typed `DomainError` via `wrapUnknown()`, build a metadata payload via `buildErrorMetadata()` using a synthetic background-request stub (method `'BACKGROUND'`, route `'__background'` or the caller-supplied `context.source`), and emit a single structured log entry at the requested level (`'warn' | 'error' | 'fatal'`). The optional `context` parameter SHALL be merged into the log entry as sibling fields alongside the metadata object so callers can attach job-specific dimensions like `{ job: 'outbox-publish', aggregateId: '...' }` without polluting the request-shaped metadata fields.

#### Scenario: Background error is logged with full metadata and context
- **GIVEN** a background `OutboxPublisher` encounters `new Error('publish failed')`
- **WHEN** `logWithMetadata(logger, 'error', err, { job: 'outbox-publish', aggregateId: 'abc' })` is called
- **THEN** `logger.error` is called exactly once
- **AND** the first argument contains a metadata object with `errorClass: 'InternalError'`, `message: 'publish failed'`, `stack: ...`, `method: 'BACKGROUND'`
- **AND** the first argument also contains the context fields `job: 'outbox-publish'` and `aggregateId: 'abc'` as top-level sibling keys

#### Scenario: Unknown thrown value is coerced via wrapUnknown
- **GIVEN** a bootstrap failure throws the string `'config parse error'`
- **WHEN** `logWithMetadata(logger, 'fatal', 'config parse error')` is called
- **THEN** `logger.fatal` is called (or `logger.error` if the logger does not support `fatal`)
- **AND** the metadata's `errorClass` is `'InternalError'`
- **AND** the metadata's `cause` chain contains an entry derived from the thrown string

#### Scenario: Helper works without a Fastify request in scope
- **GIVEN** a caller inside a NATS message handler (no active HTTP request)
- **WHEN** `logWithMetadata(logger, 'error', err)` is called
- **THEN** the helper succeeds
- **AND** the metadata's `method` is `'BACKGROUND'`
- **AND** the metadata's `route` is `'__background'` (no `context.source` was supplied)
- **AND** the metadata's `headers`, `query`, `body` fields are present but empty or null

#### Scenario: context.source overrides the synthetic route
- **GIVEN** a caller supplies `context: { source: 'jetstream-subscriber' }`
- **WHEN** `logWithMetadata()` runs
- **THEN** the metadata's `route` is `'jetstream-subscriber'`

#### Scenario: Helper uses the same wrapUnknown branches as the HTTP filter
- **GIVEN** the helper is invoked with a pg-shaped error (e.g. a raw `pg` unique-violation with `code: '23505'`)
- **WHEN** `logWithMetadata(logger, 'error', pgErr)` runs
- **THEN** the metadata's `errorClass` is `'ConflictError'` (delegated via `mapDbError`)
- **AND** the metadata's `pgCode` is `'23505'`

#### Scenario: Helper is defined at the expected file path
- **WHEN** the source tree is inspected
- **THEN** `src/scoreboard/shared/resilience/log-with-metadata.ts` exists
- **AND** it is exported from `src/scoreboard/shared/resilience/index.ts`
- **AND** it imports `wrapUnknown` and `buildErrorMetadata` from `src/scoreboard/shared/errors` (the barrel defined by `restructure-error-handling-for-observability`)
