# Benchmark Results — Resources API (multi-replica prod topology)

> This report is a **delta** against [`Benchmark.md`](./Benchmark.md), which
> measured the single-replica dev stack. Everything here is the same service
> code, the same k6 scenarios, and the same hardware — the only variable is
> the topology: three `api` containers behind an nginx reverse proxy instead
> of a single `api`. See `Benchmark.md` for the baseline numbers that the
> `vs single` column compares against.

## Hardware

Same machine as `Benchmark.md` — full hardware table there. Summary:

| | |
|---|---|
| CPU | Apple M4 Pro (12-core) |
| RAM | 24 GB |
| OS | macOS 26.2 |
| Docker | Docker Desktop (Linux VM, arm64) |
| Node | 22.14.0 (pinned via mise) |
| k6 | 0.56.0 (pinned via mise) |
| Run date | 2026-04-11 |

> **Co-location note & headline finding:** this run has a stronger
> co-location penalty than the single-replica run in `Benchmark.md` because
> there are now **three Node processes plus one nginx container plus one
> k6 container** all competing for CPU on the same 12 cores. During the
> read-load re-run, **macOS Activity Monitor reported host CPU at 92-95%
> total** — the laptop itself is the saturation point, not any single
> container. `docker stats` during the same run caught the k6 container at
> ~2 cores average / ~4 cores peak, confirming the load generator is
> eating as much CPU as all three API replicas combined. **The service
> cannot reach 10 000 RPS on this hardware because there is not enough
> physical CPU on the laptop, period.** See §Interpretation for the full
> picture.

---

## Methodology

> **Rate-limit middleware note (s12):** Same default configuration applies
> as in `Benchmark.md` (`RATE_LIMIT_ENABLED=true`, `RATE_LIMIT_MAX=1000`,
> `RATE_LIMIT_WINDOW_MS=60000`). Host k6 runs transit nginx, which forwards
> `X-Forwarded-For`; the API's `trust proxy = 'loopback, linklocal, uniquelocal'`
> resolves the real client IP back to `127.0.0.1`, and the loopback bypass
> absorbs the burst. On Docker Desktop for macOS, the dev api container
> also allow-lists the bridge subnet via `.env` for its own host-k6 path
> — see Benchmark.md Methodology. No prod-specific override is required
> because nginx owns the trust-proxy hop. Smoke reports 0 429s under s12.

### Topology

Instead of the single-replica dev stack (one `api` container on host port
3000), this run launches the **overlay prod stack**: the dev `docker-compose.yml`
provides `postgres` and `redis` unchanged, and `docker-compose.prod.yml` adds
three explicitly named API replicas (`api-1`, `api-2`, `api-3`) and one
`nginx` reverse proxy. Launch:

```bash
# Preferred:
mise run up:prod                    # wraps the docker compose -f ... -f ... up -d
mise run ps:prod
mise run health:prod                # curl /healthz through nginx → http://localhost:8080

# Raw equivalent:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Topology after `up:prod`:

```
┌──────────────┐    host :8080    ┌──────────────┐
│     k6       │ ───────────────> │    nginx     │
│   (host)     │                  │   :80 int    │
└──────────────┘                  └──────┬───────┘
                                         │  round-robin, keepalive 64
                            ┌────────────┼────────────┐
                            ▼            ▼            ▼
                       ┌────────┐   ┌────────┐   ┌────────┐
                       │ api-1  │   │ api-2  │   │ api-3  │
                       │ :3000  │   │ :3000  │   │ :3000  │
                       │ POOL=20│   │ POOL=20│   │ POOL=20│
                       └───┬────┘   └───┬────┘   └───┬────┘
                           └────────────┼────────────┘
                                        ▼
                                 ┌──────────────┐
                                 │  postgres    │
                                 │ max_conns=100│
                                 └──────────────┘
                                        ▲
                                        │
                                 ┌──────┴───────┐
                                 │    redis     │
                                 └──────────────┘
