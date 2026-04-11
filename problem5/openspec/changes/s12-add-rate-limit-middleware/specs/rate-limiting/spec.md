## ADDED Requirements

### Requirement: Per-IP Rate Limit Middleware

The Resources API SHALL apply a per-IP rate-limit middleware to every HTTP request that reaches the application except for explicitly excluded paths. The middleware SHALL maintain a single global bucket per source IP shared across all routes and methods, and it SHALL be implemented as an Express middleware factory in `src/middleware/rate-limit.ts`.

#### Scenario: Middleware fires for `/resources` traffic from a single IP

- **WHEN** a single client at IP `203.0.113.5` issues `RATE_LIMIT_MAX + 1` requests to `GET /resources` within a single `RATE_LIMIT_WINDOW_MS` window
- **THEN** the first `RATE_LIMIT_MAX` responses succeed with their normal status code
- **AND** the `(RATE_LIMIT_MAX + 1)`-th response has status `429`
- **AND** the response body is the canonical error envelope `{ error: { code: "RATE_LIMIT", message: <safe string>, requestId: <uuid> } }`
- **AND** the `Retry-After` HTTP header is present with a positive integer value

#### Scenario: Middleware uses one bucket across routes and methods

- **WHEN** a single client mixes `GET /resources`, `POST /resources`, and `GET /resources/:id` requests within one window
- **THEN** all three contribute to the same per-IP counter
- **AND** the counter trips at `RATE_LIMIT_MAX` regardless of which route the `(RATE_LIMIT_MAX + 1)`-th request lands on

### Requirement: 429 Responses Use the AppError Pipeline

429 responses SHALL be produced by constructing a `RateLimitError` (already defined in `src/shared/errors.ts` from the `error-handling` capability) and calling `next(err)`. The middleware SHALL NOT construct or send a JSON error body directly. The central error handler SHALL render the response using the same allowlist body shape used for every other 4xx error.

#### Scenario: 429 body matches the error-handling allowlist

- **WHEN** the limiter fires
- **THEN** the response body contains exactly the keys allowed by the `error-handling` capability's response allowlist (`code`, `message`, `requestId`, optional `details`)
- **AND** the body does NOT contain any of the leak indicators tested by the existing `error-handling` integration leak-check test

#### Scenario: 429 is logged via the central handler at the documented level

- **WHEN** the limiter fires
- **THEN** exactly one structured log line is emitted with the configured request id, the route, the method, the source IP, and the rate-limit code
- **AND** no log line is emitted from inside the rate-limit middleware itself

### Requirement: Loopback Bypass Is Always Active

The middleware SHALL always skip rate-limit counting for requests whose `req.ip` (after `trust proxy` resolution) is `127.0.0.1`, `::1`, or the IPv4-mapped form `::ffff:127.0.0.1`. The bypass SHALL NOT be configurable, conditional on env, or disable-able. It SHALL apply in `development`, `test`, and `production`.

#### Scenario: Loopback request is never rate-limited

- **WHEN** a client whose `req.ip` is `127.0.0.1` issues `2 × RATE_LIMIT_MAX` requests in one window
- **THEN** every response has its normal (non-429) status code
- **AND** no log line about rate-limit firing is emitted

#### Scenario: IPv6 loopback is recognized

- **WHEN** a client whose `req.ip` is `::1` issues `RATE_LIMIT_MAX + 1` requests in one window
- **THEN** the `(RATE_LIMIT_MAX + 1)`-th request returns its normal status, not 429

#### Scenario: IPv4-mapped loopback is recognized

- **WHEN** a client whose `req.ip` is `::ffff:127.0.0.1` issues `RATE_LIMIT_MAX + 1` requests in one window
- **THEN** the `(RATE_LIMIT_MAX + 1)`-th request returns its normal status, not 429

### Requirement: Allow-list Bypass via Env CIDR List

The middleware SHALL also skip rate-limit counting for requests whose `req.ip` matches any CIDR in the parsed `RATE_LIMIT_ALLOWLIST_CIDRS` env var. The env var SHALL be a comma-separated list of IPv4 or IPv6 CIDRs (e.g. `172.16.0.0/12,10.0.0.0/8`). An empty or unset env var SHALL mean "no extra CIDRs allow-listed" (loopback is still always allowed).

#### Scenario: Request from allow-listed CIDR is not counted

- **WHEN** `RATE_LIMIT_ALLOWLIST_CIDRS=172.16.0.0/12` and a client whose `req.ip` is `172.20.0.5` issues `2 × RATE_LIMIT_MAX` requests
- **THEN** every response has its normal (non-429) status code

#### Scenario: Request from a non-allow-listed IP is counted

