## 1. Architecture.md — Context and Container Diagrams

- [ ] 1.1 Create `Architecture.md` at the project root with a title, a one-paragraph overview of the service purpose, and a table of contents linking to each diagram section
- [ ] 1.2 Write the **context diagram** (`mermaid` `graph LR`): nodes for `HTTP Client`, `k6 Benchmark Runner`, `Resources API`, `Postgres 16`, `Redis 7`; edges labelled with protocols and port numbers
- [ ] 1.3 Write the **container diagram** (`mermaid` `graph TD`): show the internal decomposition — `Routes (src/modules/resources/router.ts)`, `Controller`, `ResourceService`, `ResourceRepository interface`, `PostgresResourceRepository`, `CachedResourceRepository`, `Redis Client (ioredis)`, `Kysely + pg.Pool`, `HealthCheckRegistry`, `ShutdownManager`; edges show dependency direction

## 2. Architecture.md — Request-Flow Sequences

- [ ] 2.1 Write the **GET cache-HIT sequence** (`mermaid` `sequenceDiagram`): Client → Controller → Service → CachedRepo → Redis (GET: HIT) → Controller → Client; label the `X-Cache: HIT` response header
- [ ] 2.2 Write the **GET cache-MISS sequence**: Client → Controller → Service → CachedRepo → Redis (GET: MISS) → PostgresRepo → DB → CachedRepo (SET with TTL) → Controller → Client; label `X-Cache: MISS`
- [ ] 2.3 Write the **POST /resources sequence**: Client → Controller → Service → CachedRepo → PostgresRepo → DB (INSERT) → CachedRepo (INCR list version) → Redis → Controller → Client
- [ ] 2.4 Verify all three sequence diagrams render correctly in a Mermaid preview (VS Code extension or `mermaid.live`)

## 3. Architecture.md — Data Model

- [ ] 3.1 Add a **Postgres schema** section with a Markdown table documenting the `resources` table: column name, type, nullable, default, description, and which columns are indexed
- [ ] 3.2 Add a **Redis key taxonomy** section with a Markdown table: key pattern, example, purpose, TTL, invalidation trigger
  - `resource:v1:id:{uuid}` — detail cache
  - `resource:v1:list:{version}:{sha256-16}` — list cache
  - `resource:list:version` — list version counter (no TTL)

## 4. Architecture.md — Deployment and Failure Modes

- [ ] 4.1 Write the **deployment diagram** (`mermaid` `graph LR` or `flowchart`): Docker Compose services `api` (port 3000), `postgres` (5432), `redis` (6379) on a shared bridge network; `pg-data` named volume attached to `postgres`; show that `api` depends on `postgres` and `redis` healthchecks
- [ ] 4.2 Write the **failure modes table** with columns: Failed component | Observable behavior | Service status | Recovery action. Cover:
  - Postgres down: GETs succeed if cache is warm (X-Cache: HIT), fail on MISS; writes fail; `/healthz` → 503 `checks.db: down`
  - Redis down: GETs fall through to Postgres (X-Cache: MISS); writes succeed (Postgres-only); `/healthz` → 503 `checks.cache: down`; cache invalidation silently skipped, TTL self-heals
  - Both down: GETs fail with 500 on MISS; cached GETs still serve if Redis happens to be warmed (unlikely if Redis is down); writes fail
- [ ] 4.3 Add a brief **Production topology** prose section (or a simple Mermaid diagram) showing the scale-out path: multiple API replicas behind a load balancer, PgBouncer in front of Postgres, Redis Sentinel or Redis Cluster for HA; link to `Benchmark.md` for the performance context

## 5. README Polish

- [ ] 5.1 Add an "Architecture" section to `README.md` (after the existing setup section) with 4–5 bullet points summarizing: 4-layer decomposition, cache-aside with version-counter invalidation, graceful Redis degradation, k6 benchmark suite and `Benchmark.md`
- [ ] 5.2 Add a markdown link `→ [Architecture.md](./Architecture.md)` at the end of the section
- [ ] 5.3 Review the README for consistency: ensure endpoint tables, setup steps, and environment variable tables all reflect the final state of the codebase after all five changes

## 6. Validation

- [ ] 6.1 Open `Architecture.md` in GitHub Markdown preview (push to a branch) or `mermaid.live` and confirm all six Mermaid diagrams render without errors
- [ ] 6.2 Verify the failure modes table accurately reflects the behavior implemented in Changes 2 and 3 by cross-checking against the `response-caching` spec
- [ ] 6.3 Run `openspec validate s06-add-architecture-docs` and confirm zero errors
- [ ] 6.4 Read `Architecture.md` end-to-end and time the read — target is under 10 minutes for a reviewer unfamiliar with the codebase