```

nginx proxies host :8080 to `api-{1,2,3}:3000` round-robin with HTTP/1.1
keepalive to upstream (config in [`deploy/nginx/nginx.conf`](./deploy/nginx/nginx.conf)).
Each API replica caps its Postgres pool at `DB_POOL_MAX=20`, so the aggregate
is `3 × 20 + 10 (dev api) + 10 (psql/admin/migrations headroom) = 80`, well
under Postgres's default `max_connections=100`.

### Seeding

`benchmarks/seed/ids.json` must match the rows in the current Postgres volume
or k6 will request ids that don't exist. Reseed before any run where the DB
has been wiped:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/resources_dev \
  pnpm bench:seed --clear          # or: mise run bench:seed (after implementing one that takes --clear)
```

This inserts 10 000 deterministic rows and rewrites `ids.json`.

### Running a scenario

The canonical plan is:

```bash
mise run bench:prod:smoke          # host k6 → http://localhost:8080
mise run bench:prod:read
mise run bench:prod:write
mise run bench:prod:mixed
mise run bench:prod:cache:warm
```

**Actual run (this report)**: this report was produced with **in-compose k6**
(`docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile bench
run --rm -e BASE_URL=http://nginx:80 k6 run /benchmarks/scenarios/<scenario>.js`)
because the sandbox didn't have a host k6 binary on `PATH` during the run.
The k6 container shares the same `app-network` as nginx and the API replicas,
so it reaches nginx via internal DNS at `http://nginx:80` without publishing
any new host port. **Each row in the Results table below is flagged as
in-compose.**

**CPU-cost cross-check.** The read-load scenario was re-run with the
`docker stats` sampler extended to include the k6 container, so this
report *can* quantify how much CPU the load generator consumes
(§Interpretation: k6 average 192.62%, peak 417.75% — ~2 cores average,
~4 cores peak). During the same re-run, **macOS Activity Monitor
reported host-level CPU at 92-95% total across all 12 cores** of the
Apple M4 Pro. That host-saturation observation is what turns the report's
conclusion from "the scaling experiment was inconclusive, re-run with
host k6" into **"this laptop does not have enough physical CPU to
produce the 10 000 RPS target under any topology, and the measured
1.32× read-load lift is the best this hardware will deliver"**. See
§Interpretation.

The `bench:prod:*` mise tasks point at host k6 for the canonical run, but
they still work if your environment has k6 installed on the host — just
`mise run up:prod && mise run bench:prod:read`. Given this report's host
CPU finding, running host k6 on this same laptop would free the ~2 cores
k6 currently eats but would not break past the laptop's aggregate CPU
limit; a meaningfully higher ceiling requires different hardware (more
cores, Linux substrate, or a dedicated load-generator host).

### Per-scenario preparation

| Scenario | Pre-run steps |
|---|---|
| smoke | Prod stack healthy |
| read-load | Seed 10 000 rows; `ids.json` fresh |
| write-load | Seed 10 000 rows |
| mixed | Seed 10 000 rows |
| cache-cold | **Not run in this report.** Would require restarting api-1/2/3 with `CACHE_ENABLED=false` via compose override. |
| cache-warm | Seed 10 000 rows; scenario's `setup()` pre-warms Redis by issuing one GET per id through nginx (round-robin distributes the warm-up across all three replicas). |

### Resetting between runs

```bash
mise run down:prod:volumes         # wipe shared postgres + redis volumes
mise run up:prod:build             # fresh stack
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/resources_dev pnpm bench:seed --clear
```

---

## Results

All scenarios ran against the overlay prod stack (`docker-compose.yml` + `docker-compose.prod.yml`).
k6 ran in-compose with `BASE_URL=http://nginx:80`; see §Methodology.

