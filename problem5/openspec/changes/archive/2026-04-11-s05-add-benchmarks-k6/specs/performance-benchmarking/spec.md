## ADDED Requirements

### Requirement: Benchmark Scenarios

The project SHALL provide k6 benchmark scripts that cover the following eight scenarios. Each script SHALL define thresholds that cause k6 to exit non-zero when the scenario's SLO is violated.

#### Scenario: Smoke — service alive under minimal load

- **WHEN** a developer runs `pnpm bench:smoke`
- **THEN** k6 runs with 1 VU for 30 s against the API
- **AND** the error rate is 0%
- **AND** p99 latency is under 500 ms
- **AND** the script exits with code `0` if all checks pass

#### Scenario: Read-load — GET throughput target

- **WHEN** a developer runs `pnpm bench:read`
- **THEN** k6 uses a ramping-arrival-rate executor targeting 10,000 GET RPS at peak against `GET /resources/:id` with a seeded id pool
- **AND** the threshold is `http_req_failed < 0.01` (error rate < 1%)
- **AND** the threshold is `http_req_duration{expected_response:true} p(99) < 500 ms`
- **AND** `Benchmark.md` records the actual achieved RPS on laptop hardware alongside the target

#### Scenario: Write-load — write throughput target

- **WHEN** a developer runs `pnpm bench:write`
- **THEN** k6 uses a constant-arrival-rate executor targeting 100 write RPS (mix of POST, PATCH, DELETE)
- **AND** the threshold is `http_req_failed < 0.01`
- **AND** the threshold is `http_req_duration{expected_response:true} p(99) < 500 ms`

#### Scenario: Mixed — 95% reads, 5% writes

- **WHEN** a developer runs `pnpm bench:mixed`
- **THEN** k6 issues ~95% GET requests and ~5% write requests
- **AND** the same error-rate and latency thresholds apply
- **AND** `Benchmark.md` reports the overall RPS, breakdown by method, and `X-Cache` hit rate

#### Scenario: Spike — sudden traffic surge

- **WHEN** a developer runs `pnpm bench:spike`
- **THEN** k6 ramps arrival rate from 1k to 10k GET RPS over 10 s, holds for 30 s, then ramps down
- **AND** the error rate during the hold phase is less than 5%

#### Scenario: Stress — find the breaking point

- **WHEN** a developer runs `pnpm bench:stress`
- **THEN** k6 ramps arrival rate until either the error rate exceeds 1% or p99 latency exceeds 500 ms
- **AND** `Benchmark.md` records the RPS at which the service first breaches each threshold

#### Scenario: Cache cold — Postgres-only baseline

- **WHEN** a developer runs `pnpm bench:cache:cold`
- **THEN** the benchmark starts with Redis flushed (empty cache) and `CACHE_ENABLED=false` set in the API
- **AND** k6 runs the same read-load scenario
- **AND** `Benchmark.md` records this as the Postgres-only baseline for comparison with the cache-warm result

#### Scenario: Cache warm — pre-warmed Redis

- **WHEN** a developer runs `pnpm bench:cache:warm`
- **THEN** a setup phase pre-warms the Redis cache by issuing one GET for each resource in the seed pool
- **AND** k6 then runs the read-load scenario
- **AND** `Benchmark.md` records the warm-cache RPS alongside the cold-cache baseline

### Requirement: Benchmark Data Seeding

Before any throughput scenario, the database SHALL contain a deterministic, seeded resource set sufficient to populate the cache and exercise the keyset cursor across multiple pages.

#### Scenario: Seed script creates required resources

- **WHEN** a developer runs `pnpm bench:seed`
- **THEN** the script connects to `DATABASE_URL` and inserts the configured number of resources (default 10,000) using bulk inserts
- **AND** the seed is idempotent: running it twice does not fail and does not duplicate records
- **AND** the operation completes in under 30 s on laptop hardware

#### Scenario: Seeded ids are used by read-load scripts

- **WHEN** a read-load scenario runs
- **THEN** the k6 VUs draw from a pre-loaded list of valid resource ids
- **AND** cache hit rates reflect realistic repeated access to the same id set

### Requirement: Threshold Enforcement

Every k6 scenario SHALL define at least the following thresholds and SHALL cause the process to exit with a non-zero code if any threshold is violated.

#### Scenario: Error rate threshold

- **WHEN** a benchmark scenario runs
- **THEN** the script defines `http_req_failed: ['rate<0.01']`
- **AND** k6 prints a FAILED marker if the error rate exceeds 1%

#### Scenario: Latency threshold

- **WHEN** a benchmark scenario runs
- **THEN** the script defines `http_req_duration{expected_response:true}: ['p(99)<500']`
- **AND** k6 prints a FAILED marker if p99 latency exceeds 500 ms

### Requirement: Benchmark.md Results Template

The project SHALL include a `Benchmark.md` at the project root that records the methodology, hardware, and results for each scenario. The template SHALL be structured so a reviewer can understand the results without running the benchmarks themselves.

#### Scenario: Template contains required sections

- **WHEN** `Benchmark.md` is read
- **THEN** it contains: Hardware section (CPU, RAM, OS), Methodology section (warm-up, how seed was run, how cache was prepared), a per-scenario results table with columns for VUs/RPS target, achieved RPS, p50/p95/p99 latency, error rate, and cache hit rate where applicable, and an Interpretation section discussing the gap between laptop results and production targets

#### Scenario: Placeholder rows are present before runs

- **WHEN** `Benchmark.md` is first committed
- **THEN** the per-scenario result rows contain `TBD` placeholders
- **AND** the Implementation task for running the benchmarks fills in real numbers

### Requirement: k6 Available via mise

The project SHALL pin k6 to a specific version in `mise.toml` so any developer can run `mise install` and immediately have the correct k6 binary.

#### Scenario: k6 version is pinned

- **WHEN** a developer runs `mise install` in the project directory
- **THEN** k6 is installed at the pinned version
- **AND** `k6 version` outputs the expected version string

#### Scenario: Docker Compose profile for k6

- **WHEN** a developer runs k6 via `docker compose --profile bench up k6`
- **THEN** k6 runs the smoke scenario against the `api` service via the compose network
- **AND** no local k6 installation is required
