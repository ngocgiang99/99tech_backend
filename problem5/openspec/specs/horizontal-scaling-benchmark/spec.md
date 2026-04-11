# horizontal-scaling-benchmark

## Purpose

Defines how the Resources API is benchmarked under a multi-replica production-shaped topology — the additive sibling of `performance-benchmarking`, which covers the single-replica dev-stack k6 contract. Covers the standalone prod compose file that runs three explicitly named API replicas (`api-1`, `api-2`, `api-3`) behind one nginx reverse proxy, the nginx upstream configuration (round-robin with HTTP/1.1 keepalive), per-replica Postgres connection pool sizing that respects Postgres's `max_connections` ceiling, migration-race safety under concurrent replica startup, the reuse of the existing `s05-add-benchmarks-k6` scenarios against the new topology, and the canonical `Benchmark_prod.md` delta report that sits alongside `Benchmark.md` with an added `vs single` lift column.

The topology is a **minimal overlay** on `docker-compose.yml`: the prod file defines ONLY the three API replicas and nginx, and intentionally reuses the dev stack's postgres, redis, `app-network`, and named volumes by being launched together with `-f docker-compose.yml -f docker-compose.prod.yml`. The dev stack — `docker-compose.yml`, `mise run up`, integration tests, and the existing `s05` benchmarks — remains the day-to-day developer experience and is byte-identical before and after this capability lands.

The change is deliberately narrow: one new compose file, one nginx config, one delta report, a handful of new mise task wrappers, and an `.env.example` entry. No file under `src/`, `tests/`, `migrations/`, `benchmarks/scenarios/`, or `benchmarks/lib/` is modified, added, or removed — the capability is purely deployment-topology and reporting. No Kubernetes, no Helm, no PgBouncer, no cluster mode, no autoscaling. Three replicas is hard-coded; the point of the capability is not "horizontal scaling controller" but "is the Node event loop the wall, and what does putting three of them in front of nginx actually buy on this hardware?"

## Requirements

### Requirement: Minimal Overlay Production Compose File

The repository SHALL include a `docker-compose.prod.yml` file at the project root that is a **minimal overlay** on `docker-compose.yml`: it defines ONLY the three API replicas (`api-1`, `api-2`, `api-3`) and the `nginx` reverse proxy, and intentionally reuses `docker-compose.yml`'s `postgres`, `redis`, `app-network`, and named volumes rather than redefining them. Launching the prod topology SHALL be performed by passing both files together to docker compose (`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`), or equivalently via the `mise run up:prod` wrapper.

#### Scenario: Prod compose file exists at the project root

- **WHEN** a contributor lists files at the project root after this change lands
- **THEN** `docker-compose.prod.yml` is present alongside the existing `docker-compose.yml`
- **AND** opening the file shows a `services:` section containing exactly four services (`api-1`, `api-2`, `api-3`, `nginx`)
- **AND** the file does NOT redefine `postgres`, `redis`, the dev `api`, `app-network`, or any volume — those are inherited from `docker-compose.yml`

#### Scenario: Dev compose file is unchanged

- **WHEN** a contributor compares `docker-compose.yml` before and after this change
- **THEN** `docker-compose.yml` is byte-identical (or differs only in whitespace / unrelated lines)
- **AND** the existing `mise run up`, `mise run down`, and existing `bench:*` task behaviors against the dev stack are unchanged

#### Scenario: Default `docker compose up` does not launch the prod topology

- **WHEN** a contributor runs `docker compose up -d` from the project root with no `-f` flag
- **THEN** only the dev `api` service (single replica), `postgres`, and `redis` containers start
- **AND** no `nginx`, `api-1`, `api-2`, or `api-3` container is created

#### Scenario: `mise run up:prod` brings up the overlay layered on the dev stack

- **WHEN** a contributor runs `mise run up:prod` (which wraps `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`)
- **THEN** dev `api`, `postgres`, `redis`, `api-1`, `api-2`, `api-3`, and `nginx` all start
- **AND** the merged config lists exactly those seven services and no others from the default profile
- **AND** nginx publishes to host port `${NGINX_PORT:-8080}` and is reachable via `http://localhost:8080`
- **AND** running `docker compose -f docker-compose.prod.yml config` (prod file alone, no dev overlay) is expected to fail with "undefined network app-network" — documented as by-design

