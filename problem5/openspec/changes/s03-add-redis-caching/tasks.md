## 1. Redis Client and Config

- [ ] 1.1 Add runtime dependency `ioredis` and regenerate the lockfile
- [ ] 1.2 Extend `src/config/env.ts` with `REDIS_URL`, `CACHE_ENABLED` (default `true`), `CACHE_DETAIL_TTL_SECONDS` (default `300`), `CACHE_LIST_TTL_SECONDS` (default `60`), and `CACHE_LIST_VERSION_KEY_PREFIX` (default `resource:list:version`)
- [ ] 1.3 Create `src/cache/client.ts` exporting a `createRedis(config)` factory that builds an `ioredis` client with sane production defaults (retryStrategy, maxRetriesPerRequest, lazyConnect: false)
- [ ] 1.4 Create `src/cache/health.ts` exporting a `cacheHealthCheck(redis)` function that issues `PING` with a 1-second timeout and reports `{status: "up"|"down", error?: string}`
- [ ] 1.5 Modify `src/index.ts` to construct the Redis client, register `cache` with the `HealthCheckRegistry`, and push `redis.quit()` onto the shutdown hook list
- [ ] 1.6 Update `.env.example` with all new cache-related vars and their defaults
- [ ] 1.7 Verify `curl /healthz` reports `checks.cache: {status: "up"}` when Redis is running and `"down"` when stopped

## 2. Cache Key Derivation

- [ ] 2.1 Create `src/modules/resources/cache-keys.ts` with `detailKey(id)`, `listKey(filters, version)`, and `listVersionKey()` helpers
- [ ] 2.2 Implement `normalizeFilters(filters)` that serializes filters to a canonical JSON string (alphabetically sorted keys, deterministically sorted array values)
- [ ] 2.3 Implement the SHA-256 hash truncated to 16 bytes (32 hex chars) for the list key suffix
- [ ] 2.4 Add unit-testable helpers so Change 4's tests can assert key shapes without booting the whole app

## 3. Singleflight Utility

- [ ] 3.1 Create `src/cache/singleflight.ts` exporting a `Singleflight` class with `do(key, fn)` returning a promise shared across concurrent callers
- [ ] 3.2 Ensure the in-flight map deletes its entry on both resolve and reject
- [ ] 3.3 Add a configurable per-call timeout (default 3 s) that rejects the promise and clears the entry
- [ ] 3.4 Write a focused unit-test-ready design: keep the class small enough to be tested without mocking timers (prefer `vi.useFakeTimers` later but don't depend on it here)

## 4. CachedResourceRepository

- [ ] 4.1 Create `src/modules/resources/cached-repository.ts` exporting `CachedResourceRepository` that implements the `ResourceRepository` interface from Change 2
- [ ] 4.2 Implement `findById` with cache-aside semantics: GET from Redis, on miss use singleflight to call the underlying repository, SET with TTL, return
- [ ] 4.3 Implement `list` with cache-aside semantics: read the current list version, compute the list key, GET from Redis, on miss run the query, SET with TTL, return
- [ ] 4.4 Implement `create`: call underlying repository, then `INCR resource:list:version`
- [ ] 4.5 Implement `update`: call underlying repository, then `DEL resource:v1:id:{id}` and `INCR resource:list:version`
- [ ] 4.6 Implement `delete`: call underlying repository, then `DEL resource:v1:id:{id}` and `INCR resource:list:version`
- [ ] 4.7 Wrap every Redis operation in a try/catch that logs at `warn` and falls through to the underlying repository on failure (the service must never throw because Redis is down)
- [ ] 4.8 Attach cache-hit telemetry to `res.locals.cacheStatus` via a callback or context object passed through the repository (prefer passing a `RequestContext` so the repository stays HTTP-agnostic; the controller writes `res.locals.cacheStatus` from the context it read after calling the service)

## 5. X-Cache Response Header

- [ ] 5.1 Create a thin Express middleware `src/middleware/x-cache.ts` that reads `res.locals.cacheStatus` and sets the `X-Cache` header before the response is sent
- [ ] 5.2 Modify the resources controller to set `res.locals.cacheStatus` from the `RequestContext` after each GET handler completes
- [ ] 5.3 Mount the `x-cache` middleware on the resources router (not the whole app — we only want it on cacheable routes)
- [ ] 5.4 Verify with `curl -i /resources/{id}` that `X-Cache: MISS` appears on the first request and `X-Cache: HIT` on the second

## 6. Wiring

- [ ] 6.1 Modify `src/index.ts` to instantiate `CachedResourceRepository` wrapping the Postgres repository when `CACHE_ENABLED=true`, and to inject the plain Postgres repository otherwise
- [ ] 6.2 Ensure the service constructor accepts the repository interface, so the swap is invisible to everything downstream
- [ ] 6.3 Verify `CACHE_ENABLED=false pnpm dev` responds with `X-Cache: BYPASS` on every GET

## 7. Graceful Degradation Verification

- [ ] 7.1 Start the stack, send 5 GET requests to populate the cache, stop Redis (`docker compose stop redis`), and verify subsequent GETs still succeed with `X-Cache: MISS`
- [ ] 7.2 While Redis is stopped, verify `/healthz` returns `503` with `checks.cache: {status: "down"}`
- [ ] 7.3 Restart Redis and verify subsequent GETs cache again and `/healthz` returns `200`

## 8. Documentation

- [ ] 8.1 Update `README.md` with a "Caching" section explaining cache-aside, the version-counter invalidation trick, and the `CACHE_ENABLED` kill switch
- [ ] 8.2 Document the `X-Cache` header for operators and benchmark readers

## 9. Validation

- [ ] 9.1 Run `pnpm check` and confirm lint + typecheck pass
- [ ] 9.2 Run `openspec validate s03-add-redis-caching` and confirm zero errors
- [ ] 9.3 Smoke-test: create a resource, GET twice (`MISS` then `HIT`), PATCH, GET (`MISS`), DELETE, GET (`404`)
