## Why

The brief gives explicit non-functional targets (10k GET RPS, 100 write RPS, 100k concurrent users) and asks for k6 scenarios with results captured in `Benchmark.md`. Without this change, nothing proves the system meets its targets — or, more honestly for a take-home, nothing documents *where* on the way to those targets a single-laptop deployment actually lands. The reviewer should be able to read `Benchmark.md` and know: what we ran, on what hardware, what headroom the system has, where it breaks, and what would need to scale first in production.

This change is also the reality-check for Changes 2 and 3. If the repository was written naively, the read-load scenario will catch it. If the cache is wired wrong, the cache-cold vs cache-warm comparison will show it. Benchmarks are the feedback loop for architecture choices, not a decoration.

The user explicitly accepted "benchmark on MacBook, document the scale-out story" as the posture for this change, so we write scenarios that:

1. Push the laptop hard enough to find its actual ceiling.
2. Are honest about where that ceiling lies.
3. Compare cache-on vs. cache-off so the reviewer can see the cache earning its place.
4. Ship as reusable code, not one-off commands, so the reviewer can re-run any scenario.

## What Changes

- Introduce a `benchmarks/` directory containing k6 test scripts organized by scenario, a shared helper module for common setup (seeding resources, generating random UUIDs, normalizing checks), and a seed script that pre-populates the Postgres database with a controlled number of resources.
- Introduce the following scenarios, each as its own file:
  - `smoke.js` — 1 VU for 30 s, sanity check.
  - `read-load.js` — ramping arrival-rate executor targeting 10k GET RPS against `/resources/:id` with a distribution that hits a known seeded id set (so we can measure cache hit rate).
  - `write-load.js` — 100 writes/s (mix of POST, PATCH, DELETE) using a separate stream of resources.
  - `mixed.js` — 95/5 read/write blend matching the brief's target ratio, the "primary" scenario.
  - `spike.js` — arrival rate jumps from 1k to 10k GET RPS over 5 s.
  - `stress.js` — ramp arrival rate until error rate exceeds 1% or p99 latency exceeds 500 ms, recording where the system breaks.
  - `cache-cold.js` — same as read-load but with Redis flushed before the run.
  - `cache-warm.js` — same as read-load but with a warm-up phase that pre-populates the cache.
- Introduce a k6 `setup()` and `teardown()` pattern per script that seeds the correct resources and cleans up.
- Introduce thresholds in every script so k6 exits non-zero when the scenario fails its SLO (e.g., `http_req_failed < 0.01`, `http_req_duration{expected_response:true} p(99) < 500`).
- Introduce a `docker-compose.bench.yml` overlay (or a compose profile) that runs a k6 container against the local stack, so reviewers do not need k6 installed — though mise has it pinned for those who prefer.
- Introduce a `pnpm bench` script that runs the smoke scenario as a health check for the bench tooling itself.
- Introduce the **`Benchmark.md` template** at the project root, structured for the user to review: goals, hardware, methodology, per-scenario results table, interpretation, scale-out story. The template ships with placeholder rows that get filled in after the runs execute during task work.
- Introduce **one canonical full run** executed during this change's implementation, with the results filled into `Benchmark.md` for user review, matching the user's confirmed "run on my MacBook" posture.

## Capabilities

### New Capabilities

- `performance-benchmarking`: The contract for how the service's performance is measured — which scenarios exist, what SLOs each scenario enforces, and how results are recorded.

### Modified Capabilities

None — benchmarks observe existing behavior, they do not change it.

## Impact

- **New files**: `benchmarks/scenarios/{smoke,read-load,write-load,mixed,spike,stress,cache-cold,cache-warm}.js`, `benchmarks/lib/{http,seed,checks}.js`, `benchmarks/seed/seed.ts` (Node script using the Postgres client to pre-populate data), `docker-compose.bench.yml`, `Benchmark.md` (top-level deliverable).
- **Modified files**: `mise.toml` (confirm `k6` pin matches the scripts), `README.md` (document `pnpm bench:*` scripts and the Benchmark.md review workflow), `package.json` (add `pnpm bench:smoke`, `bench:read`, `bench:write`, `bench:mixed`, `bench:spike`, `bench:stress`, `bench:cache:cold`, `bench:cache:warm`, `bench:seed`).
- **New dependencies**: None at the Node level (k6 is a standalone Go binary managed by mise). Dev-time `tsx` is already present from Change 1 for running the seed script.
- **APIs exposed**: None.
- **Systems affected**: The benchmarks generate meaningful write and read load against the local stack, which touches Postgres and Redis heavily during a run. The seed script creates test data that is NOT migrated in or out — the reviewer is expected to reset their DB (`docker compose down -v`) after a run if they want a clean slate.
- **Breaking changes**: None.