### Requirement: Three Explicitly Named API Replicas

`docker-compose.prod.yml` SHALL define three API services with stable, explicit names `api-1`, `api-2`, and `api-3`. These services SHALL NOT be expressed via `deploy.replicas: 3` or `docker compose --scale api=3`. Each replica SHALL have its own independent healthcheck.

#### Scenario: Three named replicas are present

- **WHEN** a reader opens `docker-compose.prod.yml`
- **THEN** the `services:` section contains three distinct service blocks named `api-1`, `api-2`, `api-3`
- **AND** each block points at the same image build as the dev `api` service
- **AND** no `deploy.replicas` key is used to express replication

#### Scenario: Each replica has its own healthcheck

- **WHEN** the prod stack is brought up with `docker compose -f docker-compose.prod.yml up -d`
- **THEN** `docker compose -f docker-compose.prod.yml ps` shows `api-1`, `api-2`, and `api-3` each with their own health column
- **AND** each healthcheck targets `/healthz?probe=liveness` on that replica's local port
- **AND** killing one replica's process does not affect the health column of the other two

### Requirement: nginx Reverse Proxy with Round-Robin Load Balancing

`docker-compose.prod.yml` SHALL define an `nginx` service pinned to a specific image version (e.g., `nginx:1.27-alpine` or whatever version the change commits) that fronts the three API replicas, reads its configuration from a committed `deploy/nginx/nginx.conf` file, performs default round-robin load balancing across the three upstreams, and publishes the proxy on host port `${NGINX_PORT:-8080}`.

#### Scenario: nginx config file exists in the repository

- **WHEN** a reader opens `deploy/nginx/nginx.conf`
- **THEN** the file defines an `upstream` block listing `api-1:3000`, `api-2:3000`, `api-3:3000`
- **AND** the upstream block does not configure sticky sessions, IP hash, or any non-round-robin balancing method
- **AND** the file is mounted into the nginx container as a read-only volume

#### Scenario: nginx is reachable on the configured host port

- **WHEN** the prod stack is brought up and an operator hits `http://localhost:8080/healthz`
- **THEN** nginx returns the API's healthz response body
- **AND** the response is served by one of the three upstream replicas (round-robin)
- **AND** repeated requests cycle across the three upstreams (verifiable via per-replica logs or response headers if enabled)

#### Scenario: nginx port is configurable via env

- **WHEN** an operator sets `NGINX_PORT=9090` in the environment and brings up the prod stack
- **THEN** nginx is reachable at `http://localhost:9090`
- **AND** the default value when unset is `8080`

### Requirement: HTTP/1.1 Keepalive to Upstream

The `deploy/nginx/nginx.conf` file SHALL configure HTTP/1.1 keepalive between nginx and the API upstreams (`proxy_http_version 1.1;`, `proxy_set_header Connection "";`, and an `upstream` `keepalive` directive with a value sufficient for benchmark load — at least 32, recommended 64 or higher).

#### Scenario: Keepalive directives present in nginx config

- **WHEN** a reader opens `deploy/nginx/nginx.conf`
- **THEN** the upstream block contains a `keepalive <N>;` directive with `N >= 32`
- **AND** the location block (or server block) contains both `proxy_http_version 1.1;` and `proxy_set_header Connection "";`

#### Scenario: Persistent connections observable under load

- **WHEN** the prod stack is under benchmark load and an operator inspects `nginx -V` output or upstream connection state via `ss` / `netstat` from inside the nginx container
- **THEN** the number of established connections to upstream replicas remains roughly constant during the run, rather than churning at request rate

### Requirement: Postgres Connection Pool Sized for Three Replicas

The three API replicas in `docker-compose.prod.yml` SHALL be configured with a `DATABASE_POOL_SIZE` value such that `3 × DATABASE_POOL_SIZE + headroom ≤ Postgres max_connections`, with the headroom (for psql/migrations/admin connections) at least 10. The chosen value SHALL be documented in the prod compose file and in `Benchmark_prod.md`.