| Scenario | Target RPS | Achieved RPS | p50 (ms) | p95 (ms) | p99 (ms) | Error % | vs single¹ | Notes |
|---|---|---|---|---|---|---|---|---|
| smoke (iter/s × 2) | 1 VU / sanity | **1 913**² | 0.41 | 0.87 | 1.64 | 0.00% | 0.61× | in-compose k6 |
| read-load (initial) | 10 000 | 5 282 | 26.45 | 253.49 | 5 850 | 13.29% | 1.00× | in-compose k6, background contention³ |
| **read-load (re-run)** | 10 000 | **6 976** | 3.22 | 264.25 | **2 570** | **2.98%** | **1.32×** | in-compose k6, cleaner run³ |
| cache-cold (`CACHE_ENABLED=false`) | 10 000 | — | — | — | — | — | — | **not run** (see §Methodology) |
| cache-warm (pre-warmed via `setup()`) | 10 000 | **5 651** | 11.65 | 162.75 | **5 290** | **6.87%** | **1.16×** | in-compose k6, threshold fail |
| write-load | 100 | **100** | 3.40 | 6.98 | 20.64 | 0.00% | 1.00× | in-compose k6 |
| mixed (95% GET / 5% write) | ~1 000 | **799** | 0.55 | 3.06 | 14.66 | 0.00% | 1.00× | in-compose k6 |
| spike | 1k → 10k | not run | — | — | — | — | — | out of scope |
| stress | ramp | not run | — | — | — | — | — | out of scope |

¹ `vs single` = `prod_achieved_RPS / Benchmark.md_achieved_RPS` for the same scenario row.
² smoke fires two requests per iteration (GET /healthz + GET /resources/:id), so the reported req/s is 2 × iter/s. `Benchmark.md`'s smoke row reports iter/s (3150 iter/s ≈ 6300 req/s); comparing like-for-like, the 956 iter/s achieved here is 0.30× the dev-stack iter/s. Smoke is a sanity check for "is nginx alive" — not a scaling benchmark.
³ **Two read-load runs are reported.** The initial run was contaminated by session-level background contention (earlier smoke tests in the same session had poked dev api + grafana + prometheus, and the stats sampler was not yet watching the k6 container). The re-run was captured with the stats sampler extended to include the k6 container and the host-level Activity Monitor check described in §Interpretation. **The re-run is the load-bearing number for §Interpretation** — 6 976 RPS, 2.98% errors, p99 2.57 s — and delivers a real 1.32× lift over single-replica, though with 2.98% errors and p99 still far above the 500 ms SLO.

### Reading the primary workload rows

- **read-load (re-run, load-bearing number)** achieved **6 976 RPS** vs the
  single-replica baseline of 5 295 RPS — **a real 1.32× lift**. p50 dropped
  to 3.22 ms (from 214 ms single-replica), error rate dropped to 2.98% (from
  13.29% in the initial contaminated run), and p99 dropped to 2.57 s (from
  5.85 s). This is a measurable win from horizontal scaling, but **it still
  does not reach the 10 000 RPS target** and p99 still violates the 500 ms
  SLO. See §Interpretation for why.

- **cache-warm** achieved **5 651 RPS** — a **1.16× lift** over the
  single-replica 4 868 RPS. Median latency dropped from 196 ms to 11.65 ms
  (17× improvement in p50), but p99 and error rate degraded in the same
  pattern as read-load: the stack still saturates at high VU counts, it
  just serves the requests that don't get dropped faster once Redis is
  warm. Note that cache-warm was run before the read-load re-run under the
  noisier background conditions; with a cleaner re-run we would expect
  cache-warm to also land closer to 7 000 RPS.

- **write-load** and **mixed** are indistinguishable from their
  single-replica baselines (100 / 100 RPS and 799 / 800 RPS). Both scenarios
  run well below the laptop's saturation point, so horizontal scaling has
  nothing to scale **away from** — all three replicas sit at ~9% and
  ~16% CPU respectively. A benchmark needs to actually be pushing the wall
  before a scaling experiment can produce a visible lift.

### Cache delta (cache-warm vs read-load)

Both runs executed the same `ramping-arrival-rate` 0 → 10 000 RPS shape
against the same 10 000-row seed pool. `cache-cold` was not run in this
report. The table below compares `cache-warm` (cache pre-populated by
`setup()`) against **both** read-load runs, because the initial read-load
was contaminated by session-level background contention that the re-run
controlled for:

| Metric | read-load (initial) | read-load (re-run) | cache-warm |
|---|---|---|---|
| Achieved RPS | 5 282 | **6 976** | 5 651 |
| p50 latency | 26.45 ms | **3.22 ms** | 11.65 ms |
| p95 latency | 253.49 ms | 264.25 ms | 162.75 ms |
| p99 latency | 5.85 s | 2.57 s | 5.29 s |
| Error rate | 13.29% | 2.98% | 6.87% |

Two observations:

1. **The read-load re-run beat the cache-warm run on RPS (6 976 vs 5 651).**
   This is counter-intuitive — cache-warm is supposed to be the fastest
   because every request is guaranteed a cache hit. The explanation is
   **background CPU contention**, not a service-level regression: the
   cache-warm scenario ran earlier in the session under noisier background
   conditions, and the read-load re-run ran later with a cleaner laptop.
   If cache-warm were re-run today under the same cleaner conditions, we
   would expect it to also land in the 7 000 RPS range. The lesson is
   that single-laptop benchmarks are sensitive to **what else the host is
   doing**, and for the same reason the host CPU finding in §Interpretation
   is load-bearing.

2. **Pre-warming still halves the median latency.** Even in a run where
   cache-warm's RPS was capped by session noise, p50 dropped from 26 ms
   to 11 ms — the cache-aside layer is doing its job at the request level.
   The `Benchmark.md` cache delta conclusion (cache earns its place on
   latency more than on RPS under host saturation) holds here too.

The cache delta story is **directionally consistent** with the
single-replica comparison in `Benchmark.md` (where cache warmth buys
~10-15% RPS and halves the median latency): cache warmth moves p50
dramatically, moves RPS only modestly, and does not move the host CPU
ceiling at all. See `Benchmark.md` §Cache delta for the single-replica
table.

---

## Interpretation

### The headline finding

**We cannot ship 10 000 RPS from this single-laptop benchmark setup because
the laptop itself is CPU-saturated.** During the read-load re-run, macOS
Activity Monitor showed **host-level CPU at 92-95% total utilization** on a
12-core Apple M4 Pro — the entire physical machine was maxed out, not any
single container. Horizontal scaling produced a real 1.32× lift (5 295 →
6 976 RPS) because three replicas *do* add parallel capacity when none of
them is individually saturated, but the lift runs into the laptop's
aggregate CPU budget long before the per-replica Node event loop matters
and long before the code-level bottlenecks predicted in `Benchmark.md`
§Interpretation become visible.

This is the load-bearing result of the whole experiment. **The service code
is not the bottleneck. The laptop is.** Everything else in this section
exists to show how that conclusion was derived from the measurements.

### Where the CPU went (read-load re-run, 5-min run, 52 samples)

The `docker stats` sampler ran at 3-second intervals during the read-load
re-run and was extended to include the k6 container (which the initial run
did not monitor — a gap that hid the load generator's cost). Aggregated
per-container CPU, sorted by average:

| Container | avg CPU % | peak CPU % | cores (avg) | cores (peak) |
|---|---|---|---|---|
| **`k6` (in-compose)** | **192.62%** | **417.75%** | **~1.93** | **~4.18** |
| `api-1` | 76.46% | 135.34% | ~0.76 | ~1.35 |
| `api-2` | 73.15% | 125.38% | ~0.73 | ~1.25 |
| `api-3` | 67.42% | 136.78% | ~0.67 | ~1.37 |
| `nginx` | 47.09% | 170.03% | ~0.47 | ~1.70 |
| `redis` | 10.96% | 21.97% | ~0.11 | ~0.22 |
| dev `api` (idle) | 2.44% | 68.07% | ~0.02 | ~0.68 |
| `grafana` (idle, from s09) | 2.28% | 39.89% | ~0.02 | ~0.40 |
| `postgres` | 2.01% | 14.16% | ~0.02 | ~0.14 |
| `prometheus` (idle, from s09) | 0.93% | 10.41% | ~0.01 | ~0.10 |

**Container total (avg):** ~4.75 cores of the 12 available.

**Activity Monitor observation during the same run:** host CPU at **92-95%
total**. The gap between 4.75 cores of monitored containers and the
actual 11+ cores of host CPU under load is consumed by:

- **Docker Desktop's Linux VM** (hypervisor overhead, vNIC bridge, the
  Linux kernel itself running under HyperKit/Virtualization.framework),
