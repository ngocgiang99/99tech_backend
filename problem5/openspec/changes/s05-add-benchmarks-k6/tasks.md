## 1. Benchmark Directory and Shared Library

- [ ] 1.1 Create `benchmarks/` directory with subdirectories: `scenarios/`, `lib/`, `seed/`
- [ ] 1.2 Create `benchmarks/lib/thresholds.js` exporting `defaultThresholds` (`http_req_failed: ['rate<0.01']`, `http_req_duration{expected_response:true}: ['p(99)<500']`) and a `mergeThresholds(overrides)` helper
- [ ] 1.3 Create `benchmarks/lib/http.js` with helpers: `getResource(id)`, `listResources(params)`, `createResource(payload)`, `patchResource(id, payload)`, `deleteResource(id)` — each setting the `BASE_URL` env guard and the `Content-Type: application/json` header
- [ ] 1.4 Create `benchmarks/lib/checks.js` with `checkResponse(res, expectedStatus)` that increments k6 check counters and logs failures
- [ ] 1.5 Verify mise has `k6` pinned in `mise.toml`; add the pin if missing (`mise use k6@latest --pin`)

## 2. Seed Script

- [ ] 2.1 Create `benchmarks/seed/seed.ts` that:
  - reads `DATABASE_URL` from env (guard against missing value)
  - accepts `--count` (default 10000) and `--clear` flags via CLI args
  - inserts resources in batches of 500 using Kysely / pg
  - writes a `benchmarks/seed/ids.json` containing the list of inserted UUIDs (for use by k6 scenarios)
  - is idempotent when `--clear` is not passed (skip existing rows by checking count)
- [ ] 2.2 Add `pnpm bench:seed` script to `package.json` running `tsx benchmarks/seed/seed.ts`
- [ ] 2.3 Create `benchmarks/seed/flush-cache.ts` that connects to `REDIS_URL` and calls `FLUSHDB` — used by the `cache-cold` scenario setup
- [ ] 2.4 Verify `pnpm bench:seed` runs against the compose Postgres and produces `ids.json`

## 3. k6 Scenario Scripts

- [ ] 3.1 Create `benchmarks/scenarios/smoke.js` — 1 VU, 30 s, checks `GET /healthz` and one `GET /resources/:id`, thresholds from `defaultThresholds` with p99 loosened to 1000 ms
- [ ] 3.2 Create `benchmarks/scenarios/read-load.js` — `ramping-arrival-rate` executor, ramp from 0 to 10k RPS over 1 min, hold 3 min, ramp down; VUs draw from `ids.json` via `SharedArray`; records `X-Cache` header counts as a custom metric; uses `defaultThresholds`
- [ ] 3.3 Create `benchmarks/scenarios/write-load.js` — `constant-arrival-rate` at 100 RPS; VUs alternate POST (60%) / PATCH (30%) / DELETE (10%); DELETE targets a resource created earlier in the same VU iteration; uses `defaultThresholds`
- [ ] 3.4 Create `benchmarks/scenarios/mixed.js` — `ramping-arrival-rate`; 95% of iterations call `getResource`, 5% call `createResource` or `patchResource`; uses `defaultThresholds`
- [ ] 3.5 Create `benchmarks/scenarios/spike.js` — arrival rate ramps from 1k to 10k RPS over 10 s, holds 30 s, ramps back to 1k; error rate threshold loosened to 5% during the spike hold phase
- [ ] 3.6 Create `benchmarks/scenarios/stress.js` — arrival rate ramps up by 1k RPS every 60 s until the service is saturated; thresholds intentionally loose (p99 < 5s, error rate < 50%) so the run completes and records the saturation point
- [ ] 3.7 Create `benchmarks/scenarios/cache-cold.js` — same executor config as `read-load.js` but adds a `setup()` that calls `pnpm bench:flush-cache` (via `exec`) to empty Redis before the run; documents cache-off baseline
- [ ] 3.8 Create `benchmarks/scenarios/cache-warm.js` — same as `read-load.js` but the `setup()` phase issues one `GET /resources/:id` for every id in `ids.json` to pre-populate the cache before the measurement phase

## 4. pnpm Scripts and Docker Compose Profile

- [ ] 4.1 Add to `package.json`: `bench:smoke`, `bench:read`, `bench:write`, `bench:mixed`, `bench:spike`, `bench:stress`, `bench:cache:cold`, `bench:cache:warm`, `bench:flush-cache` (tsx benchmarks/seed/flush-cache.ts)
- [ ] 4.2 Add a `bench` profile to `docker-compose.yml` (or a `docker-compose.bench.yml` override) with a `k6` service that runs `k6/scenarios/smoke.js` against the API via the compose network, for reviewers who prefer not to install k6 locally
- [ ] 4.3 Verify `pnpm bench:smoke` succeeds against a running `docker compose up` stack

## 5. Benchmark.md Template

- [ ] 5.1 Create `Benchmark.md` at the project root with the following sections:
  - **Hardware**: CPU, RAM, OS — `TBD` placeholders for the implementer to fill in
  - **Methodology**: how the stack is started, how data is seeded, how the cache is prepared per scenario, k6 version
  - **Results** table: one row per scenario, columns for VU/RPS target, achieved RPS, p50 / p95 / p99 latency, error rate, cache hit rate; all values `TBD`
  - **Interpretation**: notes on co-location penalty (k6 on same machine), where the bottleneck lands (event loop, Postgres connections, Redis bandwidth), the scale-out story for production
- [ ] 5.2 Run the benchmark suite and fill in the `TBD` placeholders with actual results from the developer's machine

## 6. Documentation

- [ ] 6.1 Update `README.md` with a "Benchmarks" section covering: prereqs (mise k6, Docker running, stack up), `pnpm bench:seed`, each `pnpm bench:*` command, and how to reset the database after a run
- [ ] 6.2 Document the Docker Compose profile alternative in README for reviewers without mise

## 7. Validation

- [ ] 7.1 Run `pnpm bench:smoke` and confirm k6 exits 0
- [ ] 7.2 Run `pnpm bench:read` and confirm k6 produces a summary with the achieved RPS and threshold results
- [ ] 7.3 Compare `cache-cold` vs `cache-warm` RPS in the summary output and confirm the cache-warm scenario shows a measurable improvement; document the delta in `Benchmark.md`
- [ ] 7.4 Run `openspec validate s05-add-benchmarks-k6` and confirm zero errors