- **WHEN** `RATE_LIMIT_ALLOWLIST_CIDRS=172.16.0.0/12` and a client whose `req.ip` is `203.0.113.5` issues `RATE_LIMIT_MAX + 1` requests
- **THEN** the `(RATE_LIMIT_MAX + 1)`-th request returns 429

#### Scenario: Empty env means loopback only

- **WHEN** `RATE_LIMIT_ALLOWLIST_CIDRS` is unset or empty and a client whose `req.ip` is `192.168.1.5` issues `RATE_LIMIT_MAX + 1` requests
- **THEN** the `(RATE_LIMIT_MAX + 1)`-th request returns 429

### Requirement: Production Safety Assertion on Wide-Open CIDR

The startup config loader (`loadConfig()` in `src/config/env.ts`) SHALL parse `RATE_LIMIT_ALLOWLIST_CIDRS` and SHALL refuse to start the process when `NODE_ENV === 'production'` and the parsed list contains `0.0.0.0/0`, `::/0`, or any CIDR that includes either of those (e.g. `0.0.0.0/1`). The error message SHALL identify the offending CIDR and SHALL point at the rate-limit design doc.

#### Scenario: Production refuses 0.0.0.0/0

- **WHEN** `NODE_ENV=production` and `RATE_LIMIT_ALLOWLIST_CIDRS=0.0.0.0/0`
- **THEN** `loadConfig()` exits the process with a non-zero status before the HTTP server starts
- **AND** the error message names the offending CIDR

#### Scenario: Production refuses ::/0

- **WHEN** `NODE_ENV=production` and `RATE_LIMIT_ALLOWLIST_CIDRS=::/0`
- **THEN** `loadConfig()` exits the process with a non-zero status before the HTTP server starts

#### Scenario: Development tolerates wide-open CIDR (with a warning)

- **WHEN** `NODE_ENV=development` and `RATE_LIMIT_ALLOWLIST_CIDRS=0.0.0.0/0`
- **THEN** the process starts successfully
- **AND** a single `warn`-level log line is emitted at startup naming the wide-open CIDR

### Requirement: Excluded Paths Are Not Counted

The paths `/healthz` (and any sub-path of it) and `/metrics` SHALL NOT participate in the rate-limit counter. They SHALL NOT be bypassed (which would still increment the counter); they SHALL be skipped before the counter is touched.

#### Scenario: Healthcheck traffic does not consume the bucket

- **WHEN** Docker hits `GET /healthz?probe=liveness` once per second for an extended period from a single source IP
- **THEN** the per-IP counter for that IP remains zero
- **AND** subsequent `/resources` traffic from the same IP starts with a fresh `RATE_LIMIT_MAX` budget

#### Scenario: Metrics scrape does not consume the bucket

- **WHEN** Prometheus scrapes `GET /metrics` every 15 seconds from a single source IP
- **THEN** the per-IP counter for that IP is unaffected
- **AND** the scrape never returns 429

### Requirement: Trust Proxy Configured for Reverse-Proxy Topologies

`buildApp()` in `src/http/app.ts` SHALL call `app.set('trust proxy', 'loopback, linklocal, uniquelocal')` so that `req.ip` reflects the real client IP when the API runs behind a trusted reverse proxy (e.g. the nginx in the s11 prod compose). The middleware SHALL read `req.ip` after this setting is applied.

#### Scenario: Behind nginx, real client IP is used

- **WHEN** the API runs behind nginx in the s11 prod compose and nginx forwards a request from public client `198.51.100.5` with `X-Forwarded-For: 198.51.100.5`
- **THEN** `req.ip` inside the rate-limit middleware is `198.51.100.5`
- **AND** the per-IP counter increments for `198.51.100.5`, not for the nginx container's bridge IP

#### Scenario: Spoofed X-Forwarded-For from public client is rejected

- **WHEN** a public client sends `X-Forwarded-For: 127.0.0.1` directly to the API (no proxy in between)
- **THEN** `req.ip` inside the middleware is the public client's actual TCP peer address, not `127.0.0.1`
- **AND** the loopback bypass does NOT apply
- **AND** the request is counted toward the public client's bucket

### Requirement: Shared State Across Replicas via Redis

The rate-limit middleware SHALL use a Redis-backed store so that the counter is shared across all running API replicas. With `N` replicas, a single client at one IP issuing `RATE_LIMIT_MAX + 1` requests across the replicas SHALL receive at most `RATE_LIMIT_MAX` non-429 responses in aggregate.

#### Scenario: Three replicas enforce a single bucket

- **WHEN** the s11 prod compose is running with three API replicas behind nginx and a single client issues `RATE_LIMIT_MAX + 1` requests round-robined across the three replicas within one window
- **THEN** at most `RATE_LIMIT_MAX` responses are non-429
- **AND** at least one response is 429
- **AND** the effective limit is NOT `3 × RATE_LIMIT_MAX`

