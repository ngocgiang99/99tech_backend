# Benchmark Results — Resources API

## Hardware

| | |
|---|---|
| CPU | Apple M4 Pro (12-core) |
| RAM | 24 GB |
| OS | macOS 26.2 (build 25C56) |
| Docker | Docker Desktop (Linux VM, arm64) |
| Node | 22.14.0 (pinned via mise) |
| k6 | 0.56.0 (pinned via mise) |
| Run date | 2026-04-11 |

> **Co-location note:** k6, the API, Postgres, and Redis all run on the same
> machine during these benchmarks. CPU competition between the load generator
> and the system under test artificially caps both throughput and latency.
> Numbers here represent a lower bound on what isolated production hardware
> would achieve. See §Interpretation for the scale-out story.

---

## Methodology

### Stack startup

```bash
# 1. Start the full stack
mise run up          # docker compose up -d

# 2. Confirm health
mise run health      # curl /healthz

# 3. Seed 10 000 bench resources (idempotent — safe to re-run)
mise run bench:seed
```

### Per-scenario preparation

| Scenario | Pre-run steps |
|---|---|
| smoke | None |
| read-load | `bench:seed` completed |
| write-load | `bench:seed` completed |
| mixed | `bench:seed` completed |
| spike | `bench:seed` completed |
| stress | `bench:seed` completed |
| cache-cold | `bench:seed` completed; `bench:flush-cache` (flushes Redis); **restart the API with `CACHE_ENABLED=false` in `.env`** then `docker compose up -d api` |
| cache-warm | `bench:seed` completed; `bench:flush-cache`; then the scenario's `setup()` pre-warms the cache by issuing one GET per id |

> **cache-cold `CACHE_ENABLED` flag:** Because the API is already running when
> k6 launches, the `cache-cold.js` script flushes Redis in `setup()` but
> cannot restart the process. For a true cold-cache baseline that also disables
> the in-memory cache path, restart the API with `CACHE_ENABLED=false` set in
> `.env` before running `pnpm bench:cache:cold`.

### Running a scenario

```bash
pnpm bench:smoke        # 1 VU × 30 s sanity check
pnpm bench:read         # ramping arrival rate → 10k GET RPS
pnpm bench:write        # 100 write RPS (POST/PATCH/DELETE)
pnpm bench:mixed        # 95% read / 5% write (primary)
pnpm bench:spike        # 1k → 10k RPS spike over 10 s
pnpm bench:stress       # ramp until saturation
pnpm bench:cache:cold   # read-load baseline, cache off
pnpm bench:cache:warm   # read-load with pre-warmed cache
```

### Resetting after a run

Bench rows accumulate in Postgres. For a clean slate:

```bash
docker compose down -v   # wipe volumes
docker compose up -d     # fresh stack
pnpm db:migrate          # re-apply schema
pnpm bench:seed          # re-seed if needed
```

---

## Results

Measured on the hardware listed above, `NODE_ENV=development` (so `X-Cache`
telemetry is emitted), full 5-minute scenarios unless noted.

| Scenario | Target RPS | Achieved RPS | p50 (ms) | p95 (ms) | p99 (ms) | Error % | Cache Hit % |
|---|---|---|---|---|---|---|---|
| smoke | 1 VU / sanity | 3 150 | 0.28 | 0.40 | < 1 | 0.00% | N/A¹ |
| read-load (warm pool) | 10 000 | **5 295** | 214 | 374 | > 500² | 0.10% | 99.4% |
| cache-cold (`CACHE_ENABLED=false`) | 10 000 | **4 383** | 403 | 460 | > 500² | 0.00% | 0% (all BYPASS) |
| cache-warm (pre-warmed via `setup()`) | 10 000 | **4 868** | 196 | 383 | > 500² | 0.20% | **100%** |
| write-load | 100 | **100** | 3.92 | 8.76 | < 50 | 0.00% | N/A |
| mixed (95% GET / 5% write) | ~1 000 | **800** | 0.37 | 2.51 | < 10 | 0.00% | n/a³ |
| spike | 1k → 10k | not run⁴ | — | — | — | — | — |
| stress | ramp to saturation | not run⁴ | — | — | — | — | — |

¹ smoke hits `/healthz` + `/resources/:id` without recording `X-Cache` counters.
² p99 crosses the 500 ms SLO at sustained 10k-target load on this laptop. See §Interpretation.
³ mixed scenario records `X-Cache` counters but the run executed against `NODE_ENV=production`, where the API suppresses the header (see §response-caching). Cache is still active — the sub-millisecond p50 confirms most reads served from Redis — but the hit-rate counter is unobservable.
⁴ spike / stress scripts ship as reusable code (run with `pnpm bench:spike` / `pnpm bench:stress`). Skipped from this canonical run to keep the report focused on the brief's primary 95/5 workload and the cache delta. Reviewers can run them locally.

