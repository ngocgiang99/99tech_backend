## ADDED Requirements

### Requirement: Architecture.md Document

The project SHALL include an `Architecture.md` at the project root containing six structured sections that a reviewer can read in under 10 minutes to understand the system design.

#### Scenario: Context diagram is present and renders

- **WHEN** `Architecture.md` is opened in GitHub Markdown preview or a Mermaid-compatible editor
- **THEN** the context diagram renders as a graph showing: the API service, its HTTP clients (including k6 for benchmarks), Postgres, and Redis
- **AND** the diagram uses Mermaid syntax in a fenced code block with the `mermaid` language tag

#### Scenario: Container diagram is present and renders

- **WHEN** `Architecture.md` is read
- **THEN** the container diagram shows the internal module decomposition: HTTP layer (routes, middleware, controller), service layer, repository interface, Postgres repository, cached repository, Redis client, and migration tooling
- **AND** each module shows the primary file path in the codebase

#### Scenario: Request-flow sequence diagrams are present

- **WHEN** `Architecture.md` is read
- **THEN** there is a sequence diagram for `GET /resources/:id` showing both the cache HIT path (Redis → response) and cache MISS path (Redis miss → Postgres → Redis SET → response)
- **AND** there is a sequence diagram for `POST /resources` showing Postgres write → Redis INCR (list version) → response
- **AND** both diagrams use Mermaid `sequenceDiagram` syntax

#### Scenario: Data model section is present

- **WHEN** `Architecture.md` is read
- **THEN** there is a section documenting the Postgres `resources` table schema (column names, types, constraints, indexes)
- **AND** there is a section documenting the Redis key taxonomy (`resource:v1:id:{uuid}`, `resource:v1:list:{version}:{hash}`, `resource:list:version`)
- **AND** each key entry describes its purpose, TTL, and invalidation trigger

#### Scenario: Deployment diagram is present and renders

- **WHEN** `Architecture.md` is read
- **THEN** the deployment diagram shows the Docker Compose service topology: `api`, `postgres`, `redis`, the bridge network, and the named volume
- **AND** it shows which ports are exposed to the host

#### Scenario: Failure modes table is present

- **WHEN** `Architecture.md` is read
- **THEN** there is a table with columns: Failed component, Observable behavior, Service status, Recovery action
- **AND** the table covers at minimum: Postgres down, Redis down, both Postgres and Redis down
- **AND** for each scenario the table accurately reflects the graceful-degradation behavior implemented in Changes 2 and 3

### Requirement: README Architecture Section

The project's `README.md` SHALL contain an "Architecture" section that summarizes the key design decisions and links to `Architecture.md` for depth.

#### Scenario: README links to Architecture.md

- **WHEN** `README.md` is read
- **THEN** there is a section titled "Architecture" (or "Architecture Overview") containing a brief summary (≤ 5 bullet points) of the key design decisions
- **AND** there is a direct markdown link to `Architecture.md`

#### Scenario: README architecture summary is accurate

- **WHEN** the summary is read
- **THEN** it correctly describes: the 4-layer decomposition (HTTP → service → repository → infrastructure), the cache-aside strategy with the version-counter invalidation trick, the graceful degradation posture when Redis is unavailable, and the benchmark methodology