#### Scenario: The limiter uses the existing Redis client connection

- **WHEN** the rate-limit middleware initializes
- **THEN** it constructs its store using the same ioredis client instance that the response cache uses
- **AND** no additional Redis connection is opened solely for the rate limiter

### Requirement: Configuration via Env

`src/config/env.ts` SHALL define exactly four rate-limit env vars: `RATE_LIMIT_ENABLED` (boolean, default `true`), `RATE_LIMIT_WINDOW_MS` (positive integer, default `60000`), `RATE_LIMIT_MAX` (positive integer, default `1000`), and `RATE_LIMIT_ALLOWLIST_CIDRS` (string, default empty). Each var SHALL be validated by the existing Zod schema and SHALL fail loud at startup on invalid input.

#### Scenario: RATE_LIMIT_ENABLED=false disables the middleware

- **WHEN** `RATE_LIMIT_ENABLED=false`
- **THEN** `buildApp()` does not register the rate-limit middleware at all
- **AND** no Redis call is made for rate-limit counting on any request
- **AND** every request, regardless of source IP or volume, returns its normal (non-429) response

#### Scenario: Invalid RATE_LIMIT_MAX fails startup

- **WHEN** `RATE_LIMIT_MAX=-5`
- **THEN** `loadConfig()` exits the process with a non-zero status before the HTTP server starts

#### Scenario: Invalid CIDR syntax in allow-list fails startup

- **WHEN** `RATE_LIMIT_ALLOWLIST_CIDRS=not-a-cidr`
- **THEN** `loadConfig()` exits the process with a non-zero status before the HTTP server starts
- **AND** the error message identifies the offending entry

### Requirement: 429 Responses Carry IETF Draft RateLimit Headers