#### Scenario: Pool size is set explicitly per replica

- **WHEN** a reader opens `docker-compose.prod.yml`
- **THEN** each of `api-1`, `api-2`, `api-3` defines `DATABASE_POOL_SIZE` in its environment block (or via env_file with a documented prod-specific value)
- **AND** the value is documented in a comment explaining the formula

#### Scenario: Pool size respects Postgres max_connections

- **WHEN** the prod stack is brought up against the default Postgres image (`max_connections=100`)
- **THEN** `3 × DATABASE_POOL_SIZE + 10 ≤ 100`
- **AND** Postgres logs do not contain `FATAL: sorry, too many clients already` during a clean benchmark run

#### Scenario: Dev stack pool size is unchanged

- **WHEN** a contributor compares the `DATABASE_POOL_SIZE` env behavior of the dev `api` service in `docker-compose.yml` before and after this change
- **THEN** the dev pool size is unchanged from its pre-s11 value

### Requirement: Migration Race Resolved Across Replicas

The prod compose file SHALL ensure that simultaneous startup of `api-1`, `api-2`, and `api-3` does not produce duplicate or conflicting migration runs. This is satisfied either by Kysely's migration locking (which serializes concurrent attempts safely) or by gating migrations to a single replica via env (e.g., `MIGRATE_ON_START=true` only on `api-1`, `false` on `api-2` and `api-3`).

#### Scenario: Concurrent startup does not corrupt the migration table

- **WHEN** the prod stack is brought up with all three replicas starting simultaneously
- **THEN** the `kysely_migration` table contains exactly one row per migration after startup
- **AND** no replica has crashed or restarted due to migration conflicts
- **AND** `docker compose -f docker-compose.prod.yml ps` shows all three replicas as `healthy`

#### Scenario: The chosen approach is documented in the compose file

- **WHEN** a reader opens `docker-compose.prod.yml`
- **THEN** a comment near the api service blocks documents which approach is used (Kysely locking vs single-replica gating) and why

### Requirement: Existing Benchmark Scenarios Re-Run Unchanged

The k6 scenario scripts under `benchmarks/scenarios/` from `s05-add-benchmarks-k6` SHALL be reused unchanged against the prod topology. No scenario file SHALL be modified, no threshold SHALL be relaxed, and no new scenario SHALL be introduced as part of this change. The scenarios are pointed at the nginx host port (`http://localhost:${NGINX_PORT:-8080}`) instead of the dev API port via the `BASE_URL` environment variable.

#### Scenario: Scenario files are byte-identical

- **WHEN** a contributor runs `git diff` on `benchmarks/scenarios/` after this change
- **THEN** no scenario file appears in the diff
- **AND** the scenario set (smoke, read-load, write-load, mixed, spike, stress, cache-cold, cache-warm) is unchanged

#### Scenario: BASE_URL points at the nginx port for prod runs

- **WHEN** a reviewer runs `mise run bench:prod:read` (or the equivalent host k6 invocation)
- **THEN** k6 sends requests to `http://localhost:8080` (or whatever `NGINX_PORT` is set to)
- **AND** k6 does NOT send requests directly to a single API container

### Requirement: Canonical Prod Run Uses Host k6, Not In-Compose k6

The canonical numbers recorded in `Benchmark_prod.md` SHALL be produced by running k6 from the host machine against the nginx host port, not from the `k6` service inside `docker-compose.prod.yml`. The compose file MAY still define a `k6` service under a profile for fallback use, but the headline lift numbers in the report SHALL come from a host invocation.

#### Scenario: Report identifies the host k6 invocation explicitly

- **WHEN** a reader opens `Benchmark_prod.md` §Methodology
- **THEN** the document explicitly states that the headline numbers were produced by host k6
- **AND** the exact command is shown (e.g., `k6 run benchmarks/scenarios/read-load.js -e BASE_URL=http://localhost:8080`)
- **AND** the rationale (Decision 6 of design.md, co-location penalty) is summarized in §Interpretation

#### Scenario: mise task wraps the host invocation