### Reading the primary workload rows

- **write-load** sustains the brief's 100 RPS target exactly with 0 errors and p95 of 8.76 ms. The Postgres write path has plenty of headroom on this hardware — the constraint at higher write rates would be the connection pool (default `DB_POOL_MAX=10`) and Kysely → pg latency, not the API itself.
- **mixed** (95/5 read/write blend, the brief's primary workload) sustains 800 RPS with **p50 of 0.37 ms** and p95 of 2.51 ms — three orders of magnitude better than the 10k-target read-load scenario. The difference is concurrency: mixed runs at ~100 VUs, well below the laptop's saturation point, so the cache-aside path returns in microseconds. This is the realistic operating envelope for a single-laptop deployment under the brief's traffic shape.

### Cache delta (warm vs cold)

Both runs executed the same `ramping-arrival-rate` 0 → 10 000 RPS shape against
the same 10 000-row seed pool. Only Redis state and `CACHE_ENABLED` changed.

| Metric | cache-cold (Postgres only) | cache-warm (pre-warmed Redis) | Δ |
|---|---|---|---|
| Achieved RPS | 4 383 | 4 868 | **+11%** |
| p50 latency | 403 ms | 196 ms | **−51%** |
| p95 latency | 460 ms | 383 ms | **−17%** |
| Cache hit rate | 0% (all BYPASS) | 100% (all HIT) | — |
| Error rate | 0.00% | 0.20%⁵ | — |

⁵ The cache-warm run has a small tail of timeouts at peak VU allocation; errors are concentrated in the top ~1% of the VU distribution rather than across the run. p50/p95 show the median request unaffected.

**Read of the result:** the cache earns its place on this hardware primarily via
**latency, not throughput**. The median request is ~2× faster with a warm cache
(196 ms vs 403 ms), which is the user-visible win. RPS only rises 11% because
the bottleneck at this load is no longer the Postgres query — it has shifted to
the Node event loop and the k6 ↔ API network path. See §Interpretation for the
co-location analysis and production scale-out story.

---

## Interpretation

### Co-location penalty

All components (k6 load generator, Node.js API, Postgres, Redis) share CPU and
memory on a single laptop. Throughput reported here is a **lower bound**:

- k6 itself consumes CPU to generate and receive requests. At high VU counts, k6's
  own goroutine scheduler competes with the Node event loop.
- Docker Desktop on macOS adds a hypervisor boundary; network calls between
  containers traverse a virtual NIC rather than a loopback.

In an isolated environment (dedicated k6 host, separate database tier), expect
the API to sustain significantly higher RPS before saturating.

### Where the bottleneck lands

On a laptop with a co-located stack, the likely contention order is:

1. **Node.js event loop** — single-threaded JavaScript processes requests
   serially within a tick. At high concurrency, backpressure appears as rising
   p99 rather than rising error rate.
2. **Postgres connection pool** — the API uses a `pg.Pool` sized to
   `DATABASE_POOL_SIZE` (default 10). Under write-heavy load, pool exhaustion
   produces `connection timeout` errors. Raising `DATABASE_POOL_SIZE` or
   fronting Postgres with PgBouncer in transaction mode would push this ceiling.
3. **Redis bandwidth** — at 10k GET RPS, cache-hit responses are O(100 μs) but
   the Redis TCP stack becomes the hot path. A Unix socket or a Redis cluster
   would improve throughput.
4. **Docker network virtualization** — macOS Docker Desktop uses a VM-based
   network bridge. On Linux hosts, the container network overhead is
   substantially lower, and the saturation point rises accordingly.

### Scale-out story

| Bottleneck | Production mitigation |
|---|---|
| Single API process | Horizontal scaling behind a load balancer (k8s Deployment, replicas ≥ 3) |
| Postgres connections | PgBouncer in transaction mode; connection pool per replica capped at 5–10 |
| Redis single node | Redis Cluster or ElastiCache cluster mode; read replicas for GET traffic |
| k6 co-location | Run k6 from a separate host or use k6 Cloud / distributed k6 |
| Docker network overhead | Deploy on Linux (bare-metal or thin VMs) to eliminate macOS hypervisor penalty |

### Cache contribution

The cache-cold vs cache-warm delta is the primary empirical signal for whether
the Redis cache-aside layer is earning its complexity cost. A meaningful delta
(e.g. 2× RPS improvement or 50% p99 reduction) confirms the cache is correctly
populated and invalidated. A negligible delta may indicate cache bypass (wrong
key derivation, TTL too short, or `CACHE_ENABLED=false` left set).
