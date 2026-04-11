## Context

Changes 2 and 3 introduced a Postgres-backed CRUD API wrapped in a Redis cache-aside layer. The brief states performance targets: 10k GET RPS and 100 write RPS. Change 5 is the empirical check: do we actually hit those targets, where does the system break, and what does the cache actually buy us?

Benchmarks on a MacBook are inherently limited. A single-core k6 process running on the same machine as the API, Postgres, and Redis is CPU-competing with everything it is trying to measure. The design is honest about this: the `Benchmark.md` records the hardware, methodology, and actual numbers, and the Interpretation section explains the gap between laptop results and production-class throughput.

The hard design question is not "what to measure" — the brief specifies the scenarios — but "how to structure k6 scripts so they are reusable, comparable, and honest about thresholds."

## Goals / Non-Goals

**Goals:**

- Scripts for all eight scenarios (smoke, read-load, write-load, mixed, spike, stress, cache-cold, cache-warm).
- Shared threshold definitions so the same SLO appears in every scenario without copy-paste.
- A seed script that creates a deterministic, large enough resource pool for cache hit rate to be meaningful.
- A `Benchmark.md` template that a reviewer can read to understand performance characteristics without re-running the suite.
- `pnpm bench:*` scripts so every scenario is one command.

**Non-Goals:**

- Distributed k6 (multiple k6 agents targeting the service). Single-node k6 is sufficient to saturate a single-node API on a laptop.
- CI-integrated benchmark gates. Throughput on CI runners varies too much to gate on. Change 5 is a dev-time evidence artifact, not a CI gate.
- Server-side profiling (flame graphs, heap snapshots). Out of scope; the cache vs. no-cache comparison is the primary signal.
- Database benchmark isolation (separate Postgres for benchmarks vs. dev). On a laptop, they share resources; this is documented.

## Decisions

### Decision 1: Arrival-rate executor for throughput scenarios, not VU-based

k6's `ramping-arrival-rate` executor targets a fixed request rate regardless of VU response time. This is correct for throughput benchmarks: we want to know how many RPS the service can sustain, not how fast VUs can loop. VU-based executors measure "how fast can N goroutines go" which conflates client concurrency with server capacity.

**Alternatives considered:**

- *Constant VUs executor*: Easier to configure but conflates concurrency with throughput. Reported RPS depends on p50 latency rather than being a controlled input.
- *Ramping VUs*: Good for finding maximum concurrency, but makes RPS hard to control precisely.

### Decision 2: Pre-seeded id pool, not random UUID generation

Each read-load VU draws from a pre-seeded list of valid resource ids. Requests for random (likely non-existent) ids would defeat the cache: `X-Cache: MISS` on every call, and the cache becomes irrelevant. With a bounded id pool, repeated hits to the same id produce cache hits and realistic hit rate measurements.

The pool size (default 10,000 resources) is large enough that a 500 VU × 10k RPS scenario does not degenerate into 100% cache hits with zero Postgres activity.

**Alternatives considered:**

- *Random UUID per request*: Ensures all requests miss the cache. Useful for a "no-cache" baseline (which `cache-cold.js` handles explicitly) but wrong for the primary read-load scenario.
- *Sequential ids from a database query*: Requires a round trip before the scenario starts. Pre-seeded CSV is simpler and reproducible.

### Decision 3: Shared threshold module

`benchmarks/lib/thresholds.js` exports `defaultThresholds` (`http_req_failed < 0.01`, `http_req_duration p99 < 500ms`) used by every scenario. Scenario-specific overrides (e.g. spike allows up to 5% error rate) are merged at the scenario level.

This ensures a reviewer comparing two scenarios is comparing apples to apples.

**Alternatives considered:**

- *Inline thresholds per script*: Risks divergence. A copy-paste error means two scripts have different error-rate tolerances that look the same.

### Decision 4: Seed script as a standalone Node/TypeScript script, not a k6 `setup()`

