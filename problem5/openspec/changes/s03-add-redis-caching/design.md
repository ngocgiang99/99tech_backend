## Context

Change 2 gives us a working CRUD API that reads directly from Postgres. That's correct but it doesn't meet the performance target: at 10k GET RPS, a single Postgres instance on laptop hardware becomes the bottleneck long before the network or the Node event loop does. The brief explicitly calls for Redis in the stack precisely so that we can absorb the read path off Postgres.

This change introduces the cache layer without changing a single line of the HTTP contract. The repository interface in Change 2 was designed as a decoration seam, and this change is the decoration: a `CachedResourceRepository` that wraps the Postgres repository and implements the same interface. The service layer doesn't know or care which implementation it holds.

The hardest design call is not whether to cache — it's what to do about list-query invalidation. Detail caching is trivial (`resource:{id}`, delete on update). List caching is notoriously hard because a write can invalidate an unknowable subset of cached pages, and building a reverse index from "filter tuple" to "contains resource X" is the sort of complexity that sinks take-home projects. We sidestep this by using a version counter.

## Goals / Non-Goals

**Goals:**

- Serve hot GET paths from Redis without changing response bodies.
- Keep the cache layer completely transparent to the service and controller (decorator pattern around the repository interface from Change 2).
- Correctly invalidate on writes without building a reverse index.
- Degrade gracefully: a Redis outage MUST NOT take down the service. Reads fall through to Postgres; writes still succeed.
- Expose enough observability (`X-Cache` header) that Change 5's benchmarks can report hit rates.
- Support a `CACHE_ENABLED=false` kill switch so benchmarks can compare apples to apples.

**Non-Goals:**

- Distributed locks beyond in-process singleflight. Cross-process thundering herds are acceptable at this scale and the complexity of distributed locking is not justified.
- Two-tier caching (in-process LRU on top of Redis). Adds complexity and a cache coherence layer we don't need.
- Cache warming on startup. Change 5 will do this explicitly in the "warm" benchmark scenario.
- Write-through caching. Cache-aside is simpler, more fault-tolerant, and matches the access pattern.
- Negative caching (caching 404s). Ambiguous wins under concurrent create + read races; not worth the complexity.
- Cache compression. Resources are small enough (< 16 KB) that compression saves pennies and costs CPU.

## Decisions

### Decision 1: Cache-aside (lazy) instead of write-through or read-through

```
READ path:
  client → service → cachedRepo.findById(id)
                       ↓
                     GET resource:{id} from Redis
                       ├─ HIT  → parse JSON → return
                       └─ MISS → pgRepo.findById(id)
                                    → SET resource:{id} with TTL
                                    → return

WRITE path:
  client → service → cachedRepo.update(id, patch)
                       ↓
                     pgRepo.update(id, patch)     ← source of truth first
                       ↓
                     DEL resource:{id}            ← invalidate detail
                       ↓
                     INCR resource:list:version   ← invalidate list
                       ↓
                     return updated resource
```

Cache-aside is the simplest model that matches the workload: 99% of traffic is reads, misses are rare, and on miss we don't mind a single extra round trip. Write-through and read-through are both strictly more complex without buying anything for a brief like this.

**Alternatives considered:**