- **WHEN** a contributor lists mise tasks with `mise tasks`
- **THEN** at minimum the tasks `bench:prod:read`, `bench:prod:mixed`, `bench:prod:cache:cold`, `bench:prod:cache:warm` are present
- **AND** each task wraps a host k6 invocation against `http://localhost:${NGINX_PORT:-8080}`
- **AND** each task is callable without bringing up an additional container

### Requirement: `Benchmark_prod.md` at Project Root

A new file `Benchmark_prod.md` SHALL exist at the project root after this change, with the same section structure as the existing `Benchmark.md` (`Hardware`, `Methodology`, `Results`, `Cache delta`, `Interpretation`, `Scale-out story`), covering the canonical prod run.

#### Scenario: Report file exists alongside the existing report

- **WHEN** a contributor lists files at the project root
- **THEN** both `Benchmark.md` and `Benchmark_prod.md` are present
- **AND** they are siblings, not nested under `docs/` or any subdirectory

#### Scenario: Section structure mirrors `Benchmark.md`

- **WHEN** a reader opens `Benchmark_prod.md`
- **THEN** the file contains sections titled (in order) `Hardware`, `Methodology`, `Results`, `Cache delta`, `Interpretation` (and a `Scale-out story` section if `Benchmark.md` has one)
- **AND** the Results table has the same columns as `Benchmark.md`'s Results table, plus a `vs single` column showing the lift over the corresponding row in `Benchmark.md`

### Requirement: Results Table Lift Column

The Results table in `Benchmark_prod.md` SHALL include a `vs single` column showing the achieved-RPS ratio between each prod row and the corresponding row in `Benchmark.md`, formatted as a multiplier (e.g., `1.8×`, `2.3×`) or a percentage (e.g., `+82%`).

#### Scenario: Lift column is populated for every row that has a `Benchmark.md` counterpart

- **WHEN** a reader opens `Benchmark_prod.md` §Results
- **THEN** every scenario row that exists in both reports has a non-empty `vs single` cell
- **AND** the value is computed as `prod_RPS / Benchmark.md_RPS` (or equivalent percentage form)
- **AND** scenarios that were not run in `Benchmark.md` (e.g., spike, stress) have a dash or "—" in the column rather than a misleading number

#### Scenario: Lift column distinguishes positive and negative outcomes

- **WHEN** a row's prod RPS is lower than its single-replica counterpart (e.g., due to NAT overhead or pool contention)
- **THEN** the `vs single` cell shows the regression honestly (e.g., `0.9×` or `−10%`)
- **AND** the Interpretation section addresses the regression

### Requirement: Interpretation Section Names the Bottleneck Honestly

`Benchmark_prod.md` §Interpretation SHALL identify which layer of the topology is the binding constraint after horizontal scaling, based on the measured numbers — not based on the hypothesis that motivated the change. If the lift is large (≥ 2×), the section confirms the Node.js event loop hypothesis from `Benchmark.md`. If the lift is small (< 1.5×), the section names the new bottleneck (host CPU, Docker bridge NAT, Postgres pool, nginx CPU, etc.) and explains how it was diagnosed.

#### Scenario: Interpretation cites measured evidence

- **WHEN** a reader opens `Benchmark_prod.md` §Interpretation
- **THEN** every bottleneck claim is backed by a measurement (e.g., "Postgres CPU at 45% during the run, observed via `docker stats`")
- **AND** no claim relies solely on intuition or "should be"

#### Scenario: Scale-out story extends `Benchmark.md`'s scale-out story

- **WHEN** a reader opens `Benchmark_prod.md` §Scale-out story
- **THEN** the section references `Benchmark.md` §Scale-out story rather than restating it from scratch
- **AND** it adds the production mitigations specific to the bottleneck identified above (e.g., "PgBouncer for pool exhaustion", "Linux bare-metal for bridge NAT", "k6 on a dedicated host for load-generator isolation")

### Requirement: README Documents Both Compose Files

`README.md` SHALL include a "Multi-replica benchmark stack" subsection (or similar title) under the existing benchmarking section that explains: when to use `docker-compose.prod.yml`, the `mise run up:prod` command, the nginx URL, the relationship to `Benchmark.md` and `Benchmark_prod.md`, and the explicit note that the dev `docker-compose.yml` remains the day-to-day stack.

