## ADDED Requirements

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
- **WHEN** the app starts with both `DATABASE_URL` and `JWKS_URL` unset
- **THEN** the process exits with a non-zero exit code
- **AND** the stderr message lists BOTH `DATABASE_URL` and `JWKS_URL` as failing keys
- **AND** the developer does not need to fix one and re-run to discover the next

#### Scenario: Malformed value (wrong type) is rejected with a clear message
- **WHEN** the app starts with `RATE_LIMIT_PER_SEC=not-a-number`
- **THEN** the process exits with a non-zero exit code
- **AND** the stderr message names `RATE_LIMIT_PER_SEC` and the parsing failure (e.g. "Expected number, received nan")

### Requirement: Schema covers every variable from README §13.3

The zod schema in `src/config/schema.ts` SHALL define a key for every environment variable documented in `problem6/README.md §13.3`, in the same logical order (Runtime → Datastores → NATS JetStream → Auth → Rate Limiting → Observability), with validation rules appropriate to each variable's documented format and constraints.

#### Scenario: Every README §13.3 variable has a schema entry
- **WHEN** the keys of `EnvSchema` are compared against the env-var rows in `README.md §13.3`
- **THEN** every documented variable name (`NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_URL`, `NATS_URL`, `NATS_STREAM_NAME`, `NATS_STREAM_MAX_AGE_SECONDS`, `NATS_STREAM_MAX_MSGS`, `NATS_STREAM_MAX_BYTES`, `NATS_STREAM_REPLICAS`, `NATS_DEDUP_WINDOW_SECONDS`, `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `ACTION_TOKEN_SECRET`, `ACTION_TOKEN_TTL_SECONDS`, `RATE_LIMIT_PER_SEC`, `MAX_SSE_CONN_PER_INSTANCE`, `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`) appears as a schema key
- **AND** no schema key exists that is not in the README

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
