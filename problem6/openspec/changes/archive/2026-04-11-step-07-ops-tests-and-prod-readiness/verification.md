# Verification — step-07-ops-tests-and-prod-readiness

## Profile flags
- has_rust: false
- has_typescript: true
- needs_integration: true
- needs_deployment: true (Docker build + SPOF smoke)
- needs_coverage: true
- needs_k6: false (deferred — manual pre-release)

## Automation checks (qa-ts)

- [x] ✅ PASS — C1. Type check — `cd problem6 && pnpm typecheck` exits 0
- [x] ✅ PASS — C2. Lint — `cd problem6 && pnpm lint` exits 0
- [x] ✅ PASS — C3. Build — `cd problem6 && pnpm build` exits 0
- [x] ✅ PASS — C4. Unit tests — `cd problem6 && pnpm jest --config jest.unit.config.ts` passes (expect ~199 tests, 25 suites) — 199 tests, 25 suites
- [x] ✅ PASS — C5. Integration tests — `cd problem6 && pnpm jest --config jest.integration.config.ts --runInBand` passes (expect 50 tests, 13 suites) — 50 tests, 13 suites, 66s
- [x] ✅ PASS — C6. Coverage thresholds — `cd problem6 && pnpm jest --config jest.unit.config.ts --coverage` — no "Jest: coverage threshold not met" error — all met
- [x] ✅ PASS — C7. Benchmark (MIN-02) — `cd problem6 && pnpm tsx scripts/benchmark-rebuild.ts --rows 100000` — elapsedMs < 1000 (durationOk=true, exit 0) — 368ms / 100k rows
- [x] ✅ PASS — C8. OpenSpec validate — `openspec validate step-07-ops-tests-and-prod-readiness` — "valid"

## Deployment smoke (qa-deploy)

- [x] ✅ PASS — D1. Docker build — `cd problem6 && mise run docker:build` exits 0 and image `problem6/scoreboard-api:dev` exists — 241MB image
- [x] ✅ PASS — D2. Container boots — run image against `problem6_default` network on host port 3001, `docker logs` shows "Nest application successfully started" listening on :3000, no FATAL errors — healthy on port 3001
- [x] ✅ PASS — D3. `whoami` inside container → `app` (non-root)
- [x] ✅ PASS — D4. Both image tags exist — `problem6/scoreboard-api:dev` AND `problem6/scoreboard-api:v1.0.0-rc1`

## Manual smoke (qa-smoke, against running Docker container)

- [x] ✅ PASS — S1. `curl http://localhost:3001/health` → 200 `{"status":"ok"}`
- [x] ✅ PASS — S2. `curl http://localhost:3001/ready` → 200 with all 4 checks up (postgres, redis, nats, leaderboard)
- [x] ✅ PASS — S3. `curl http://localhost:3001/metrics` → 200 Prometheus text exposition (includes `scoreboard_http_requests_total`)
- [x] ✅ PASS — S4. SPOF fail-CLOSED cycle — baseline issue-token 200 → stop Redis → /ready 503 redis:down → issue-token 503 TEMPORARILY_UNAVAILABLE → restart Redis → /ready 200 → issue-token 200 — all 6 sub-steps a/b/c/d/e/f PASS
- [x] ✅ PASS — S5. Artifact sanity — `problem6/docs/runbooks/redis-spof-degraded.md` exists; `infra/helm/Chart.yaml`, `infra/k8s/deployment.yaml`, `infra/terraform/main.tf`, `infra/README.md` all exist; `test/load/scoreboard.k6.ts` and `scripts/benchmark-rebuild.ts` exist — all 12 files exist

## Bugs Found
_(none — no failures in Wave 1)_

## Status
`complete`

## Final Verdict
**Result**: PASS
**Summary**: 17/17 checks passed, 0 bugs found, 0 fix iterations
**Profile**: has_typescript=true, needs_integration=true, needs_deployment=true, needs_coverage=true, has_rust=false
**Agents used**: qa-ts (sonnet), qa-deploy (sonnet), qa-smoke (sonnet), haiku-pool (haiku)
**Executed waves**: Wave 0 setup → Wave 1 verify → FINALIZE (no fixers needed)
**Key verifications**:
- SPOF fail-CLOSED cycle verified end-to-end: baseline 200 → Redis down 503 TEMPORARILY_UNAVAILABLE → recovery 200 within 1s (GAP-03)
- MIN-02 cold-rebuild budget met: 100k rows in 368ms (< 1s, extrapolates to well under 60s for 10M)
- Coverage thresholds all met after Lead's inline fix during /opsx:apply Wave 3 (7 new HealthController tests)
- All deployment artifacts present (runbook, Helm/k8s/Terraform stubs, k6 load test, benchmark script, integration tests, E2E test)
**Deferred (not run in this verify)**:
- k6 load test --quick run against local stack (manual pre-release verification)
- 10M benchmark run (~5min seed time, manual pre-release per Decision 5)
**Next steps**: Ready for `/openspec-archive-change`
