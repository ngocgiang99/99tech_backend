## REMOVED Requirements

### Requirement: JWKS_URL, JWT_ISSUER, JWT_AUDIENCE env vars

**Reason**: These env vars supported the now-removed `JwksCache` adapter. JWT verification is now performed via direct HS256 against `INTERNAL_JWT_SECRET`, so the JWKS endpoint URL, expected issuer, and expected audience are all irrelevant. The placeholder values in `.env` (`https://id.example.com/.well-known/jwks.json`, etc.) were never functional anyway. There is no production release to honor, so no migration window is needed.

**Migration**: Each developer must update their local `.env` to remove these three keys and add `INTERNAL_JWT_SECRET=<32+ random bytes>`. Boot will fail-fast with a clear error message if `INTERNAL_JWT_SECRET` is missing. The `.env.example` is updated in the same change to reflect the new contract.

## MODIFIED Requirements

### Requirement: Schema covers every variable from README §13.3

The zod schema in `src/config/schema.ts` SHALL define a key for every environment variable documented in `problem6/README.md §13.3`, in the same logical order (Runtime → Datastores → NATS JetStream → Auth → Rate Limiting → Observability), with validation rules appropriate to each variable's documented format and constraints. The README §13.3 table SHALL be updated in the same change to reflect the removal of `JWKS_URL`/`JWT_ISSUER`/`JWT_AUDIENCE` and the addition of `INTERNAL_JWT_SECRET`.

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
- **AND** the stderr message indicates the secret does not meet the 32-character minimum

## ADDED Requirements

### Requirement: INTERNAL_JWT_SECRET required (≥32 chars)

The `EnvSchema` SHALL include `INTERNAL_JWT_SECRET: z.string().min(32)` as a required field. When the secret is unset, boot SHALL fail-fast with a non-zero exit and an error message naming the missing key. When the secret is shorter than 32 characters, boot SHALL fail-fast with a min-length error.

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
