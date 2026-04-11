# scoreboard-testing

## Purpose

The runtime verification surface for the scoreboard module — the end-to-end suite operators rerun before each release to confirm the system actually behaves the way the other specs promise. Owns `test/e2e/sse-live-update.test.ts`, `test/load/scoreboard.k6.ts` with NFR-01/02/03 thresholds, `scripts/benchmark-rebuild.ts` for MIN-02 cold-rebuild verification, and `test/integration/messaging/end-to-end.test.ts` covering the outbox → JetStream → local emitter chain. Complements `scoreboard-quality`'s per-test-type machinery (unit/integration harnesses, mocks, fake timers) with capability-level happy-path verification against real infrastructure.

## Requirements

### Requirement: E2E test exercises increment → outbox → JetStream → SSE chain

`test/e2e/sse-live-update.test.ts` SHALL exercise the full happy path against the running docker-compose stack: open SSE connection, send a credit, assert the SSE client receives the `leaderboard.updated` event within 1 second.

#### Scenario: E2E test passes against a clean stack
- **GIVEN** the docker-compose stack is up (`mise run infra:up`) and migrations + nats:init have been run
- **WHEN** `mise run test:e2e` is run
- **THEN** the test:
  1. Opens a SSE connection to `GET /v1/leaderboard/stream` with a fixture JWT
  2. Issues an action token via `POST /v1/actions:issue-token`
  3. Sends a credit via `POST /v1/scores:increment` that changes the top-10
  4. Asserts the SSE client receives an `event: leaderboard.updated` frame within 1000ms
- **AND** the test passes

#### Scenario: E2E test passes 10 consecutive runs (stability check)
- **WHEN** `mise run test:e2e` is run 10 times in a row against the same stack
- **THEN** all 10 runs pass
- **AND** no flake is observed (cumulative pass rate 100%)

### Requirement: k6 load test enforces NFR thresholds

`test/load/scoreboard.k6.ts` SHALL be a k6 script with a `thresholds` section that enforces the NFR-01/02/03 budgets per the DECISION-2 chosen values. The script SHALL ramp VUs from 0 to 10000 over 5 minutes, hold for 30 minutes (or `--duration` override), and execute a mix of writes (1500/sec target) and SSE connections.

#### Scenario: k6 script defines all three thresholds
- **WHEN** the k6 script is read
- **THEN** the `thresholds` block contains:
  - `'http_req_duration{endpoint:scores_increment}': ['p(99)<150']` (or the chosen DECISION-2 value)
  - `'http_req_duration{endpoint:leaderboard_top}': ['p(95)<50']`
  - `'sse_event_latency': ['p(95)<1000']` (custom metric)

#### Scenario: k6 exits non-zero on threshold failure
- **GIVEN** a regression that drops write throughput to 1000/sec (below the 1500 target)
- **WHEN** the k6 test runs
- **THEN** the threshold check fires
- **AND** the k6 process exits non-zero
- **AND** CI sees the failure and blocks the build

#### Scenario: --quick flag runs a 1-minute version
- **WHEN** `k6 run scoreboard.k6.ts --quick` is invoked (or via `mise run test:load -- --quick`)
- **THEN** the script runs for 1 minute instead of 35
- **AND** it's safe to use in CI without burning budget

#### Scenario: MIN-01 closure
- **WHEN** the k6 thresholds are committed
- **THEN** `_bmad-output/planning-artifacts/architecture.md` `openGaps` MIN-01 is marked "resolved"

### Requirement: Cold-rebuild benchmark verifies NFR-09

`scripts/benchmark-rebuild.ts` SHALL seed `user_scores` with N synthetic rows (configurable via `--rows`, default 100000), then run `LeaderboardRebuilder.rebuild()` and log the elapsed time. The benchmark SHALL compare against the 60-second NFR-09 budget and report pass/fail.

#### Scenario: Default 100k row benchmark runs in < 1s
- **WHEN** `pnpm tsx scripts/benchmark-rebuild.ts` is run with the default 100k rows
- **THEN** the script seeds the table, runs the rebuilder, logs `{ usersProcessed: 100000, elapsedMs: <number> }`
- **AND** the elapsed time is well under the 60s budget

#### Scenario: 10M row benchmark verifies NFR-09 on real-scale data
- **WHEN** `pnpm tsx scripts/benchmark-rebuild.ts --rows 10000000` is run
- **THEN** the script seeds 10M rows (~5min), runs the rebuilder, logs the elapsed time
- **AND** the elapsed time is < 60 seconds (NFR-09 budget)

#### Scenario: MIN-02 closure
- **WHEN** the benchmark passes the 60s budget on 10M rows
- **THEN** `_bmad-output/planning-artifacts/architecture.md` `openGaps` MIN-02 is marked "resolved"
- **AND** the elapsed time is recorded in the benchmark script's output for future regression tracking

### Requirement: Epic 2 integration tests cover the messaging chain end-to-end

The integration test suite SHALL include `test/integration/messaging/end-to-end.test.ts` that wires up real Postgres + Redis + NATS via Testcontainers and exercises: outbox INSERT → publisher polls → JetStream publish → ephemeral consumer receives → local emitter fires. The test SHALL assert each link in the chain.

#### Scenario: End-to-end message flow is verified
- **WHEN** `mise run test:integration` runs the messaging end-to-end test
- **THEN** the test inserts a row into `outbox_events`
- **AND** waits up to 500ms for the worker to publish it
- **AND** asserts the local emitter received the corresponding event
- **AND** asserts the row's `published_at` is now set in Postgres

#### Scenario: Adds at least 5 percentage points of coverage to infrastructure layer
- **GIVEN** the coverage report from `mise run test:coverage`
- **WHEN** the new integration tests are added
- **THEN** the infrastructure layer's coverage increases by ≥ 5 percentage points
- **AND** the global coverage gate (≥80%) is still met
