# Improvements — Forward-Looking Notes

This document collects improvements intentionally **out of scope** for the v1 spec but worth capturing so they aren't lost. Each item lists *what*, *why*, and *tradeoff* so the team can prioritise.

---

## Technical Evolution

### I-DAT-02 · Score history retention policy
**What:** Partition `score_events` by month; drop partitions older than N months.
**Why:** Keeps the hot table small and predictable; simple restores. `score_events` grows linearly with write traffic and has no natural cleanup today.
**Tradeoff:** Retain aggregate totals elsewhere before dropping a partition so historical leaderboards remain reconstructable.

### I-DAT-04 · Snapshot-based cold rebuild
**What:** Periodically dump the Redis ZSET to a `leaderboard_snapshots` table.
**Why:** Cold rebuild becomes an `INSERT … SELECT` against the snapshot table instead of an `ORDER BY` scan over all `user_scores`. Meaningful when user count grows past the point where the full scan blows NFR-09's 60-second budget.
**Tradeoff:** Extra storage and a periodic job; the snapshot can drift from truth between dumps, so the rebuild path still reconciles against `user_scores` for final correctness.

---

## Testing

### I-TST-02 · Property-based tests on the domain
**What:** Add `fast-check` properties for `UserScore.credit()` and the value-object invariants (`ScoreDelta`, `UserId`, `ActionId`).
**Why:** The domain layer is pure, deterministic, and dependency-free — exactly the shape where property-based testing outperforms example-based testing per line of test code. Invariants like "totalScore is monotonic", "credit is commutative under distinct actionIds", and "delta out of range always throws" are precisely expressible.
**Tradeoff:** One additional dev dependency; slightly slower test suite; learning curve for anyone unfamiliar with property-based testing.

---

## Deliberately Out of Scope

The following concerns are **not** tracked as improvements for this module because they belong elsewhere in a real production topology:

- **Real authentication hardening** — OAuth flows, MFA, device fingerprinting, CAPTCHA, proof-of-work gating, session revocation. All owned by an upstream auth service; problem6 verifies tokens it does not mint.
- **Transport security** — mTLS between the API and Postgres/Redis/NATS. A deployment-layer concern configured via the cluster's service mesh or sidecar proxy, not something the application code controls.
- **Connection pooling infrastructure** — PgBouncer in transaction mode, HTTP/2 at the load balancer, keep-alive tuning. Deployment-time tuning, not application design.
- **Secret rotation tooling** — dual-secret verification for `INTERNAL_JWT_SECRET`. The existing `ACTION_TOKEN_SECRET_PREV` pattern covers the one rotation surface this module owns.
- **Compliance and data governance** — GDPR deletion, "right to be forgotten", PII scrubbing in logs beyond the header denylist already in place. Platform-wide concerns; this module exposes the hooks but does not implement the policy.
- **Admin tooling** — admin UI for manual score adjustment, abuse review queue, audit dashboard. A separate product surface with its own lifecycle; this module would expose the API endpoints, not own the UI.
- **Fleet-level observability** — SLO burn-rate alerting, tail-based trace sampling, synthetic canary clients, chaos engineering in staging. All operator-configured against a running fleet; this module emits the signals (metrics, structured logs, OTel spans) that those systems consume.
- **CI/CD hardening** — pre-commit hooks, migration dry-runs, load tests in the release pipeline, mutation testing, frozen-OpenAPI contract tests. Build-system concerns; this module ships the test suites and the artifacts, not the pipeline that runs them.
- **Extreme-scale architecture** — multi-region JetStream mirroring, CRDT-backed multi-region writes, write-behind Postgres, distributed singleflight. Meaningful only at traffic scales far beyond the NFR targets this module is designed against.
- **Business / product features** — seasons, multi-leaderboard, friend cohorts, score decay, multi-category leaderboards. Product evolution decisions that belong to a roadmap conversation, not a technical-debt backlog.