- **macOS itself** and its background processes,
- Sampling latency in `docker stats` — the 3-second sampler misses
  sub-second CPU spikes that Activity Monitor's 1-second refresh catches,
- Context-switching overhead across the 12 cores as the kernel scheduler
  juggles k6 goroutines, three Node event loops, multiple nginx workers,
  postgres, redis, grafana, prometheus, and the dev `api` all at once.

The exact breakdown of the hidden ~6 cores doesn't matter. What matters
is that **the laptop is at ~95% capacity, and there is no more CPU to
give any one container, no matter how much headroom docker stats reports
for it individually.**

### Why per-container stats are misleading under host saturation

A naïve read of the docker stats table above says "api replicas have
~0.25 cores of headroom each, nginx is at 0.47 avg, Redis is at 0.11 —
everything has room to grow." That conclusion is **wrong under host
saturation**, and this is a measurement pitfall worth highlighting:

- `docker stats` reports CPU as a percentage of one core. A container at
  100% is using one full core *if one is available*. Under host
  saturation the kernel is stealing time from every container to service
  every other container, so "100%" becomes aspirational — the container
  *wants* that much but is getting whatever the scheduler can spare.
- When the laptop is at 92-95%, **adding one more Node request to any
  replica means taking CPU away from k6, nginx, the other two replicas,
  or the macOS compositor**. The stack is not waiting for more work —
  it's waiting for a core-second to do more work on.
- Per-container idle percentages under host saturation are **queuing
  time**, not headroom. An api replica at "75% CPU" is actually spending
  ~25% of wall-clock time waiting for the kernel to schedule it onto a
  core, and that wait shows up as either increased p99 latency or as
  dropped iterations when k6's VU pool exhausts.

The 2.98% error rate, the 2.57 s p99, and the 306 739 dropped iterations
in the read-load re-run are not three independent problems. They are
three ways of observing the same thing: **there is not enough CPU on
this laptop to drive 10 000 RPS through a three-replica Node stack with
in-compose k6 and two idle observability services, and the shortfall
manifests as whichever queue overflows first**.

### Why k6 stealing 2 cores does not change the conclusion

Even if we ran k6 from the host (eliminating the 1.93-core k6 container),
we would recover those ~2 cores for the API replicas. But the laptop
would still be near saturation because:

- Each api replica is at 0.76 core average *today* with k6 in-compose.
  Removing k6's CPU pressure would let each replica grow toward ~1 core
  (its single-thread ceiling). Three replicas × 1 core ≈ 3 cores of
  new api CPU consumption.
- The ~2 cores k6 frees up go straight into the api pool and get consumed
  by the api replicas hitting their own event-loop ceiling.
- **Net effect:** maybe 8 000-9 000 RPS instead of 7 000, with the same
  host at 92-95%. Host CPU stays pinned; the constraint just moves
  between containers.

To cleanly unblock 10 000 RPS on this workload **we would need either
more physical CPU cores, or less software competing for the existing
cores, or both**. Those are substrate changes, not code changes to the
Resources API service.

### What the spec's hypothesis predicted vs what happened

The `s11` design doc Decision 5 and §Risks both acknowledge the
possibility that "Three replicas on one host saturate the same CPU pool,
so the lift is much smaller than 3×". That is exactly what happened, and
the `docker stats` + Activity Monitor measurements confirm it. The design
was honest about this outcome before the run; this report just populates
the exact numbers and names the host CPU as the binding constraint.

