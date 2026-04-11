# architecture-documentation

## Purpose

Defines the contract for how the system's architecture is communicated to anyone reading the project. The goal is that someone who has never seen the code can read `ARCHITECTURE.md` in under 10 minutes and understand the layering, the data flow at request time, the failure-mode posture, and the production scale-out path — without opening any source file.

This capability is deliberately *overview-first*: `ARCHITECTURE.md` at the project root is the single entry point and stays scannable (no inline sequence diagrams that bury the structural content). Per-endpoint sequence diagrams live as standalone files under `docs/architecture/`, indexed from `ARCHITECTURE.md`'s "Request Flows" section, so each flow is independently linkable and the master document doesn't grow unbounded as new endpoints are added.

## Requirements

### Requirement: Architecture.md Overview Document

The project SHALL include an `ARCHITECTURE.md` at the project root containing the structural sections needed to form a complete mental model of the system in under 10 minutes.

#### Scenario: Context diagram is present and renders

- **WHEN** `ARCHITECTURE.md` is opened in GitHub Markdown preview or a Mermaid-compatible editor
- **THEN** a context diagram renders as a graph showing the API service, its HTTP clients (including k6 for benchmarks), Postgres, and Redis
- **AND** the diagram uses Mermaid syntax in a fenced code block with the `mermaid` language tag

#### Scenario: Container diagram is present and renders

- **WHEN** `ARCHITECTURE.md` is read
- **THEN** a container diagram shows the internal module decomposition: HTTP layer (router, controller, mapper, middleware), application layer (service, cursor, request-context), module infrastructure (repository, cached-repository, cache-keys), driver infrastructure (Kysely + pg.Pool, ioredis, singleflight), and cross-cutting primitives (health registry, shutdown manager, error taxonomy, logger)
- **AND** each box references the primary file path in the codebase
- **AND** arrows show the dependency direction (`presentation → application → infrastructure`)

#### Scenario: Data model section is present

- **WHEN** `ARCHITECTURE.md` is read
- **THEN** there is a section documenting the Postgres `resources` table schema (column names, types, nullability, defaults, descriptions, and which columns are indexed)
- **AND** there is a section documenting the Redis key taxonomy (`resource:v1:id:{uuid}`, `resource:v1:list:{version}:{hash}`, `resource:list:version`)
- **AND** each key entry describes its purpose, TTL, and invalidation trigger

#### Scenario: Deployment diagram is present and renders

- **WHEN** `ARCHITECTURE.md` is read
- **THEN** a deployment diagram shows the Docker Compose service topology: `api`, `postgres`, `redis`, the bridge network, the named volumes, and which ports are exposed to the host
- **AND** the diagram indicates that `api` depends on `postgres` and `redis` healthchecks
- **AND** the optional `bench`-profile k6 sidecar is shown

#### Scenario: Failure modes table is present

- **WHEN** `ARCHITECTURE.md` is read
- **THEN** there is a table with columns: Failed component, Observable behavior, Service status, Recovery action
- **AND** the table covers at minimum: Postgres down, Redis down, both down, API process crash
- **AND** each row accurately reflects the graceful-degradation behavior implemented in the `response-caching` capability — Redis outage falls through to Postgres on read and silently swallows invalidation on write; Postgres outage serves warm cache hits and fails on miss

#### Scenario: Production topology section is present

- **WHEN** `ARCHITECTURE.md` is read
- **THEN** there is a section showing the scale-out path beyond a single-host Docker Compose deployment
- **AND** it identifies the mitigation for each laptop bottleneck: horizontal API replicas behind a load balancer, PgBouncer in transaction mode, Redis HA via Sentinel or Cluster
- **AND** it links to `Benchmark.md` for the empirical performance context

### Requirement: Per-Endpoint Sequence Diagrams

The project SHALL provide a sequence diagram for each request flow on the resources API. Sequence diagrams SHALL live as standalone Markdown files under `docs/architecture/` so each flow is independently linkable, and `ARCHITECTURE.md` SHALL index them from a "Request Flows" section.

#### Scenario: GET cache HIT and MISS sequences are present

- **WHEN** the `Request Flows` section of `ARCHITECTURE.md` is read
- **THEN** it links to a file containing a Mermaid `sequenceDiagram` for `GET /resources/:id` on the cache HIT path (Redis → response with `X-Cache: HIT`)
- **AND** it links to a file containing a Mermaid `sequenceDiagram` for `GET /resources/:id` on the cache MISS path (Redis miss → singleflight → Postgres → Redis SET → response with `X-Cache: MISS`)
- **AND** both files render in GitHub Markdown preview without errors

#### Scenario: Write sequences are present

- **WHEN** the `Request Flows` section of `ARCHITECTURE.md` is read
- **THEN** it links to a file containing a Mermaid `sequenceDiagram` for `POST /resources` showing Postgres `INSERT` → Redis `INCR resource:list:version`
- **AND** it links to files containing sequence diagrams for `PATCH /resources/:id` and `DELETE /resources/:id` showing the Postgres write followed by both `DEL` of the affected detail key and `INCR` of the list version counter

#### Scenario: Cache invalidation flow is present

- **WHEN** the `Request Flows` section of `ARCHITECTURE.md` is read
- **THEN** it links to a file documenting the version-counter trick: a single `INCR resource:list:version` on any write makes every cached list page unreachable in O(1) work
- **AND** the file explains the trade-off (orphan keys self-expire via TTL within `CACHE_LIST_TTL_SECONDS`, in exchange for not maintaining a reverse index from filter tuples to list keys)

#### Scenario: Health check flow is present

- **WHEN** the `Request Flows` section of `ARCHITECTURE.md` is read
- **THEN** it links to a file documenting the `/healthz` flow: liveness probe (fast path, no dependency calls) versus full readiness check (registered db and cache checks running in parallel with per-check timeouts)

### Requirement: README Architecture Section

The project's `README.md` SHALL contain an "Architecture" section that summarizes the key design decisions and links to `ARCHITECTURE.md` for depth.

#### Scenario: README links to ARCHITECTURE.md

- **WHEN** `README.md` is read
- **THEN** there is a section titled "Architecture" containing a brief summary (≤ 5 bullet points) of the key design decisions
- **AND** there is a direct markdown link to `ARCHITECTURE.md`

#### Scenario: README architecture summary is accurate

- **WHEN** the summary is read
- **THEN** it correctly describes: the layered decomposition with ESLint enforcement, the cache-aside strategy with the version-counter list invalidation trick, the graceful degradation posture when Redis is unavailable, the keyset (cursor) pagination strategy, and the k6 benchmark methodology with reference to `Benchmark.md`
