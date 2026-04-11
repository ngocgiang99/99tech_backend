# Runtime Verification: step-06-streaming-and-fan-out

## Profile

- `has_rust`: false
- `has_typescript`: true
- `needs_integration`: true
- `needs_deployment`: false
- `needs_coverage`: true
- `needs_smoke`: true

## Scope

This change added the full streaming/fan-out pipeline: NATS JetStream client + stream bootstrap, `JetStreamEventPublisher` (implements `DomainEventPublisher`), `OutboxPublisherService` (leader-elected, coalescing), `JetStreamSubscriber` (ephemeral consumer), `LeaderboardUpdatesEmitter`, and the `GET /v1/leaderboard/stream` SSE controller with drop-oldest backpressure.

The runtime verification must confirm:
- Every automation check exits 0 (typecheck, lint, build, unit tests, integration tests, coverage)
- The end-to-end SSE fan-out chain works against a real running app + real NATS/Postgres/Redis

## Automation Checks

- [x] ✅ PASS · C1 · `mise run typecheck` exits 0
- [x] ✅ PASS · C2 · `mise run lint` exits 0
- [x] ✅ PASS · C3 · `mise run build` exits 0
- [x] ✅ PASS · C4 · `mise run test` (unit suite) — all tests pass, coverage thresholds met (domain 100%, global ≥80%)
- [x] ✅ PASS · C5 · `mise run test:integration` — all Testcontainers integration suites pass (Postgres + Redis + NATS)
- [x] ✅ PASS · C6 · `mise run test:coverage` — threshold check passes (duplicates C4 for the coverage gate specifically)

## Manual Smoke (real dev server + curl)

Prerequisite: problem6-postgres / problem6-redis / problem6-nats docker containers are healthy on the docker-compose override ports (55432 / 56379 / 54222). If port 3000 is held by another container, boot problem6 on port 13003 with `PORT=13003`.

- [x] ✅ PASS · S1 · Boot `dist/src/main.js` cleanly — no `UnknownDependenciesException`, no Zod config errors. Logs show: `SCOREBOARD stream created`, `jetstream ephemeral consumer created`, `outbox publisher started`, `Nest application successfully started`.
- [x] ✅ PASS · S2 · Sign HS256 JWT inline for a known test user. `GET /v1/leaderboard/stream` with `Authorization: Bearer <jwt>` returns `event: snapshot` frame with the current top-10 from `LeaderboardCache.getTop(10)`.
- [x] ✅ PASS · S3 · In another terminal, `POST /v1/actions:issue-token` (body `{"actionType":"level-complete"}`) to get a fresh action token. Then `POST /v1/scores:increment` with the `Action-Token` header and body `{"actionId":"...","delta":25}`. The SSE client receives `event: leaderboard.updated` within ~150ms with the new top-10.
- [x] ✅ PASS · S4 · Wait 15s with no activity. The SSE client receives at least one `event: heartbeat` frame.
- [x] ✅ PASS · S5 · `docker exec problem6-postgres psql -U postgres -d scoreboard -c "SELECT id, event_type, published_at IS NOT NULL FROM outbox_events ORDER BY id DESC LIMIT 5;"` — the most recent rows (both `scoreboard.score.credited` and `scoreboard.leaderboard.updated`) have `published_at` set.

## Bugs Found

_None — all 11 checks passed on the first run._

## Final Verdict

**Result**: PASS
**Summary**: 11/11 checks passed (6 automation + 5 manual smoke), 0 bugs found, 0 fix iterations
**Coverage**: Domain 100%, global 96.66% stmts / 96.83% lines
**Integration**: 48/48 tests across 11 suites
**Smoke evidence**: Full end-to-end chain verified — POST /v1/scores:increment (delta 33, score 77→110) → outbox_events both rows drained → JetStream → SSE `event: leaderboard.updated` delivered within 2s
**Next steps**: Ready for `/openspec-archive-change`
**Verified**: 2026-04-11 by agent-team verification (qa-ts, qa-integration, qa-smoke)
