## ADDED Requirements

### Requirement: RateLimitGuard fails per the GAP-03 chosen mode when Redis is unreachable

When the Redis Lua call throws (Redis unreachable, timeout, NOSCRIPT after retry, etc.), `RateLimitGuard` SHALL behave per the DECISION-1 chosen fail mode. The chosen behavior SHALL be configurable at compile time (no runtime switching) and SHALL be documented in the runbook.

#### Scenario: Default mode (a) — fail-OPEN with critical alert
- **GIVEN** the GAP-03 decision is option (a) fail-OPEN
- **WHEN** `RateLimitGuard.canActivate()` runs and the Lua call throws
- **THEN** the guard catches the error
- **AND** increments `scoreboard_rate_limit_failed_open_total` (a new metric registered in this change)
- **AND** returns `true` (allows the request)
- **AND** the request proceeds to the handler

#### Scenario: Mode (b) — fail-CLOSED if chosen
- **GIVEN** the GAP-03 decision is option (b) fail-CLOSED
- **WHEN** the Lua call throws
- **THEN** the guard catches the error
- **AND** returns 503 TEMPORARILY_UNAVAILABLE for ALL requests
- **AND** increments `scoreboard_rate_limit_failed_closed_total`

#### Scenario: Mode (c) — degraded local fallback if chosen
- **GIVEN** the GAP-03 decision is option (c) degraded fallback
- **WHEN** the Lua call throws
- **THEN** the guard falls back to an in-memory token bucket per instance
- **AND** the bucket state is lost on instance restart (acceptable limitation)
- **AND** increments `scoreboard_rate_limit_degraded_local_total`

#### Scenario: Critical alert metric is wired
- **WHEN** the chosen fail-mode metric increments
- **THEN** the metric appears in `/metrics`
- **AND** an operator dashboard can wire a critical alert on `rate_limit_failed_open_total > 10/minute` (or similar threshold)
- **AND** the runbook describes the alerting configuration
