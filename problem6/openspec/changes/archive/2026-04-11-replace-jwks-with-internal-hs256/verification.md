# Verification — replace-jwks-with-internal-hs256

**Profile**: has_typescript=yes, has_rust=no, needs_integration=yes, needs_deployment=no, needs_coverage=yes
**Scope**: Full — typecheck + lint + build + unit + coverage + integration
**Status**: complete

## Section 1 — Static analysis
- [x] ✅ PASS 1.1 `mise run typecheck` exits 0 (no TypeScript errors after JWKS removal + JwtGuard rewrite)
- [x] ✅ PASS 1.2 `mise run lint` exits 0 (hexagonal boundaries hold; no orphan imports of deleted JwksCache)

## Section 2 — Build
- [x] ✅ PASS 2.1 `mise run build` exits 0 (Nest CLI compiles dist/ cleanly with the new JwtGuard)

## Section 3 — Unit tests
- [x] ✅ PASS 3.1 `mise run test` exits 0 (167 tests, including the rewritten jwt.guard.test.ts and the pino redaction test for INTERNAL_JWT_SECRET)
- [x] ✅ PASS 3.2 jwt.guard.test.ts has 100% line coverage (8+ scenarios: valid HS256, missing header, wrong secret, expired, alg=none, alg=RS256, tampered, iss/aud ignored)

## Section 4 — Coverage gates
- [x] ✅ PASS 4.1 `mise run test:coverage` exits 0 (global ≥80%; src/scoreboard/domain/**/*.ts at 100%)
- [x] ✅ PASS 4.2 collectCoverageFrom no longer references the deleted jwks-cache.ts

## Section 5 — Integration tests (Testcontainers)
- [x] ✅ PASS 5.1 `mise run test:integration` exits 0 (30 tests, all passing with HS256 JWT fixtures)
- [x] ✅ PASS 5.2 `test/integration/leaderboard/leaderboard-controller.test.ts` (JWT-gated endpoint) passes with the new HS256 sign helper

## Section 6 — OpenSpec validation
- [x] ✅ PASS 6.1 `openspec validate replace-jwks-with-internal-hs256` exits 0

## Section 7 — Cleanup verification
- [x] ✅ PASS 7.1 No remaining references to `JwksCache`, `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` anywhere in src/, test/, scripts/ (grep guard)
- [x] ✅ PASS 7.2 `scripts/smoke-bootstrap.mjs` is gone
- [x] ✅ PASS 7.3 `src/scoreboard/infrastructure/auth/jwks-cache.ts` and `test/unit/auth/jwks-cache.test.ts` are gone
- [x] ✅ PASS 7.4 TODO breadcrumb (`INTERNAL_JWT_SECRET_PREV before production release`) is present in jwt.guard.ts

## Bugs Found

None. All 8 checks passed on the first run with zero fix iterations. impl-jwt's first-pass implementation was clean — no regressions, no missing cleanup, no orphan references.

## Final Verdict

**Result**: PASS
**Summary**: 8/8 checks passed, 0 bugs found, 0 fix iterations.

**Gate results**:
- Typecheck: exit 0
- Lint: exit 0
- Build: exit 0
- Unit tests: 167/167 pass (22 suites)
- Coverage: 96.73% stmts / 85.11% branch / 93.84% funcs / 96.92% lines (global ≥80% ✓; src/scoreboard/domain/**/*.ts at 100% ✓)
- Integration tests: 30/30 pass (6 suites, Testcontainers Postgres + Redis, 14.8s)
- OpenSpec validate: valid
- Cleanup grep: all 5 sub-checks clean (JwksCache/JWKS_URL/JWT_ISSUER/JWT_AUDIENCE not found anywhere; smoke-bootstrap.mjs gone; jwks-cache.ts and jwks-cache.test.ts gone; TODO breadcrumb present in jwt.guard.ts:12)

**Implementation note**: This was a clean refactor — net ~200 LOC removed, ~50 added, zero behavioral regressions. The TODO breadcrumb in jwt.guard.ts:12 is the marker for re-introducing INTERNAL_JWT_SECRET_PREV when the project moves toward production.

**Next steps**: Ready for `/openspec-archive-change`.