#### Scenario: README points at the prod compose command

- **WHEN** an operator reads the README's benchmarking section
- **THEN** there is a clear command to bring up the prod stack (e.g., `mise run up:prod` or `docker compose -f docker-compose.prod.yml up -d`)
- **AND** the README explains that `docker-compose.yml` is the dev stack and `docker-compose.prod.yml` is the multi-replica benchmark topology
- **AND** both `Benchmark.md` and `Benchmark_prod.md` are linked from the README

#### Scenario: README clarifies that dev workflow is unchanged

- **WHEN** an operator reads the new subsection
- **THEN** the text explicitly states that `mise run up`, `mise run dev`, integration tests, and the existing single-replica benchmarks are unchanged
- **AND** the prod compose file is positioned as a benchmark topology, not a deployment target

### Requirement: mise Tasks for Prod Stack

`mise.toml` SHALL include tasks `up:prod`, `down:prod`, and `bench:prod:*` (at minimum `bench:prod:read`, `bench:prod:mixed`, `bench:prod:cache:cold`, `bench:prod:cache:warm`) that wrap the prod compose file and host k6 invocations. The existing `up`, `down`, and `bench:*` tasks SHALL remain unchanged.

#### Scenario: New mise tasks are present

- **WHEN** a contributor runs `mise tasks`
- **THEN** the listing includes `up:prod`, `down:prod`, `bench:prod:read`, `bench:prod:mixed`, `bench:prod:cache:cold`, `bench:prod:cache:warm`
- **AND** running `mise run up:prod` brings up the prod stack
- **AND** running `mise run down:prod` tears down the prod stack

#### Scenario: Existing mise tasks are unchanged

- **WHEN** a contributor compares `mise.toml` `up`, `down`, `bench:*` task definitions before and after this change
- **THEN** their commands are unchanged
- **AND** running `mise run up` still brings up the dev stack as it did before this change

### Requirement: No Changes to API Code, Tests, or Migrations

This change SHALL be purely deployment-topology and reporting. No file under `src/`, `tests/`, or `migrations/` SHALL be modified, added, or removed. No scenario script under `benchmarks/scenarios/` or library file under `benchmarks/lib/` SHALL be modified.

#### Scenario: git diff is limited to topology and report files

- **WHEN** a contributor runs `git diff main..HEAD --name-only` after this change is implemented
- **THEN** no file under `src/`, `tests/`, or `migrations/` appears in the diff
- **AND** no file under `benchmarks/scenarios/` or `benchmarks/lib/` appears in the diff
- **AND** the only files in the diff are `docker-compose.prod.yml`, `deploy/nginx/nginx.conf`, `Benchmark_prod.md`, `README.md`, `mise.toml`, `.env.example`, and the change-tracking files under `openspec/`

### Requirement: Optional CPU Pinning Documented but Disabled by Default

`docker-compose.prod.yml` SHALL NOT enable `cpuset_cpus` by default but SHALL include a comment block (or accompanying documentation) describing a recommended CPU pinning configuration for benchmark reproducibility on a 12-core M-series machine. The Interpretation section of `Benchmark_prod.md` MAY reference CPU pinning as a follow-up optimization.

#### Scenario: Compose file explains the pinning option

- **WHEN** a reader opens `docker-compose.prod.yml`
- **THEN** there is a comment block (near the api service definitions or at the top of the file) describing what `cpuset_cpus` would do and why it is disabled by default
- **AND** the comment lists a recommended pinning layout (e.g., api-1 → CPUs 0-1, api-2 → 2-3, api-3 → 4-5, nginx → 6, postgres → 7, redis → 8)
- **AND** no `cpuset_cpus` key is actually set on any service

#### Scenario: Default run works on any machine

- **WHEN** a reviewer brings up the prod stack on any machine without modifying the compose file
- **THEN** no error related to CPU pinning, cpuset, or core allocation occurs
- **AND** the stack reaches a healthy state regardless of host core count
