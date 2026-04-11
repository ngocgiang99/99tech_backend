## ADDED Requirements

### Requirement: Six new env vars for outbox publisher and SSE backpressure

The `EnvSchema` SHALL include six new fields:
- `OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(50)` — outbox polling interval in milliseconds
- `OUTBOX_LOCK_TTL_SECONDS: z.coerce.number().int().positive().default(10)` — Redis lock TTL for outbox leader election
- `OUTBOX_COALESCE_WINDOW_MS: z.coerce.number().int().positive().default(100)` — coalescing window for `leaderboard.updated` events
- `SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15000)` — SSE heartbeat interval
- `SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000)` — slow client disconnect threshold (set per DECISION-1)
- `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES: z.coerce.number().int().positive().default(50)` — drop-oldest threshold (set per DECISION-1)

#### Scenario: All six new vars are accessible via ConfigService
- **GIVEN** the schema is updated
- **WHEN** the app boots
- **THEN** `configService.get('OUTBOX_POLL_INTERVAL_MS')` returns `50` (default)
- **AND** the same for the other five new vars

#### Scenario: Defaults match the documented design
- **WHEN** the schema is read
- **THEN** the defaults are `OUTBOX_POLL_INTERVAL_MS=50`, `OUTBOX_LOCK_TTL_SECONDS=10`, `OUTBOX_COALESCE_WINDOW_MS=100`, `SSE_HEARTBEAT_INTERVAL_MS=15000`, `SSE_SLOW_CLIENT_BUFFER_TIMEOUT_MS=5000`, `SSE_BACKPRESSURE_MAX_PENDING_MESSAGES=50`
- **AND** the values match design.md's Decision 1 and Decision 2

#### Scenario: .env.example is updated with the new vars
- **WHEN** `problem6/.env.example` is read
- **THEN** all six new variables are documented in their appropriate sections (Streaming / Outbox / SSE)
- **AND** the values match the schema defaults
