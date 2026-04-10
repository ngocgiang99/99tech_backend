## Context

Changes 1–3 produce a working service with no way to verify it without manual `curl` calls. The brief requires unit tests and integration tests using Testcontainers. This change lands the test infrastructure and the initial test suites that anchor every future refactor.

Two constraints drive the design:

1. **Speed matters for unit tests; realism matters for integration tests.** Mixing them in one test file produces slow test suites that developers stop running on save. We split them into two Vitest configurations with separate scripts.
2. **Testcontainers is non-negotiable.** The brief says "integration tests with testcontainers," and the reason is sound: testing against a mocked database hides class-of-bug failures (SQL syntax, index usage, JSON serialization round trips). Real Postgres + real Redis in containers is the right answer, and the cost (container startup per suite) is acceptable.

## Goals / Non-Goals

**Goals:**

- A unit test layer that runs in under 5 seconds so it can be bound to save/commit.
- An integration test layer that spins up real datastores via Testcontainers and runs the full HTTP stack end-to-end against `supertest`.
- Coverage reporting with a gate that catches regressions.
- Test files organized by kind (`tests/unit/`, `tests/integration/`) not by module, so a developer can pick "fast" or "realistic" without navigating.
- A single `pnpm test` command that runs both layers for CI or pre-push.

**Non-Goals:**

- Performance benchmarks in the test suite. Change 5 owns performance.
- Visual regression, accessibility, or browser tests. There is no UI.
- Mutation testing. Useful but not worth the setup cost for a brief.
- Contract testing with external consumers. There are no consumers.
- Load testing inside the test suite. Change 5 owns this.
- Mocking Postgres or Redis at the integration layer. The whole point is to test against real instances.

## Decisions

### Decision 1: Vitest (not Jest)

Vitest is ESM-native, which matches the `"type": "module"` package.json from Change 1. It's fast (Vite-powered transform pipeline), has a built-in V8 coverage provider, and its API is Jest-compatible enough that any pre-existing muscle memory transfers. Jest works, but it would add the `ts-jest` or Babel transform dance that Vitest avoids.

**Alternatives considered:**

- *Jest*: Ubiquitous, but ESM support is still awkward in 2026.
- *Node built-in test runner (`node --test`)*: Light and dependency-free, but no built-in coverage, limited assertions, weaker test organization.
- *Ava*: Good concurrency model but smaller ecosystem and no built-in coverage.

### Decision 2: Separate Vitest configs for unit vs. integration

```
vitest.config.ts                ← unit (default `pnpm test:unit`)
  test.include  = ['tests/unit/**/*.test.ts']
  test.environment = 'node'
  (no setup file, no container orchestration)

vitest.config.integration.ts    ← integration (`pnpm test:integration`)
  test.include  = ['tests/integration/**/*.test.ts']
  test.environment = 'node'
  test.globalSetup  = ['tests/integration/fixtures/containers.ts']
  test.testTimeout  = 60_000
  test.hookTimeout  = 120_000  // container startup
```

Two configs mean a developer running the unit layer never accidentally pays the cost of booting Docker containers, and the integration layer gets longer timeouts without bloating unit runs.

**Alternatives considered:**

- *One config with project directives*: Vitest supports multi-project configs, but the ergonomics for running one project are worse than separate files.
- *`vitest --project unit` / `--project integration`*: Workable alternative. We pick separate files for clarity.

### Decision 3: Testcontainers at the suite level, not the test level

Containers start once per test suite file, run all tests in that file, then tear down. A global setup boots shared infrastructure (Postgres, Redis), the per-suite `beforeAll` uses them, and `afterEach` truncates tables to isolate tests.

Per-test containers would take 60× longer (container startup is ~3–5 s per container). Per-run containers (one set for all suites) would leak state between suites unless every test cleans up meticulously. Per-suite hits the sweet spot: fast enough, isolated enough.

**Alternatives considered:**

- *Per-test containers*: Too slow.
- *Per-run containers with aggressive cleanup*: Fragile. Missed cleanup in one test leaks into unrelated tests.
- *Per-suite containers without truncation between tests*: Each test must set up its own scoped data; works but fragile under future refactors.

### Decision 4: Truncate between tests, not restart the container

`DELETE FROM resources` (or `TRUNCATE resources RESTART IDENTITY`) between tests resets database state in < 10 ms. Flushing Redis is a single `FLUSHDB` call. Both are orders of magnitude faster than restarting the containers.

**Alternatives considered:**

