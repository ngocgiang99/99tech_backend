# scoreboard-config

## Purpose

Single typed gateway for reading environment configuration. Validates the full env-var contract from `problem6/README.md §13.3` via zod, fails fast on misconfiguration, and exposes a strongly-typed `ConfigService.get(key)` to the rest of the application. Forbids direct `process.env` access anywhere outside `src/config/`.

## Requirements

### Requirement: Single typed gateway for environment configuration

The system SHALL expose a single `ConfigService` (under `src/config/`) that is the only authorised reader of `process.env` anywhere in the application code. All other modules SHALL obtain configuration values exclusively through `ConfigService.get(key)`.

#### Scenario: Direct process.env read outside src/config is forbidden
- **WHEN** the codebase is grepped with `grep -r "process\.env" src/ --include="*.ts" | grep -v "src/config/"`
- **THEN** zero matches are returned

#### Scenario: ConfigService is injectable across all NestJS modules
- **WHEN** any provider in any module declares `constructor(private readonly config: ConfigService)`
- **THEN** the NestJS DI container resolves a single shared instance of `ConfigService` (the module is `@Global()`)

### Requirement: Strongly-typed value retrieval

The `ConfigService.get(key)` method SHALL return a value whose TypeScript type is the type inferred from the zod schema for that key. Callers SHALL NOT need to cast or assert the return type.

#### Scenario: get returns the inferred string type for DATABASE_URL
- **WHEN** `configService.get('DATABASE_URL')` is called and TypeScript compiles
- **THEN** the return type is `string` (not `string | undefined`, not `unknown`)
- **AND** assigning the result to a variable typed `string` requires no cast

#### Scenario: get returns the inferred number type for RATE_LIMIT_PER_SEC
- **WHEN** `configService.get('RATE_LIMIT_PER_SEC')` is called and TypeScript compiles
- **THEN** the return type is `number`
- **AND** the runtime value is the result of `z.coerce.number().positive()` applied to the env string

#### Scenario: get rejects unknown keys at compile time
- **WHEN** a caller writes `configService.get('NONEXISTENT_KEY')`
- **THEN** TypeScript reports a compile error because `'NONEXISTENT_KEY'` is not a key of the inferred `Config` type

### Requirement: Fail-fast on missing or malformed environment variables

When the application starts, the configuration loader SHALL parse `process.env` against the zod schema exactly once. If parsing fails for any required key, the process SHALL exit with a non-zero exit code BEFORE NestJS finishes wiring providers, AND the error message SHALL include every offending key and its zod validation issue.

#### Scenario: Missing required env var crashes boot with non-zero exit
- **WHEN** the app starts with `DATABASE_URL` unset in the environment
- **THEN** the process exits with a non-zero exit code (1)
- **AND** stderr contains a multi-line message naming `DATABASE_URL` and the zod issue (e.g. "Required")
- **AND** no NestJS provider has been instantiated by the time of exit

#### Scenario: Multiple missing env vars all reported in one boot attempt
- **WHEN** the app starts with both `DATABASE_URL` and `INTERNAL_JWT_SECRET` unset
- **THEN** the process exits with a non-zero exit code
- **AND** the stderr message lists BOTH `DATABASE_URL` and `INTERNAL_JWT_SECRET` as failing keys
- **AND** the developer does not need to fix one and re-run to discover the next

#### Scenario: Malformed value (wrong type) is rejected with a clear message
- **WHEN** the app starts with `RATE_LIMIT_PER_SEC=not-a-number`
- **THEN** the process exits with a non-zero exit code
- **AND** the stderr message names `RATE_LIMIT_PER_SEC` and the parsing failure (e.g. "Expected number, received nan")

### Requirement: Schema covers every variable from README §13.3

The zod schema in `src/config/schema.ts` SHALL define a key for every environment variable documented in `problem6/README.md §13.3`, in the same logical order (Runtime → Datastores → NATS JetStream → Auth → Rate Limiting → Observability), with validation rules appropriate to each variable's documented format and constraints. The README §13.3 table SHALL be kept in sync as env vars are added or removed.