k6 `setup()` functions run inside the k6 runtime (a JavaScript subset that does not support Node APIs). Bulk-inserting 10,000 rows requires a real Postgres client (`pg`), which is not available inside k6. The seed script is a separate `tsx benchmarks/seed/seed.ts` process invoked via `pnpm bench:seed` before each run.

For the `cache-cold` scenario, the script also issues a `FLUSHDB` via ioredis to clear the cache before handing off to k6.

**Alternatives considered:**

- *k6 `setup()` with HTTP POST*: Would create resources via the API. Slow for 10k resources (10k sequential HTTP calls), creates observable load on the service before the actual benchmark, and leaves side effects in the database. Not appropriate.
- *SQL dump / restore*: Fast, but dumps are not portable across schema versions. A script that reads the Zod schema and inserts is self-documenting.

### Decision 5: `Benchmark.md` ships with `TBD` placeholders; implementation task fills them in

The spec artifact (`Benchmark.md`) commits the structure and methodology upfront. During the implementation wave, the implementer runs the scenarios and replaces `TBD` with actual numbers. This makes the planning-vs-implementation boundary explicit and gives the reviewer a template that survives before and after the benchmark run.

**Alternatives considered:**

- *Only ship `Benchmark.md` after running the benchmarks*: Delays the planning artifact. Doesn't let the reviewer understand the measurement plan before results exist.
- *No `Benchmark.md`*: The brief explicitly asks for it.

### Decision 6: Docker Compose `bench` profile for reviewers without mise

Some reviewers may not have k6 installed. A `docker-compose.bench.yml` (or a `profiles: [bench]` override in the main `docker-compose.yml`) provides a k6 service that can run the smoke scenario against the API container. This is a convenience, not the primary benchmark path.

**Alternatives considered:**

- *require mise for all benchmark runs*: Simpler to document, but excludes reviewers who read the `docker compose up` path for everything.

## Risks / Trade-offs

- **[Risk: Laptop hardware limits achievable RPS far below 10k]** → Mitigation: `Benchmark.md` explicitly documents the gap and explains the scale-out story (Redis cluster, multiple API replicas, PgBouncer). The brief accepts "document the constraint" as the posture.
- **[Risk: k6 on the same machine as the API measures co-located competition, not pure API capacity]** → Mitigation: Documented in `Benchmark.md` methodology. The cache-cold vs. cache-warm comparison is still meaningful on the same machine.
- **[Risk: Seed data left in Postgres after benchmark runs pollutes development database]** → Mitigation: README instructs `docker compose down -v` for a clean slate; seed data is clearly scoped to the benchmark workflow.
- **[Risk: Arrival-rate executor requires k6 to provision more VUs than configured max, failing silently]** → Mitigation: Set `maxVUs` to 2× the expected allocation in each scenario; document the VU budget in comments.
- **[Risk: p99 latency threshold (500 ms) is too aggressive for a cold-start laptop run]** → Mitigation: `smoke.js` uses a looser threshold (1 s); `stress.js` is explicitly designed to find where the service breaks. The 500 ms threshold reflects the brief's SLO, not a guarantee.

## Migration Plan

No runtime changes. All additions are benchmark scripts, a seed script, and documentation. Order of operations:

1. Create `benchmarks/` directory structure and helper modules.
2. Write scenario scripts, shared lib, and thresholds.
3. Write seed script.
4. Add `pnpm bench:*` scripts to `package.json`.
5. Create `Benchmark.md` template with `TBD` placeholders.
6. Run benchmarks, fill in results.
7. Update `README.md`.

## Open Questions

- **Should `stress.js` have a threshold at all?** Stress is designed to find the breaking point, so a failed threshold is expected and informative. We set a very loose threshold (p99 < 5s, error rate < 50%) so k6 reports PASS/FAIL without making the stress scenario meaningless.
- **Should we include a write-heavy scenario that stresses the list version counter and cache invalidation hot path?** Deferred. The current scenarios cover the brief's 95/5 read/write ratio. If benchmarks surface the version counter as a hotspot, we revisit with a dedicated scenario.