- *Write-through*: Writes update cache and DB in the same operation. Adds a second failure mode (partial write), requires distributed transaction thinking, not needed at 100 writes/s.
- *Read-through*: Cache library drives DB reads. Requires a Redis library that supports this natively (ioredis doesn't); offers no benefit over cache-aside.

### Decision 2: List invalidation via a version counter (the "version trick")

The problem: when a client writes, which list cache keys should we delete? There can be dozens of them, parameterized by every combination of `type`, `status`, `tag`, `ownerId`, `createdAfter`, `createdBefore`, `sort`, `limit`, and `cursor` that any client has ever requested. Building a reverse index ("this resource appears in pages X, Y, Z") is bookkeeping hell.

The trick:

1. Keep a single counter in Redis: `resource:list:version`.
2. Every list cache key embeds the current value of this counter: `resource:v1:list:{version}:{hash(filters)}`.
3. On any write, `INCR resource:list:version` atomically.
4. After the increment, every future list request constructs a key with the new version, which misses the cache.
5. The old keys stay in Redis but are unreachable. They orphan-expire via their TTL (60 s).

This trades a tiny amount of wasted Redis memory (orphaned keys for up to 60 s) for near-zero invalidation logic. Memory usage is bounded because the TTL is short.

**Alternatives considered:**

- *Reverse index (resource id → list keys that contain it)*: Exact invalidation, but the bookkeeping overhead exceeds what it saves.
- *Short TTL without version counter*: Means stale list results for up to TTL seconds after every write. Unacceptable because writes should be immediately visible.
- *Delete by pattern (`SCAN MATCH resource:list:*` + `DEL`)*: O(keys) per write, locks Redis on SCAN, doesn't scale.
- *Redis tags module*: External dependency, not in vanilla Redis.

### Decision 3: Cache key schema is versioned by an internal prefix (`v1`)

`resource:v1:id:{uuid}` and `resource:v1:list:{version}:{hash}`. The `v1` prefix lets us ship breaking changes to the serialization format (e.g. adding a new field to `Resource`) by bumping the internal version, without flushing Redis manually.

**Alternatives considered:**

- *No version prefix*: Any serialization change requires manual cache flush.
- *Use Redis database numbers for versioning*: Not portable across Redis clusters.

### Decision 4: Serialize to JSON, not MessagePack

JSON is readable via `redis-cli GET resource:v1:id:{uuid}` which makes debugging under benchmark load trivial. MessagePack is smaller and faster to parse, but for our resource sizes (< 1 KB typical) the difference is dwarfed by network latency. We value debuggability.

**Alternatives considered:**

- *MessagePack*: ~30% smaller, ~2x faster to parse. Not enough gain to justify opacity.
- *Raw Buffer / Protobuf*: Even smaller, but forces a schema file dance for every change.

### Decision 5: Singleflight is in-process only

A burst of concurrent misses on the same hot key (`resource:v1:id:X` where X is a viral resource) would normally trigger N identical Postgres queries. Per-process singleflight coalesces them: the first miss runs the query, subsequent callers attach to the same in-flight promise.

Cross-process singleflight (SETNX with a lease) is a separate problem. At our scale, the cost of cross-process duplicate queries is negligible — we expect only a few processes, not dozens. Keeping singleflight in-process avoids the locking-correctness minefield.

**Alternatives considered:**

- *Redis SETNX lock*: Correct but complex. Adds a round trip on every miss. Benefits only show up at much higher concurrency.
- *No singleflight*: Works until a viral key causes N queries in one tick. Cheap to fix, so we fix it.

### Decision 6: Graceful degradation on Redis outage

Every Redis call is wrapped in a try/catch. On failure, we:

1. Log at `warn` (not `error` — this is expected behavior under outage).
2. Fall through to Postgres.
3. Set `X-Cache: MISS`.
4. Let the `cache` health check surface the problem separately.

Reads survive. Writes commit to Postgres successfully. The service degrades from "fast" to "Postgres-bottlenecked" until Redis comes back.

**Alternatives considered:**

- *Fail the request on Redis error*: Couples availability of the GET path to Redis. Unacceptable.
- *Circuit breaker around Redis calls*: Better, but the naïve try/catch is already sufficient and a circuit breaker is future work.

### Decision 7: TTL choices: detail 300 s, list 60 s

- **Detail 300 s**: Long enough to absorb hot-key reads (viral GET /:id). Short enough that a stale entry after a hypothetical lost-invalidation bug self-heals in minutes.
- **List 60 s**: Short because list invalidation is "best effort with orphan expiry" — the version-counter trick already provides correctness, the TTL just bounds memory growth.

These values are env-configurable so benchmarks in Change 5 can experiment.

**Alternatives considered:**

- *Infinite TTL with explicit eviction only*: Requires flawless invalidation. Not worth the risk.
- *Very short TTL (10 s)*: Reduces memory but makes cache nearly useless.

### Decision 8: `X-Cache` header set from a request-scoped flag

The `CachedResourceRepository` sets a flag on the Express `res.locals.cacheStatus` when it returns. A tiny middleware at the end of the chain reads the flag and sets the response header. This keeps the repository ignorant of HTTP details while still surfacing the observability signal.

**Alternatives considered:**

- *Return a tagged union `{hit: boolean, data: T}` from the repository*: Leaks cache awareness into the service.
- *Thread-local storage*: Not available in Node; can be emulated via AsyncLocalStorage but overkill.

## Risks / Trade-offs

- **[Risk: Orphaned list cache entries accumulate in Redis]** → Mitigation: 60 s TTL caps memory growth. Even with 10k RPS of misses during a flush, orphans fit comfortably in Redis's eviction policy (`allkeys-lru` in compose config).
- **[Risk: The version counter is a hot write point under heavy writes]** → Mitigation: 100 writes/s is the brief's target. INCR is ~100k ops/s on Redis. Two orders of magnitude of headroom.
- **[Risk: Detail cache returns stale data if the `DEL resource:{id}` after a successful Postgres update fails (network blip)]** → Mitigation: Logged as `warn`, entry expires via its TTL (max 300 s staleness window). Accepted because making writes atomic with cache invalidation would require 2PC or Redis transactions that add complexity without matching the SLA we care about.
- **[Risk: Singleflight bug could deadlock a hot key]** → Mitigation: Singleflight promise is rejected on upstream error, and the promise is deleted from the in-flight map regardless of outcome. Timeout is explicit (3 s).
- **[Risk: JSON serialization allocates on every cache hit path]** → Mitigation: At our sizes this is cheap relative to the avoided DB round trip. If the benchmark surfaces it as a hotspot in Change 5, we can reconsider.
- **[Risk: Cache-aside has a classic race: writer invalidates, reader misses and writes the old value back]** → Mitigation: Because we invalidate *after* the Postgres write commits, a concurrent read that started before the write either reads the old value (consistent with its snapshot) or hits a fresh cache entry after the invalidation (consistent with the new state). The documented inconsistency window is the duration of one Postgres query — a few milliseconds. Acceptable.

## Migration Plan

1. Add the dependency, add config, and wire the Redis client into `src/index.ts`.
2. Register the `cache` health check.
3. Add `CachedResourceRepository` wrapping the Postgres repo.
4. Gate wrapping on `CACHE_ENABLED=true` (default true).
5. Deploy (for this brief, that means `docker compose up --build`). Zero downtime not a concern — this is local.

Rollback: set `CACHE_ENABLED=false` in `.env` and restart. The service continues serving requests from Postgres directly.

## Open Questions

- **Should we also cache the negative result of `GET /resources/{id}` for unknown ids?** No for this change. A create-then-read race could serve 404 stale otherwise. Revisit if benchmarks show a lot of repeat 404 traffic.
- **Should list TTL be shorter (e.g. 30 s) or longer (e.g. 120 s)?** 60 s is a round number; benchmarks can tune.
- **Should the list version counter be global or per-type (`resource:list:version:{type}`)?** Global is simpler; per-type is a possible future optimization if benchmarks show it matters.
