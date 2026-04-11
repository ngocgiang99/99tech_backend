# Verification — step-05-leaderboard-cache-and-rebuild

**Profile**: has_typescript=yes, has_rust=no, needs_integration=yes, needs_deployment=no, needs_coverage=yes
**Scope**: Full — typecheck + lint + build + unit + coverage + integration
**Status**: complete

## Section 1 — Static analysis
- [x] ✅ PASS 1.1 `mise run typecheck` exits 0 (no TypeScript errors across src/ and test/)
- [x] ✅ PASS 1.2 `mise run lint` exits 0 (no ESLint errors; hexagonal boundaries hold for new ports/adapters/controllers from step-05)

## Section 2 — Build
- [x] ✅ PASS 2.1 `mise run build` exits 0 (Nest CLI compiles dist/ cleanly; no missing imports for new files)

## Section 3 — Unit tests
- [x] ✅ PASS 3.1 `mise run test` exits 0 (all unit tests pass — including new tests for leaderboard-types, leaderboard.controller, leaderboard.dto, readiness.service, increment-score.handler)

## Section 4 — Coverage gates
- [x] ✅ PASS 4.1 `mise run test:coverage` exits 0 (global ≥80% lines/branches/functions/statements; src/scoreboard/domain/**/*.ts at 100%)
- [x] ✅ PASS 4.2 New step-05 source files all reach project coverage thresholds (leaderboard-cache.impl.ts, leaderboard-rebuilder.ts, leaderboard-rebuilder.bootstrap.ts, leaderboard.controller.ts, readiness.service.ts, leaderboard-types.ts)

## Section 5 — Integration tests (Testcontainers)
- [x] ✅ PASS 5.1 `mise run test:integration` exits 0 (Postgres + Redis containers start, all integration tests pass)
- [x] ✅ PASS 5.2 `test/integration/leaderboard/leaderboard-cache.test.ts` — upsert+getTop, idempotency, getRank present/absent, tie-break ordering (ADR-16 bit-pack)
- [x] ✅ PASS 5.3 `test/integration/leaderboard/leaderboard-rebuilder.test.ts` — rebuild populates ZSET, top-N cap, lock acquired/released
- [x] ✅ PASS 5.4 `test/integration/leaderboard/leaderboard-controller.test.ts` — cache hit, empty cache fallback, limit validation, JWT-gated (MIN-03)
- [x] ✅ PASS 5.5 `test/integration/persistence/kysely-user-score.repository.test.ts` — outbox row INSERTed inside the same transaction as score_events + user_scores

## Section 6 — OpenSpec validation
- [x] ✅ PASS 6.1 `openspec validate step-05-leaderboard-cache-and-rebuild` exits 0

## Bugs Found

None. All checks passed on the first run; the rebuilder encoding bug (see archived git log) was caught and fixed during /opsx:apply Wave 4 by qa-step05 + fixer-encoding before /opsx_custom:verify ran.

## Final Verdict

**Result**: PASS
**Summary**: 12/12 checks passed, 0 bugs found, 0 fix iterations during /opsx_custom:verify (the GAP-01 encoding-formula bug in the rebuilder was caught and fixed during /opsx:apply itself).

**Gate results**:
- Typecheck: exit 0
- Lint: exit 0
- Build: exit 0
- Unit tests: 168/168 pass (23 suites)
- Coverage: 97.62% stmts / 85.20% branch / 95.52% funcs / 97.87% lines (global ≥80% ✓; src/scoreboard/domain/**/*.ts at 100% ✓)
- Integration tests: 30/30 pass (6 suites, Testcontainers Postgres + Redis, 12.3s)
- OpenSpec validate: valid

**Manual smoke checks deferred** (tasks 14.5–14.7 in tasks.md): require running dev server. Recommended post-archive checklist:
1. POST /v1/scoreboard/credit with valid JWT + action token → response includes non-null `rank` and `topChanged`
2. `curl -H "Authorization: Bearer <jwt>" http://localhost:3000/v1/leaderboard/top?limit=5` → 200 with top-5
3. `curl http://localhost:3000/v1/leaderboard/top` (no JWT) → 401
4. `psql -c "SELECT aggregate_id, event_type, published_at FROM outbox_events ORDER BY id DESC LIMIT 5"` → all rows have published_at IS NULL

**Next steps**: Ready for `/openspec-archive-change`.
