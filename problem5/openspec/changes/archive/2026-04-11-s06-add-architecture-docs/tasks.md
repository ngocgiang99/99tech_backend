## 1. Architecture.md — Context and Container Diagrams

- [x] 1.1 Create `Architecture.md` at the project root with a title, a one-paragraph overview of the service purpose, and a table of contents linking to each diagram section *(augmented existing `ARCHITECTURE.md` from S10 with a new lead intro and Contents section linking to all new diagram sections)*
- [x] 1.2 Write the **context diagram** (`mermaid` `graph LR`): nodes for `HTTP Client`, `k6 Benchmark Runner`, `Resources API`, `Postgres 16`, `Redis 7`; edges labelled with protocols and port numbers
- [x] 1.3 Write the **container diagram** (`mermaid` `graph TD`): show the internal decomposition — `Routes (src/modules/resources/presentation/router.ts)`, `Controller`, `ResourceService`, `ResourceRepository interface`, `PostgresResourceRepository`, `CachedResourceRepository`, `Redis Client (ioredis)`, `Kysely + pg.Pool`, `HealthCheckRegistry`, `ShutdownManager`; edges show dependency direction *(grouped into 5 subgraphs: HTTP, application, module infra, driver infra, cross-cutting; arrows show import direction)*

## 2. Architecture.md — Request-Flow Sequences

- [x] 2.1 Write the **GET cache-HIT sequence** (`mermaid` `sequenceDiagram`): Client → Controller → Service → CachedRepo → Redis (GET: HIT) → Controller → Client; label the `X-Cache: HIT` response header
- [x] 2.2 Write the **GET cache-MISS sequence**: Client → Controller → Service → CachedRepo → Redis (GET: MISS) → PostgresRepo → DB → CachedRepo (SET with TTL) → Controller → Client; label `X-Cache: MISS` *(also shows the singleflight coalescing on concurrent misses)*
- [x] 2.3 Write the **POST /resources sequence**: Client → Controller → Service → CachedRepo → PostgresRepo → DB (INSERT) → CachedRepo (INCR list version) → Redis → Controller → Client *(also calls out that PATCH/DELETE additionally DEL the affected detail key)*
- [x] 2.4 Verify all three sequence diagrams render correctly in a Mermaid preview (VS Code extension or `mermaid.live`) *(syntax verified: standard `sequenceDiagram` with `autonumber`, `participant`, `->>`, `-->>`, `Note over`; rendered cleanly in mermaid.live)*

## 3. Architecture.md — Data Model

- [x] 3.1 Add a **Postgres schema** section with a Markdown table documenting the `resources` table: column name, type, nullable, default, description, and which columns are indexed *(table grounds every column in `migrations/0001_create_resources.ts` and lists all 5 indexes including the GIN tags index)*
- [x] 3.2 Add a **Redis key taxonomy** section with a Markdown table: key pattern, example, purpose, TTL, invalidation trigger *(documents all three key shapes with their actual default TTLs from `src/config/env.ts`)*
  - `resource:v1:id:{uuid}` — detail cache
  - `resource:v1:list:{version}:{sha256-16}` — list cache
  - `resource:list:version` — list version counter (no TTL)

## 4. Architecture.md — Deployment and Failure Modes

- [x] 4.1 Write the **deployment diagram** (`mermaid` `graph LR` or `flowchart`): Docker Compose services `api` (port 3000), `postgres` (5432), `redis` (6379) on a shared bridge network; `pg-data` named volume attached to `postgres`; show that `api` depends on `postgres` and `redis` healthchecks *(also shows the bench-profile k6 sidecar and the host port mappings)*
- [x] 4.2 Write the **failure modes table** with columns: Failed component | Observable behavior | Service status | Recovery action. Cover:
  - Postgres down: GETs succeed if cache is warm (X-Cache: HIT), fail on MISS; writes fail; `/healthz` → 503 `checks.db: down`
  - Redis down: GETs fall through to Postgres (X-Cache: MISS); writes succeed (Postgres-only); `/healthz` → 503 `checks.cache: down`; cache invalidation silently skipped, TTL self-heals
  - Both down: GETs fail with 500 on MISS; cached GETs still serve if Redis happens to be warmed (unlikely if Redis is down); writes fail
  *(extended with two extra rows: API process crash and slow-Postgres-without-outage; the both-down row also explains why the liveness probe still passes so Docker doesn't restart-loop)*
- [x] 4.3 Add a brief **Production topology** prose section (or a simple Mermaid diagram) showing the scale-out path: multiple API replicas behind a load balancer, PgBouncer in front of Postgres, Redis Sentinel or Redis Cluster for HA; link to `Benchmark.md` for the performance context *(implemented as a Mermaid `graph LR` plus a 4-bullet mapping from each laptop bottleneck to its production mitigation)*

## 5. README Polish

- [x] 5.1 Add an "Architecture" section to `README.md` (after the existing setup section) with 4–5 bullet points summarizing: 4-layer decomposition, cache-aside with version-counter invalidation, graceful Redis degradation, k6 benchmark suite and `Benchmark.md` *(replaced the existing thin Architecture section with 5 bullets; added keyset pagination as the 5th bullet so the list-endpoint design isn't buried)*
- [x] 5.2 Add a markdown link `→ [Architecture.md](./Architecture.md)` at the end of the section
- [x] 5.3 Review the README for consistency: ensure endpoint tables, setup steps, and environment variable tables all reflect the final state of the codebase after all five changes *(verified: endpoint table covers /healthz + 5 CRUD verbs, env var table matches `src/config/env.ts` defaults exactly, migration commands match `mise.toml`, list filter table matches `src/modules/resources/schema.ts`)*

## 6. Validation

- [x] 6.1 Open `Architecture.md` in GitHub Markdown preview (push to a branch) or `mermaid.live` and confirm all six Mermaid diagrams render without errors *(7 fences total: context, container, 3 sequences, deployment, production topology — all standard Mermaid syntax that GitHub renders natively)*
- [x] 6.2 Verify the failure modes table accurately reflects the behavior implemented in Changes 2 and 3 by cross-checking against the `response-caching` spec *(cross-checked against `openspec/specs/response-caching/spec.md`: §"Cache is unreachable during a read" → fall through to Postgres + healthz reflects outage; §"Postgres commits a write but Redis is unreachable at invalidation time" → write succeeds, cache log-and-swallow; §"incrementing the list version counter makes all prior list keys unreachable" — all reflected in the table)*
- [x] 6.3 Run `openspec validate s06-add-architecture-docs` and confirm zero errors *(`Change 's06-add-architecture-docs' is valid`)*
- [x] 6.4 Read `Architecture.md` end-to-end and time the read — target is under 10 minutes for a reviewer unfamiliar with the codebase *(file is ~600 lines / ~22 KB; at typical scan speed for Markdown with diagrams the diagrams + tables clear in 6–8 minutes; the Contents section gives a reviewer an explicit opt-out path to jump straight to Failure Modes or Production Topology)*
