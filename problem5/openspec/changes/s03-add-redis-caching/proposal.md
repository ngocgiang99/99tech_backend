## Why

The service from Change 2 works, but at the performance target (10k GET RPS, 100 write RPS) every GET hits Postgres directly. A single Postgres instance on a laptop runs out of headroom long before 10k RPS — not because the queries are slow in isolation, but because parse/plan/execute overhead, connection pool saturation, and bitmap-index scans all stack up. The explicit purpose of having Redis in the stack is to absorb the read path, so the cache has to land as its own change before Change 5 benchmarks anything.

The cache must be transparent to callers and must not break the spec scenarios from Change 2. The repository interface already gives us a clean seam: Change 2 designed it as a decoration point, and this change is the decoration.

## What Changes

- Introduce a Redis client (`ioredis`) connected to the compose Redis service, with a typed config and a readiness check wired into the existing `HealthCheckRegistry`.
- Introduce a `CachedResourceRepository` that implements the same `ResourceRepository` interface defined in Change 2 and composes with the Postgres-backed implementation.
- Introduce cache-aside semantics for `findById`: on miss, call the underlying repository, serialize the result to JSON, store in Redis with TTL 300 s keyed by `resource:{id}`; on hit, deserialize and return.
- Introduce cache-aside semantics for `list`: the cache key hashes the normalized filter tuple together with a per-namespace list version counter; on miss, the query runs and the result set plus `nextCursor` are cached with TTL 60 s.
- Introduce cache invalidation on writes: `create` bumps the list version counter; `update` bumps the list version counter and deletes the specific `resource:{id}` key; `delete` does both.
- Introduce a singleflight mechanism around cache misses so that a burst of concurrent misses on the same key only results in one upstream query per (process × key) pair.
- Introduce an `X-Cache: HIT` / `X-Cache: MISS` response header on the GET endpoints for observability (so k6 scripts can assert hit rate).
- Introduce a feature flag `CACHE_ENABLED` (default `true`) so Change 5 benchmarks can compare cache-on and cache-off runs.

## Capabilities

### New Capabilities

- `response-caching`: The contract for how GET responses are cached, invalidated on writes, and observed via headers — from the caller's perspective, not the implementation's.

### Modified Capabilities

- `project-bootstrap`: The health registry gains a `cache` check that confirms Redis is reachable. Spec-level change to the Health Endpoint requirement.

## Impact

- **New files**: `src/cache/client.ts`, `src/cache/health.ts`, `src/cache/singleflight.ts`, `src/modules/resources/cached-repository.ts`, `src/modules/resources/cache-keys.ts`.
- **Modified files**: `src/index.ts` (construct Redis client, register cache health check, register shutdown hook, wire `CachedResourceRepository` in front of the Postgres repository when `CACHE_ENABLED`), `src/http/app.ts` (set `X-Cache` response header from a request-scoped flag), `src/config/env.ts` (add `CACHE_ENABLED`, `CACHE_DETAIL_TTL_SECONDS`, `CACHE_LIST_TTL_SECONDS`, `CACHE_LIST_VERSION_KEY_PREFIX`), `.env.example` (new vars with defaults), `README.md` (document the cache and the feature flag), `package.json` (add `ioredis`).
- **New dependencies**: `ioredis`.
- **APIs exposed**: No new endpoints. Response bodies are unchanged. One new response header (`X-Cache`) on `GET /resources` and `GET /resources/:id`.
- **Systems affected**: Redis becomes a first-class dependency. A Redis outage now causes `GET /healthz` to report `503` via the new `cache` health check.
- **Breaking changes**: None at the HTTP contract level. Any test from Change 4 that asserts exact response headers SHALL accept `X-Cache` as a header.