- *Per-test schema / per-test DB*: Complex and forces migrations to run for every test.
- *Transaction rollback*: Works for simple repositories but breaks when the code under test opens its own transactions (not the case here, but fragile to depend on).

### Decision 5: `supertest` for HTTP exercising

`supertest` wraps the Express app without binding a real port, letting us issue HTTP requests through an in-process ephemeral server. This is fast and avoids port conflicts between parallel suites.

**Alternatives considered:**

- *`undici`/`node-fetch` against a real listening port*: Realistic but slower and introduces port-allocation problems.
- *Calling controllers directly*: Loses middleware coverage (request-id, error handler, body parsing, `X-Cache` header middleware).

### Decision 6: 80% line coverage gate

Set the coverage threshold just high enough to catch "I forgot to test anything for this file" regressions, not so high that it forces trivial tests on configuration shims. We start at 80% lines and can raise it later.

**Alternatives considered:**

- *No gate*: Coverage drifts down over time.
- *100% gate*: Forces tests against code that's effectively untestable in isolation (bootstrap entry points).
- *Branch coverage gate*: More rigorous but produces false negatives on defensive branches that are hard to reach in tests.

### Decision 7: Integration tests build the app from a factory that accepts injected clients

`tests/integration/fixtures/app.ts` calls the same `createApp(deps)` function that `src/index.ts` calls in production — but with the Postgres/Redis clients pointed at the Testcontainers instances instead of the real ones. This guarantees the tests exercise the real wiring, not a parallel test-only app construction.

To make this work, Change 2 or this change refactors `src/index.ts` to separate "construct deps" from "construct app" so tests can reuse the latter. (If Change 2 did not do this split cleanly, this change performs the refactor as a task.)

**Alternatives considered:**

- *Duplicate app construction in tests*: Drifts over time; tests lie.
- *Hit the real running `docker compose` stack*: Tests depend on the developer's local state. Flaky and order-dependent.

### Decision 8: Test factories, not fixtures files

A `tests/helpers/factory.ts` exports `buildResource(overrides)` returning a valid create-input with sensible defaults. This is lighter than JSON fixture files, easier to refactor when the schema changes, and lets each test declare exactly which fields it cares about.

**Alternatives considered:**

- *JSON fixture files in `tests/fixtures/`*: Rigid, easy to drift, boring to maintain.
- *Test data builders (Java-style)*: Overkill for this scale.

## Risks / Trade-offs

- **[Risk: Testcontainers requires a running Docker daemon on the developer's machine]** → Mitigation: README documents the prerequisite. The unit layer covers a lot of logic without Docker so developers who forget to start Docker can still run the fast suite.
- **[Risk: Container startup on laptops with slow IO (spinning disks, low RAM) can push the integration suite over 2 minutes]** → Mitigation: Single shared Postgres and Redis per run (global setup), truncate between tests, cache Testcontainers images via `testcontainers-desktop` or just rely on the local Docker image cache.
- **[Risk: Vitest and pnpm workspaces interact badly with ESM + TypeScript]** → Mitigation: We don't use workspaces; `vitest` with `vite-node` handles TS natively. `type: "module"` is set consistently in package.json.
- **[Risk: Flaky tests due to timing issues around cache population]** → Mitigation: Integration tests that assert `X-Cache` behavior issue sequential requests (not concurrent) and do not depend on wall-clock TTL expiry. TTL-based tests (where we actually want to observe expiry) use `vi.useFakeTimers` at the unit layer, not the integration layer.
- **[Risk: The coverage gate becomes a nuisance that developers disable]** → Mitigation: Start at 80% lines; raise later if the team agrees. Exclude generated files (`src/db/schema.ts` if it grows to be generated) via `coverage.exclude`.
- **[Risk: Testcontainers image pulls during CI are slow on a cold cache]** → Mitigation: Not our problem for this brief; CI is optional. If we add CI later, we pin image versions and prewarm via a pre-job.

## Migration Plan

No runtime migration — this change only adds test files and dev dependencies. First developer run after pulling this change needs Docker running and may wait ~30 s on the first suite while Testcontainers pulls the `postgres:16-alpine` and `redis:7-alpine` images.

## Open Questions

- **Do we want to gate CI on the integration layer or just the unit layer?** For the brief, there may not be a CI at all; if there is, the unit layer is the minimum gate and integration runs on a longer cadence.
- **Should we include a smoke integration test against `docker compose` (not Testcontainers) as a belt-and-braces check?** Out of scope for this change; developers can always `docker compose up && curl` for manual verification.