429 responses (and successful responses subject to the limiter) SHALL carry the IETF draft-7 `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers. 429 responses SHALL additionally carry a `Retry-After` header with a positive integer value derived from `req.rateLimit.resetTime`.

#### Scenario: Successful response carries RateLimit-* headers

- **WHEN** a non-loopback client issues `GET /resources` and is under the limit
- **THEN** the response includes headers `RateLimit-Limit: <RATE_LIMIT_MAX>`, `RateLimit-Remaining: <remaining>`, `RateLimit-Reset: <epoch-seconds>`

#### Scenario: 429 response carries Retry-After

- **WHEN** the limiter fires
- **THEN** the 429 response includes a `Retry-After` header with an integer value ≥ 1
- **AND** the value reflects the time until the bucket window resets

#### Scenario: Loopback bypass does not strip headers

- **WHEN** a loopback client issues `GET /resources`
- **THEN** the response either omits the `RateLimit-*` headers entirely (because the limiter was skipped) or carries them with values reflecting that the request was not counted
- **AND** in neither case does the response carry a misleading `Retry-After`

### Requirement: Middleware Order in `buildApp`

The rate-limit middleware SHALL be registered in `src/http/app.ts` after `pinoHttp` and before `express.json()`. It SHALL NOT be mounted on a sub-router. The exclusion list (`/healthz`, `/metrics`) SHALL be enforced inside the middleware via a path check, not by mounting on `/resources` only.

#### Scenario: Middleware order in `buildApp`

- **WHEN** a reader inspects `src/http/app.ts` after this change
- **THEN** the order of `app.use` calls is: `requestIdMiddleware` → (optional metrics) → `pinoHttp(...)` → rate-limit middleware → `express.json(...)` → routes → error handler
- **AND** the rate-limit middleware is registered exactly once at the application level, not inside any feature module factory

#### Scenario: 429s appear in HTTP metrics

- **WHEN** the limiter fires under benchmark load with metrics enabled
- **THEN** the existing `http_requests_total{status="429"}` Prometheus counter increases by exactly the number of 429 responses
- **AND** the existing `http_request_duration_seconds` histogram observes the 429 latency

### Requirement: Unit Tests for Bypass Logic

The repository SHALL include unit tests covering: (a) the loopback bypass for `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`; (b) the CIDR allow-list bypass for both matching and non-matching IPs; (c) the production safety assertion for `0.0.0.0/0` and `::/0`; and (d) the defensive `req.ip === undefined` path. The unit tests SHALL NOT require Redis (the bypass is a pure function over `req.ip` and the parsed CIDR list).

#### Scenario: Bypass unit test pins the loopback list

- **WHEN** the bypass `skip` function is called with `{ ip: '127.0.0.1' }`, `{ ip: '::1' }`, and `{ ip: '::ffff:127.0.0.1' }`
- **THEN** all three return `true`

#### Scenario: Bypass unit test rejects a non-matching IP

- **WHEN** the bypass `skip` function is called with `{ ip: '203.0.113.5' }` and an empty CIDR list
- **THEN** it returns `false`

#### Scenario: Production safety assertion unit test

- **WHEN** the safety assertion is called with `NODE_ENV='production'` and a parsed CIDR list containing `0.0.0.0/0`
- **THEN** it throws (or otherwise signals startup failure) with a message naming the offending CIDR

### Requirement: Integration Test Proves Limiter and Bypass Work End-to-End

The integration test suite SHALL include a dedicated rate-limit test file that brings up the full Express app via the existing Testcontainers fixture and asserts: (a) hammering `GET /resources` from a non-loopback address eventually returns 429 with the canonical body; (b) hammering the same endpoint from a loopback address never returns 429; (c) the `Retry-After` header is parseable and positive on the 429.

#### Scenario: Integration test forces a 429

- **WHEN** the integration test issues `RATE_LIMIT_MAX + 5` requests against `GET /resources` from a simulated non-loopback peer with a low `RATE_LIMIT_MAX` (e.g. 5)
- **THEN** at least one response has status `429`
- **AND** that response body matches the canonical error envelope shape
- **AND** that response carries a `Retry-After` header with a positive integer value

#### Scenario: Integration test confirms loopback bypass holds

- **WHEN** the integration test issues `2 × RATE_LIMIT_MAX` requests against `GET /resources` from a loopback peer
- **THEN** every response is 200 (or its normal non-429 status)
- **AND** zero responses are 429

### Requirement: Benchmark Re-Run Confirms Bypass and Regression Budget

After the change lands, `mise run bench:smoke` against the dev compose stack and (when s11 is available) `mise run bench:prod:smoke` against the prod compose stack SHALL each report **zero** 429 errors. Additionally, `mise run bench:read` SHALL show no more than a 5% p99 latency regression versus the corresponding row in `Benchmark.md`. If either assertion fails, the change SHALL be rejected.

#### Scenario: Smoke run reports zero 429s

- **WHEN** `mise run bench:smoke` is executed after the change lands
- **THEN** the k6 summary reports `http_req_failed` does not include any responses with status `429`
- **AND** the achieved request count matches the scenario's expected request count

#### Scenario: Read-load run respects the regression budget

- **WHEN** `mise run bench:read` is executed after the change lands and compared to the corresponding row in `Benchmark.md`
- **THEN** the new run's p99 latency is at most `1.05 × Benchmark.md_p99` for the same scenario
- **AND** the change is rejected if this budget is exceeded

### Requirement: Documentation of Rate-Limit Behavior

`README.md` SHALL include a "Rate limiting" subsection (under the API or "Operational" section) that documents: what is limited, the default limit and window, the loopback bypass, the env CIDR allow-list, the production safety assertion, the four env vars, and an explicit note that the dev workflow (`mise run up`) leaves the limiter on with generous defaults.

`.env.example` SHALL list all four env vars with comments explaining each, including a comment on `RATE_LIMIT_ALLOWLIST_CIDRS` warning that wide-open CIDRs are rejected at startup in production.

#### Scenario: README documents the rate limit

- **WHEN** an operator opens `README.md` after this change
- **THEN** there is a "Rate limiting" subsection that names the four env vars, the loopback bypass behavior, and the production safety assertion

#### Scenario: .env.example documents the env vars

- **WHEN** a contributor opens `.env.example` after this change
- **THEN** all four `RATE_LIMIT_*` vars are present
- **AND** the `RATE_LIMIT_ALLOWLIST_CIDRS` line carries an inline comment about the production safety assertion

### Requirement: No Changes to Existing Routes, Modules, or Scenarios

This change SHALL be purely middleware, config, and test additions plus a single `app.set('trust proxy', ...)` line in `buildApp`. No file under `src/modules/` SHALL be modified. No file under `benchmarks/scenarios/` or `benchmarks/lib/` SHALL be modified. No existing migration, no existing controller, no existing service, no existing repository, and no existing route handler SHALL be modified.

#### Scenario: git diff is limited to the documented file set

- **WHEN** a contributor runs `git diff main..HEAD --name-only` after this change is implemented
- **THEN** no file under `src/modules/` appears in the diff
- **AND** no file under `benchmarks/scenarios/` or `benchmarks/lib/` appears in the diff
- **AND** the only files in the diff are: `src/middleware/rate-limit.ts`, `src/middleware/__tests__/rate-limit.test.ts` (or sibling unit test location), `src/http/app.ts`, `src/config/env.ts`, `tests/integration/rate-limit.test.ts`, `.env.example`, `README.md`, `package.json`, `pnpm-lock.yaml`, optional `docker-compose.yml` and `docker-compose.prod.yml` env-only edits, and the change-tracking files under `openspec/`