#### Scenario: Every README §13.3 variable has a schema entry
- **WHEN** the keys of `EnvSchema` are compared against the env-var rows in `README.md §13.3`
- **THEN** every documented variable name (`NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `NATS_STREAM_NAME`, `NATS_STREAM_MAX_AGE_SECONDS`, `NATS_STREAM_MAX_MSGS`, `NATS_STREAM_MAX_BYTES`, `NATS_STREAM_REPLICAS`, `NATS_DEDUP_WINDOW_SECONDS`, `INTERNAL_JWT_SECRET`, `ACTION_TOKEN_SECRET`, `ACTION_TOKEN_SECRET_PREV`, `ACTION_TOKEN_TTL_SECONDS`, `RATE_LIMIT_PER_SEC`, `MAX_SSE_CONN_PER_INSTANCE`, `LEADERBOARD_REBUILD_TOP_N`, `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`) appears as a schema key
- **AND** no schema key exists that is not in the README
- **AND** `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` are NOT present in either the schema or the README

#### Scenario: Optional variables are marked optional in the schema
- **WHEN** `OTEL_EXPORTER_OTLP_ENDPOINT` is not set in the environment
- **THEN** the schema parses successfully (the field is `z.string().url().optional()`)
- **AND** `configService.get('OTEL_EXPORTER_OTLP_ENDPOINT')` returns `undefined`

#### Scenario: ACTION_TOKEN_SECRET enforces minimum length
- **WHEN** the app starts with `ACTION_TOKEN_SECRET=short`
- **THEN** the process exits with a non-zero exit code
- **AND** the stderr message indicates the secret does not meet the 32-character minimum (per `README.md §13.3` description "32+ random bytes")

### Requirement: Frozen configuration prevents runtime mutation

After parsing, the configuration object SHALL be frozen (via `Object.freeze`) so that any attempt to mutate `configService.get(...)` results from outside the module fails or has no effect.

#### Scenario: Mutating a returned value does not affect future reads
- **WHEN** a caller obtains `const url = configService.get('DATABASE_URL')` and then attempts `(configService as any).config.DATABASE_URL = 'mutated'`
- **THEN** the mutation either throws (in strict mode) or is silently ignored
- **AND** subsequent calls to `configService.get('DATABASE_URL')` return the original frozen value

### Requirement: ACTION_TOKEN_SECRET_PREV optional env var supports dual-secret rotation

The `EnvSchema` SHALL include an optional `ACTION_TOKEN_SECRET_PREV: z.string().min(32).optional()` field. When unset, the `HmacActionTokenVerifier` operates in single-secret mode (identical to `step-03`'s behavior). When set, the verifier operates in dual-secret rotation mode (per `scoreboard-auth`'s GAP-05 requirement).

#### Scenario: Schema accepts ACTION_TOKEN_SECRET_PREV when set with valid length
- **GIVEN** the env has `ACTION_TOKEN_SECRET_PREV=<32+ char string>`
- **WHEN** the schema parses
- **THEN** `configService.get('ACTION_TOKEN_SECRET_PREV')` returns the string
- **AND** the type is `string | undefined`

#### Scenario: Schema accepts the variable being unset (default state)
- **GIVEN** the env has no `ACTION_TOKEN_SECRET_PREV`
- **WHEN** the schema parses
- **THEN** the parse succeeds (the field is optional)
- **AND** `configService.get('ACTION_TOKEN_SECRET_PREV')` returns `undefined`

#### Scenario: Schema rejects ACTION_TOKEN_SECRET_PREV shorter than 32 chars
- **GIVEN** the env has `ACTION_TOKEN_SECRET_PREV=short`
- **WHEN** the schema parses
- **THEN** the parse fails
- **AND** the boot exits non-zero with an error naming `ACTION_TOKEN_SECRET_PREV` and the min-length constraint

### Requirement: INTERNAL_JWT_SECRET required (≥32 chars)

The `EnvSchema` SHALL include `INTERNAL_JWT_SECRET: z.string().min(32)` as a required field. When the secret is unset, boot SHALL fail-fast with a non-zero exit and an error message naming the missing key. When the secret is shorter than 32 characters, boot SHALL fail-fast with a min-length error. This is the sole secret used by `JwtGuard` to verify HS256 signatures on inbound JWTs (replaces the prior JWKS-based RS256 verification).

#### Scenario: Missing INTERNAL_JWT_SECRET crashes boot
- **WHEN** the app starts with `INTERNAL_JWT_SECRET` unset
- **THEN** the process exits with a non-zero exit code (1)
- **AND** stderr names `INTERNAL_JWT_SECRET` and the zod issue ("Required")
- **AND** no NestJS provider has been instantiated

#### Scenario: INTERNAL_JWT_SECRET shorter than 32 chars is rejected
- **WHEN** the app starts with `INTERNAL_JWT_SECRET=short`
- **THEN** the process exits with a non-zero exit code
- **AND** stderr names `INTERNAL_JWT_SECRET` and the min-length constraint

#### Scenario: Valid INTERNAL_JWT_SECRET parses successfully
- **GIVEN** `INTERNAL_JWT_SECRET=<32+ char string>`
- **WHEN** the schema parses
- **THEN** `configService.get('INTERNAL_JWT_SECRET')` returns the string
- **AND** the type is `string` (not `string | undefined`)

### Requirement: Pino redaction config redacts INTERNAL_JWT_SECRET

The Pino logger configuration in `src/shared/logger/pino-logger.factory.ts` SHALL include `INTERNAL_JWT_SECRET` in its redact paths, alongside the existing `ACTION_TOKEN_SECRET` and `ACTION_TOKEN_SECRET_PREV` entries. This ensures the secret can never accidentally appear in log lines if a developer logs `config.get('INTERNAL_JWT_SECRET')` or includes the config object in a log call.

#### Scenario: Logger redacts INTERNAL_JWT_SECRET if accidentally referenced
- **GIVEN** code that accidentally tries to log `config.get('INTERNAL_JWT_SECRET')`
- **WHEN** the log line is built
- **THEN** Pino's redaction config strips the value before serialization

### Requirement: Six new env vars for outbox publisher and SSE backpressure

The `EnvSchema` SHALL include six new fields:
- `OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(50)` — outbox polling interval in milliseconds
- `OUTBOX_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(10)` — Redis lock TTL for outbox leader election
- `OUTBOX_COALESCE_WINDOW_MS: z.coerce.number().int().positive().default(100)` — coalescing window for `leaderboard.updated` events
- `SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15000)` — SSE heartbeat interval
- `SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)` — slow client disconnect threshold (set per GAP-02 resolution)
- `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES: z.coerce.number().int().positive().default(50)` — drop-oldest threshold (set per GAP-02 resolution)

#### Scenario: All six new vars are accessible via ConfigService
- **GIVEN** the schema is updated
- **WHEN** the app boots
- **THEN** `configService.get('OUTBOX_POLL_INTERVAL_MS')` returns `50` (default)
- **AND** the same for the other five new vars

#### Scenario: Defaults match the documented design
- **WHEN** the schema is read
- **THEN** the defaults are `OUTBOX_POLL_INTERVAL_MS=50`, `OUTBOX_LOCK_TTL_SECONDS=10`, `OUTBOX_COALESCE_WINDOW_MS=100`, `SSE_HEARTBEAT_INTERVAL_MS=15000`, `SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS=5000`, `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES=50`
- **AND** the values match `step-06`'s design.md Decision 1 (GAP-02) and Decision 2

#### Scenario: .env.example is updated with the new vars
- **WHEN** `problem6/.env.example` is read
- **THEN** all six new variables are documented in their appropriate sections (Outbox / SSE)
- **AND** the values match the schema defaults
