# PATCH /resources/:id — partial update

Updates invalidate **both** the detail key for the affected id (via `DEL`) and the list version counter (via `INCR`). The detail key needs an explicit `DEL` because the row's old contents are still cached under the same key.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant Ctl as Controller
    participant Svc as ResourceService
    participant Cache as CachedRepository
    participant Pg as PostgresRepository
    participant DB as Postgres
    participant R as Redis

    C->>Ctl: PATCH /resources/{id}<br/>{ status: "archived" }
    Ctl->>Ctl: validate UUID + Zod strict body<br/>(reject id, createdAt, updatedAt in body)
    Ctl->>Svc: update(id, patch, ctx)
    Svc->>Cache: update(id, patch, ctx)
    Cache->>Pg: update(id, patch, ctx)
    Pg->>DB: UPDATE resources SET ..., updated_at = now()<br/>WHERE id = $1 RETURNING *

    alt row not found
        DB-->>Pg: empty
        Pg-->>Cache: null
        Cache-->>Svc: null
        Svc-->>Ctl: throw NotFoundError
        Ctl-->>C: 404 NOT_FOUND
    else success
        DB-->>Pg: updated row
        Pg-->>Cache: Resource
        Cache->>R: DEL resource:v1:id:{id}
        Cache->>R: INCR resource:list:version
        Note over Cache,R: Invalidation runs after the commit.<br/>If DEL or INCR fails, the entry self-heals via TTL.
        Cache-->>Svc: Resource
        Svc-->>Ctl: Resource
        Ctl-->>C: 200 OK<br/>{ Resource }
    end
```

## Key points

- **`updated_at` bumps on every PATCH**, even if no field semantically changed. This is a deliberate choice to make invalidation unconditional — the alternative would require an equality check that adds complexity for negligible gain.
- **Metadata is replaced, not merged.** `PATCH /resources/{id}` with `{metadata: {k: "v"}}` replaces the entire `metadata` object. Clients that want merge semantics GET, modify, and PATCH the merged result themselves.
- **`id`, `createdAt`, `updatedAt` are never writable.** The Zod `.strict()` schema rejects them with a `VALIDATION` error.
- **Two Redis ops, both fire-and-forget.** Either failing leaves the system in a recoverable state: a missed `DEL` self-heals at the detail TTL (300 s); a missed `INCR` only matters if the list cache was also serving stale pages, and those self-heal at the list TTL (60 s).

See [the cache invalidation flow](./cache-invalidation.md) for the version-counter mechanics.