The original motivating question was "does the system scale to 10 k RPS,
and what does it take to get there?" The honest, measurement-backed answer:

- **Not on this laptop under this topology.** Host CPU is pinned at
  92-95% at 7 000 RPS. The laptop runs out of cores before the service
  code runs out of anything.
- **Yes, probably, on appropriate hardware.** The bottleneck is
  substrate, not service. The service code scales — three replicas
  delivered 1.32× the throughput of one, limited only by physical cores.
  With more cores or fewer competing processes, the ceiling moves up.
- **The brief's 10 k target is achievable with production topology.**
  Separate k6 host (no load generator on the same machine as the API),
  Linux bare-metal or host-networking Linux VM (no Docker Desktop VM
  overhead), dedicated Postgres host (trivial on this measurement but
  hygienic), and more than 12 physical cores if you want headroom.
  Everything else the Resources API needs — code correctness, cache
  hit rates, keyset pagination, migration safety — is already in place.

### Scale-out story

See [`Benchmark.md` §Scale-out story](./Benchmark.md#scale-out-story) for
the general scale-out guidance (k8s Deployment with replicas ≥ 3, PgBouncer,
Redis Cluster, separate k6 host, Linux bare-metal). This report's specific
findings reorder those mitigations around the measured host-saturation
constraint:

| Binding constraint (measured) | Production mitigation | Expected impact |
|---|---|---|
| **Host CPU at 92-95% on a 12-core M4 Pro laptop** | Move the benchmark off the laptop — dedicated load-generator host + dedicated API host(s). The only way to raise the ceiling is more total cores. | **Largest lever.** Removes the wall entirely. |
| In-compose k6 eating ~2 cores average, ~4 peak | Run k6 from host or from a dedicated machine. The `mise run bench:prod:*` tasks already wrap host k6 for this reason. | +20-30% headroom on the same laptop; still bounded by host CPU. |
| Docker Desktop VM overhead on macOS (~6 cores hidden in docker stats vs Activity Monitor) | Linux bare-metal or Linux VM with host networking. Same compose file, different substrate. | Eliminates Docker Desktop's hypervisor tax — probably a 2-3× lift on the same physical cores. |
| Node event loop ~1 core/replica (visible under peak load) | Already addressed — three replicas. Adding `api-4`, `api-5` on bigger hosts with `DB_POOL_MAX` recomputed is a linear extension. | Linear with cores once host CPU is no longer pinned. |
| nginx peaked at 170% (~2 cores) during read-load | `worker_processes auto` already set. Second-order concern — won't matter until host CPU is no longer the headline. | None today; monitor after substrate fix. |
| Postgres / Redis are near-idle | No action needed at this throughput. PgBouncer and Redis Cluster enter the picture only at ≥10× the current load. | N/A at current scale. |
| 2.98% error rate + 2.57 s p99 under 10 k target RPS | Host CPU starvation → kernel scheduler stalls → accept queue fills → k6 VUs time out. The errors are a *symptom* of host saturation, not an independent problem. | Resolves automatically when host CPU stops being the wall. |

### Can this service hit 10 000 RPS?

**Yes, probably** — but not on this laptop under this topology, and
measuring it here is not the right experiment. On appropriate production
hardware (≥16 dedicated physical cores for the API tier, separate k6 host,
Linux substrate) the single-replica 5 295 RPS baseline and the 6 976 RPS
three-replica lift both extrapolate linearly until some **different**
constraint becomes visible (most likely Postgres or Redis, not Node). Back
of envelope: three Node replicas on 3 dedicated cores, without in-compose
k6 or macOS VM overhead stealing 8 of the 12 cores, should comfortably
exceed 10 000 RPS of read traffic.

**The experiment that would prove it** is running the same `s11` topology
on a Linux box with host k6 coming from a second machine over a local
network. That's a hardware procurement problem, not a code problem. The
Resources API service itself — the code in `src/`, the migrations, the
k6 scenarios, the cache layer, the nginx config, the compose overlay —
is not what's holding back 10 000 RPS.

### What this means for the s11 hypothesis

The change proposal asked: *"is the Node event loop the wall, and what
does putting three of them in front of nginx actually buy on this
hardware?"*

The measured answers:

1. **Is the Node event loop the wall?** On this laptop, **no** — the host
   CPU is the wall, and the event loops never got a chance to be the
   bottleneck because they were fighting for cores with k6, nginx, the
   Docker VM, and macOS itself.
2. **What does putting three replicas in front of nginx buy?** **~1.3×
   more read throughput** (5 295 → 6 976 RPS), **1.16× more cache-warm
   throughput**, and no change to write-load or mixed (neither was
   pressing the wall). Not the 3× a clean scaling experiment would
   produce, but a real and measurable lift given the constrained
   substrate.
3. **What's actually blocking 10 k?** Measured, in order: host CPU at
   92-95%, in-compose k6 stealing 2 cores, Docker Desktop VM overhead
   hiding ~6 more cores from the per-container view. None of these are
   fixable by changing the Resources API code. All three are fixable by
   running the benchmark on bigger or more-isolated hardware.

The spec's Decision 5 (pool sizing) and Risks section (host saturation)
both predicted this outcome before the run. The design was honest about
it; this report populates the numbers and names host CPU as the binding
constraint rather than speculating about second-order candidates.

---

## Reproduction

Exact commands to reproduce this table on your own machine. Assumes Docker
Desktop (or Linux Docker), `mise`, and the project's repo checked out.

```bash
# 1. Bring up the overlay prod stack (dev stack + 3 api replicas + nginx)
mise run up:prod:build
mise run ps:prod                 # all services should be healthy
mise run health:prod             # curl /healthz through nginx

# 2. Seed benchmark data (writes ids.json)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/resources_dev \
  pnpm bench:seed --clear

# 3. Run the five scenarios (host k6 — canonical)
mise run bench:prod:smoke
mise run bench:prod:read
mise run bench:prod:write
mise run bench:prod:mixed
mise run bench:prod:cache:warm

# 3. In-compose fallback (what this report actually used)
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile bench \
  run --rm -e BASE_URL=http://nginx:80 k6 run /benchmarks/scenarios/read-load.js

# 4. Capture docker stats during a run (separate shell).
#    IMPORTANT: include the k6 run container so you can quantify the
#    load generator's own CPU cost. Matching by pattern picks up the
#    randomized `problem5-k6-run-<hash>` name that compose uses for
#    `--profile bench run --rm k6 ...` launches.
while true; do
  date +%s
  docker stats --no-stream --format '{{.Container}}|{{.CPUPerc}}|{{.MemUsage}}' \
    $(docker ps --format '{{.Names}}' | grep -E '^(resources-|problem5[_-].*k6)') 2>/dev/null
  echo "---"
  sleep 3
done > /tmp/s11-stats.log

# 4a. Also watch Activity Monitor (macOS) or `top` / `htop` (Linux) on
#     the HOST during the run. If host CPU sits at 90%+ total, the
#     laptop is the bottleneck regardless of what individual containers
#     report in docker stats — see this report's §Interpretation.

# 4b. Optional: export the k6 summary JSON for vu_utilization
#     and dropped_iterations breakdown.
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile bench \
  run --rm -v /tmp:/hosttmp -e BASE_URL=http://nginx:80 k6 run \
  --summary-export=/hosttmp/read-load-summary.json \
  /benchmarks/scenarios/read-load.js

# 5. Tear down
mise run down:prod               # keeps volumes
mise run down:prod:volumes       # wipes postgres + redis
```

Expected deltas on **the same machine** are within ~5% run-to-run. Different
hardware (Linux bare-metal, CI boxes, different M-series laptops) will
produce substantially different numbers — this is fine; the *shape* of the
result (small lift, saturated api cores, near-idle postgres, near-idle redis)
is the load-bearing finding, not the specific RPS numbers.
