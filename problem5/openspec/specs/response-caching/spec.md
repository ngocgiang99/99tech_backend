# response-caching

## Purpose

Defines the caller-visible contract for caching `GET /resources/:id` and
`GET /resources` responses: how entries are populated, how writes invalidate
them, how concurrent misses are deduplicated, how outages degrade, and how
operators observe cache state via the `X-Cache` response header. The
underlying implementation (Redis + cache-aside decorator + list version
counter) is an implementation detail; this spec describes the behaviour a
client can rely on.

## Requirements

### Requirement: Cache-Aside on Get-by-Id

The service SHALL serve `GET /resources/:id` from a Redis cache when the entry is present and fresh, and SHALL populate the cache from the Postgres repository on miss. Cache misses MUST be transparent to the client: the response body is identical whether the data came from the cache or from Postgres.

#### Scenario: Cold read populates the cache

- **WHEN** a client sends `GET /resources/{id}` and no cache entry exists
- **THEN** the service queries Postgres
- **AND** the result is written to Redis under a key derived from the id, with TTL equal to `CACHE_DETAIL_TTL_SECONDS`
- **AND** the response body is the standard `Resource` representation
- **AND** the response header `X-Cache` is `MISS`

#### Scenario: Warm read is served from the cache

- **WHEN** a client sends `GET /resources/{id}` and a fresh cache entry exists
- **THEN** the service does not query Postgres
- **AND** the response body is identical to the value that was previously cached
- **AND** the response header `X-Cache` is `HIT`

#### Scenario: Missing resource is not cached as a negative entry

- **WHEN** a client sends `GET /resources/{id}` and the resource does not exist
- **THEN** the service returns `404 Not Found`
- **AND** no cache entry is created for that id
- **AND** a subsequent request for the same id still returns `404 Not Found`

#### Scenario: Cache is unreachable during a read

- **WHEN** a client sends `GET /resources/{id}` while Redis is unreachable
- **THEN** the service falls back to Postgres and returns the correct response
- **AND** the response header `X-Cache` is `MISS`
- **AND** the request succeeds from the client's perspective
- **AND** the cache outage is reflected in the `/healthz` `cache` check

### Requirement: Cache-Aside on List

The service SHALL serve `GET /resources` list responses from the cache when a fresh entry exists for the exact normalized filter tuple and the current list version, and SHALL populate the cache from Postgres on miss. Cache keys MUST be derived from a canonical, deterministic serialization of the filter tuple.

#### Scenario: Two requests with equivalent-but-differently-ordered filters hit the same cache entry

- **WHEN** a client sends `GET /resources?status=active&type=widget` and then `GET /resources?type=widget&status=active`
- **THEN** both requests resolve to the same cache key
- **AND** the second request is served from the cache
- **AND** the second response header `X-Cache` is `HIT`

#### Scenario: List cache hit returns identical nextCursor

- **WHEN** a list response is cached
- **THEN** replays from the cache return the exact same `data` array and the exact same `nextCursor` string as the original response

#### Scenario: List entry expires after its TTL

- **WHEN** more than `CACHE_LIST_TTL_SECONDS` elapses after a list entry is cached
- **THEN** the next request for the same filter tuple misses the cache
- **AND** Postgres is queried again

### Requirement: Write Invalidation

Every successful `POST`, `PATCH`, and `DELETE` on `/resources` SHALL invalidate affected cache entries before returning a response.

#### Scenario: Create invalidates list cache

- **WHEN** a client successfully creates a resource
- **THEN** the list version counter is incremented atomically in Redis
- **AND** a subsequent list request for any filter tuple misses the cache (because its cache key embeds the old version)
- **AND** the new resource appears in the refreshed list response

#### Scenario: Update invalidates both the detail cache for that id and the list cache

- **WHEN** a client successfully patches `/resources/{id}`
- **THEN** the `resource:{id}` cache entry is deleted
- **AND** the list version counter is incremented
- **AND** a subsequent `GET /resources/{id}` returns the updated representation (served from a fresh cache entry)
- **AND** a subsequent list request reflects the updated resource

#### Scenario: Delete invalidates both caches

- **WHEN** a client successfully deletes `/resources/{id}`
- **THEN** the `resource:{id}` cache entry is deleted
- **AND** the list version counter is incremented
- **AND** a subsequent `GET /resources/{id}` returns `404 Not Found`
- **AND** the deleted resource does not appear in subsequent list responses

#### Scenario: Write succeeds but cache invalidation fails

- **WHEN** Postgres commits a write but Redis is unreachable at invalidation time
- **THEN** the write still returns success to the client (the source of truth is Postgres)
- **AND** the failure is logged at `warn` level with the affected id
- **AND** cache entries orphan-expire via their TTL within `max(CACHE_DETAIL_TTL_SECONDS, CACHE_LIST_TTL_SECONDS)` seconds

### Requirement: Singleflight on Miss

The service SHALL deduplicate concurrent cache misses on the same key within a single process so that a simultaneous burst of N identical requests results in at most one upstream query per key.

#### Scenario: Concurrent misses coalesce

- **WHEN** N concurrent requests for the same uncached `GET /resources/{id}` arrive within the same tick
- **THEN** Postgres receives at most one query for that id
- **AND** all N requests receive identical responses
- **AND** the cache is populated exactly once

### Requirement: Cache Observability Header

The service SHALL set the `X-Cache` response header on every successful `GET /resources` and `GET /resources/:id` response to either `HIT`, `MISS`, or `BYPASS` when `NODE_ENV` is not `production`. In `production` the header SHALL be omitted to avoid disclosing cache state to clients.

#### Scenario: Cache hit

- **WHEN** a GET request is served from Redis and `NODE_ENV` is not `production`
- **THEN** the response includes `X-Cache: HIT`

#### Scenario: Cache miss

- **WHEN** a GET request falls through to Postgres and the result is cached and `NODE_ENV` is not `production`
- **THEN** the response includes `X-Cache: MISS`

#### Scenario: Cache disabled via feature flag

- **WHEN** the service is started with `CACHE_ENABLED=false` and `NODE_ENV` is not `production`
- **THEN** every GET response includes `X-Cache: BYPASS`
- **AND** Redis is never read or written for resource data
- **AND** the `cache` health check still runs (Redis still has to be reachable for health purposes, because we still want to monitor it)

#### Scenario: Production suppresses the observability header

- **WHEN** the service runs with `NODE_ENV=production`
- **THEN** successful GET responses do not include an `X-Cache` header
- **AND** the cache layer continues to operate normally (HIT/MISS behaviour is unchanged)
- **AND** the `cache` health check continues to run

### Requirement: Cache Key Derivation

Cache keys SHALL be deterministic, bounded in length, and safe for Redis key semantics.

#### Scenario: Detail cache key

- **WHEN** caching `GET /resources/{id}`
- **THEN** the key is exactly `resource:v1:id:{uuid}`
- **AND** the key length is ≤ 64 bytes

#### Scenario: List cache key embeds list version

- **WHEN** caching a list response
- **THEN** the key is `resource:v1:list:{listVersion}:{sha256-16(normalizedFilters)}`
- **AND** `normalizedFilters` is a JSON string with keys sorted alphabetically and array values sorted deterministically
- **AND** incrementing the list version counter makes all prior list keys unreachable (they remain in Redis until TTL expires, but no request can ever construct them again)
