# Cache invalidation — the version-counter trick

List-query invalidation is the hardest problem in cache-aside. The version-counter trick is the one design call that lets us skip building a reverse index from "filter tuple" → "list keys containing this resource".

```mermaid
flowchart TB
    W[Write op<br/>create / update / delete] --> PG[(Postgres commit)]
    PG --> INC[INCR resource:list:version]
    INC --> NEW[version = N+1]

    subgraph Before[Before the write]
        K1[resource:v1:list:N:hash-abc<br/>reachable by reads]
        K2[resource:v1:list:N:hash-def<br/>reachable by reads]
        K3[resource:v1:list:N:hash-ghi<br/>reachable by reads]
    end

    subgraph After[After the write]
        K1X[resource:v1:list:N:hash-abc<br/>orphan, TTL self-expires]
        K2X[resource:v1:list:N:hash-def<br/>orphan, TTL self-expires]
        K3X[resource:v1:list:N:hash-ghi<br/>orphan, TTL self-expires]
        KNEW[resource:v1:list:N+1:hash-abc<br/>new reads land here]
    end

    NEW -. "invalidates all of these" .-> K1X
    NEW -. .-> K2X
    NEW -. .-> K3X
    NEW --> KNEW

    style K1 fill:#d4f4dd
    style K2 fill:#d4f4dd
    style K3 fill:#d4f4dd
    style K1X fill:#f4d4d4
    style K2X fill:#f4d4d4
    style K3X fill:#f4d4d4
    style KNEW fill:#d4f4dd
```

## How it works

1. Every list cache key embeds the **current** value of `resource:list:version`.
2. On any write, `INCR resource:list:version` atomically.
3. After the increment, every future list request constructs a key with the new version — the old keys become **unreachable** because no request will ever construct them again.
4. The old keys remain in Redis but **orphan-expire** via their TTL (default 60 s, `CACHE_LIST_TTL_SECONDS`). Memory pressure is bounded.

## Trade-off

We waste some Redis memory on orphan keys for up to 60 s. We save building a reverse index from "filter tuple" → "list keys containing this resource". The memory waste is measured in kilobytes per second of orphans; the reverse index would be hundreds of lines of bookkeeping code with its own bug surface.

## Why not `KEYS resource:v1:list:*` + `DEL`?

`KEYS *` is O(N) over the entire keyspace and blocks the Redis event loop. `SCAN` is non-blocking but still scans the keyspace. Either approach is linear in the number of cached pages, runs on every write, and adds round trips. The version counter is one `INCR` — constant time, no scanning.

## What about detail keys?

Detail keys (`resource:v1:id:{uuid}`) are **not** invalidated by the version counter — only list pages are. PATCH and DELETE explicitly `DEL` the affected detail key in addition to the `INCR`. POST does not, because the new resource has no existing detail entry to invalidate.

See the [PATCH](./patch.md), [DELETE](./delete.md), and [POST](./post.md) sequences for the per-method invalidation calls.
