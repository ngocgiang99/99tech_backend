## Why

Changes 1–3 ship code but no automated way to prove any of it still works after the next edit. The brief asks for unit tests and integration tests using Testcontainers, and every downstream decision (cache invariants, benchmark validity, confidence in refactors) depends on having a fast unit layer and a realistic integration layer. Mocking the database in integration tests would defeat the purpose — Testcontainers gives us real Postgres and real Redis in CI-friendly boxes.

This is also the first change where we have to make a deliberate choice about what to test and what to leave to the benchmarks. Unit tests should be fast enough to run on every save (under 5 seconds). Integration tests should be slow but reliable (under 2 minutes). Benchmarks (Change 5) are the thing that proves performance, not a test suite — so we deliberately keep the integration tests correctness-focused, not performance-focused.

## What Changes

- Introduce Vitest as the test runner (one runner for both unit and integration tests, with separate configs and separate `pnpm` scripts).
- Introduce a `tests/unit/` tree covering pure logic: validators (Zod schemas), cursor encoding/decoding, cache-key derivation, the singleflight utility, and the error-to-HTTP translation layer.
- Introduce a `tests/integration/` tree using `@testcontainers/postgresql` and `@testcontainers/redis` to spin up real datastores per test suite, run migrations against them, and exercise the HTTP layer end-to-end via `supertest`.
- Introduce a shared integration test fixture (`tests/integration/fixtures/app.ts`) that builds the Express app with real clients pointed at the test containers, runs migrations, and tears down after each suite.
- Introduce coverage reporting via Vitest's built-in V8 coverage, with a minimum coverage gate (`--coverage.thresholds.lines=80`) that can be relaxed per-file for generated code.
- Introduce `pnpm test`, `pnpm test:unit`, `pnpm test:integration`, `pnpm test:watch`, and `pnpm test:coverage` scripts.
- Introduce a `docker-compose.test.yml` overlay (or a Vitest global setup) that developers can use if they prefer running integration tests without Testcontainers (using the already-running compose stack) — but Testcontainers is the default because it gives every test run a clean state.
- Introduce CI-friendly test output (`--reporter=verbose` for local, `--reporter=junit` ready for CI consumers).

## Capabilities

### New Capabilities

- `testing-framework`: The contract for how the project's tests are organized, how integration tests get their datastores, and what coverage gate exists.

### Modified Capabilities

None — tests observe existing capabilities; they do not change what the service does.

## Impact

- **New files**: `vitest.config.ts`, `vitest.config.integration.ts`, `tests/unit/**/*.test.ts`, `tests/integration/**/*.test.ts`, `tests/integration/fixtures/app.ts`, `tests/integration/fixtures/containers.ts`, `tests/helpers/factory.ts`, `.github/workflows/test.yml` (optional; only if a CI file is in scope for the brief).
- **Modified files**: `package.json` (add dev dependencies and test scripts), `README.md` (document `pnpm test` and Testcontainers prerequisite: Docker daemon running).
- **New dependencies** (dev only): `vitest`, `@vitest/coverage-v8`, `supertest`, `@types/supertest`, `testcontainers`, `@testcontainers/postgresql`, `@testcontainers/redis`.
- **APIs exposed**: None. This change does not touch the HTTP contract.
- **Systems affected**: The developer's Docker daemon (Testcontainers needs it). The repository's CI story (optional).
- **Breaking changes**: None.
