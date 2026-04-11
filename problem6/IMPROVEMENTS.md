# Improvements — Forward-Looking Notes

This document collects improvements intentionally **out of scope** for the v1 spec but worth capturing so they aren't lost. Each item lists *what*, *why*, and *tradeoff* so the team can prioritise.

Each entry carries a risk tag:
- 🟢 **Low-risk** — small, reversible additions.
- 🟡 **Medium** — design decisions deserving their own design doc.
- 🔴 **Significant** — architectural changes; treat as a separate project.

---

## Security Hardening

### I-SEC-01 · Asymmetric action tokens (Ed25519) 🟡
**What:** Replace HMAC-SHA256 with Ed25519 signatures for action tokens.
**Why:** HMAC requires the shared secret on every verifying instance → expanded blast radius on key leak. Ed25519 verification uses a public key while the private key stays on one issuing service, dramatically shrinking the attack surface.
**Tradeoff:** Larger tokens (~64 B sig vs 32 B), slower sign (~100 µs vs ~5 µs); verify is still fast. Requires key-distribution infrastructure.

### I-SEC-02 · Device fingerprint binding 🟡
**What:** Include a client-supplied device fingerprint hash in the JWT and re-check at score time.
**Why:** Mitigates stolen-cookie abuse: a JWT lifted from one device cannot credit from another.
**Tradeoff:** Privacy review; risk of false rejects on legitimate multi-device users.

### I-SEC-03 · Velocity / anomaly detection 🟡
**What:** Streaming z-score (or EWMA) over `score_events.delta` per user; mark outliers for manual review.
**Why:** Catches abuse patterns HMAC can't see — e.g. someone automating legitimate actions at superhuman rates.
**Tradeoff:** False positives; requires a review queue and admin tooling (see I-BIZ-04).

### I-SEC-04 · Zero-downtime secret rotation 🟢
**What:** Support two valid action-token secrets during a rotation window; verify against both.
**Why:** Enables scheduled and emergency secret rotation without user impact.
**Tradeoff:** Slight complexity in `HmacActionTokenVerifier`; track cutover in Redis.

### I-SEC-05 · mTLS between API and datastores 🟢
**What:** Mutual TLS on the API ↔ Redis and API ↔ Postgres links.
**Why:** Defence-in-depth against lateral movement inside the cluster.
**Tradeoff:** Operational cost of cert rotation; negligible perf impact on localhost-grade latencies.

### I-SEC-06 · Request signing for service-to-service traffic 🟡
**What:** If other internal services later trigger score credits, they should sign requests with an asymmetric key rather than a shared bearer token.
**Why:** Keeps the trust boundary explicit between user-facing and service-facing traffic.

### I-SEC-07 · CAPTCHA / proof-of-work for new accounts 🟡
**What:** Gate first-N score credits behind a light proof-of-work challenge.
**Why:** Slows sybil-style attacks where the adversary provisions thousands of throwaway accounts.

---

## Scalability & Performance

### I-SCL-01 · Multi-region JetStream mirroring 🟡
**What:** Mirror (or *source*) the `SCOREBOARD` stream from a primary region to secondary regions using JetStream's `mirror`/`sources` configuration. Each region runs its own API + consumer set.
**Why:** Delivers sub-second live updates to globally distributed clients without cross-region publish latency; survives regional outages because secondary regions keep serving live updates from their local mirror.
**Tradeoff:** Extra storage footprint per region; mirror lag during partitions (eventually-consistent live view); operational complexity of a NATS supercluster + leafnodes topology.

### I-SCL-01b · Durable pull consumers for analytics 🟢
**What:** Add a durable pull consumer on the `SCOREBOARD` stream filtered on `scoreboard.score.credited` to feed an analytics sink (ClickHouse, BigQuery, etc.).
**Why:** Every score credit is already persisted in the JetStream retention window (1 month in the MVP config); a downstream consumer can backfill up to a month on startup and then stream live — no changes to the publisher, no schema migrations.
**Tradeoff:** Introduces a new consumer lag to monitor; the consumer must ack every message so the stream can age messages out against its limits. The month-long MVP retention is plenty for most analytics use cases — no further retention bump needed.

### I-SCL-02b · Tune JetStream retention post-MVP 🟢
**What:** Re-evaluate `max_age`, `max_msgs`, and `max_bytes` on the `SCOREBOARD` stream once real traffic and incident data exist.
**Why:** The MVP values (30 d / 1 M msgs / 1 GB) are deliberately generous to make debugging trivial. In steady state the live-update channel only needs minutes of retention for replay; tightening reduces disk cost and speeds up recovery scenarios.
**Tradeoff:** Shorter retention hampers post-hoc debugging and late-binding analytics; any tightening should follow an explicit review of publish rate, consumer count, and incident frequency.

### I-SCL-02 · Leaderboard partitioning 🟡
**What:** Add `daily`, `weekly`, `season`, and `region` leaderboards as separate ZSETs.
**Why:** The all-time global leaderboard gets boring fast; product usually wants multiple slices.
**Tradeoff:** N× writes per score event (one `ZADD` per slice). Amortise via the fan-out worker.

### I-SCL-03 · Write-behind to Postgres 🔴
**What:** Treat Redis ZSET as source of truth for current state; flush to Postgres as a periodic audit log.
**Why:** Decouples Postgres from the hot write path → multiplies the write ceiling.
**Tradeoff:** Durability risk during Redis failure windows; a reconciliation job is mandatory.

### I-SCL-04 · Global multi-region with CRDTs 🔴
**What:** Host an API + Redis per region; merge leaderboards via a G-Counter-backed CRDT.
**Why:** Eliminates cross-region write latency; survives regional outages.
**Tradeoff:** Eventual consistency — top-10 briefly diverges across regions under partition. Substantial engineering.

### I-SCL-05 · PgBouncer in transaction mode 🟢
**What:** Place PgBouncer in front of Postgres.
**Why:** Node.js + many short transactions exhaust server-side connections; bouncer collapses them into a small pool.
**Tradeoff:** Transaction mode disables session-scoped features; manageable with `pg` client settings.

### I-SCL-06 · HTTP/2 at the LB, keep-alive to backends 🟢
**What:** Terminate HTTP/2 at the load balancer; persistent connections upstream.
**Why:** Cheaper SSE: multiple streams can share one TCP/TLS connection per client.

### I-SCL-07 · Adaptive coalescing window 🟢
**What:** Size the outbox publisher's coalescing window dynamically based on write rate (50–500 ms).
**Why:** Low traffic → snappy updates. High traffic → fewer fan-out messages. Best of both worlds.

---

## Data & Consistency

### I-DAT-01 · CDC via Debezium 🟡
**What:** Stream `score_events` changes to a Kafka topic via Debezium.
**Why:** Feeds downstream analytics, search, ML features without touching the API code path.
**Tradeoff:** Operational footprint of Kafka + Connect.

### I-DAT-02 · Score history retention policy 🟢
**What:** Partition `score_events` by month; drop partitions older than N months.
**Why:** Keeps the hot table small; simple restores.
**Tradeoff:** Retain aggregate totals elsewhere before dropping.

### I-DAT-03 · GDPR deletion ("right to be forgotten") 🟡
**What:** Tombstone a user: delete `user_scores` row, pseudonymise `score_events`.
**Why:** Legal requirement in many jurisdictions.
**Tradeoff:** Destroys audit-trail integrity; design a pseudonymisation scheme that still supports fraud investigation.

### I-DAT-04 · Snapshot-based cold rebuild 🟢
**What:** Periodically dump the Redis ZSET to a `leaderboard_snapshots` table.
**Why:** Cold rebuild becomes an `INSERT … SELECT` instead of an `ORDER BY` scan over all `user_scores`.

---

## Business Features

### I-BIZ-01 · Seasons / resettable periods 🟡
**What:** First-class season concept with start/end; leaderboard resets at rollover.
**Why:** Standard product pattern; drives engagement and replay.
**Tradeoff:** Scheduling, historical snapshots, plus an "all-time" archive.

### I-BIZ-02 · Multi-leaderboard support 🟡
**What:** Multiple leaderboards per app/category (see I-SCL-02).

### I-BIZ-03 · Friend / cohort leaderboards 🟡
**What:** Per-user view limited to their friends' scores.
**Why:** High engagement lever, low infra cost.
**Tradeoff:** Requires a friend graph and fan-out on friendship changes.

### I-BIZ-04 · Admin score adjustment with audit trail 🟢
**What:** Protected admin endpoint to credit/debit with mandatory reason + reviewer.
**Why:** Customer support inevitably needs this; ad-hoc DB edits are worse.

### I-BIZ-05 · Score decay 🟡
**What:** Exponential time-decay of scores so inactive users drop off.
**Why:** Keeps the leaderboard fresh; punishes hoarding.
**Tradeoff:** Requires a periodic recompute job over all users.

---

## Observability & Operations

### I-OBS-01 · Structured error taxonomy as metrics 🟢
**What:** Every error code becomes a metric label; alert on the codes that matter.

### I-OBS-02 · SLO-burn-rate alerting 🟢
**What:** Burn-rate alerts against the NFR SLOs, not static thresholds.
**Why:** Fewer false pages; alerts align with user impact.

### I-OBS-03 · Synthetic canary client 🟢
**What:** A tiny service that continually issues tokens, credits scores, and verifies SSE updates.
**Why:** Catches regressions the unit tests can't (LB misconfig, JWKS outage, cert rotation fumbles).

### I-OBS-04 · Chaos engineering in staging 🟡
**What:** Scheduled experiments — kill Redis primary, partition Postgres, drop 1% of packets.
**Why:** Continuously validates the recovery claims in NFR-09.

### I-OBS-05 · Tail-based 100% sampling for errors 🟢
**What:** Always retain traces for 4xx/5xx responses even when the base sample rate is low.
**Why:** You lose the traces you need most without this.

---

## Developer Experience

### I-DX-01 · OpenAPI + generated typed client 🟢
**What:** Emit an OpenAPI 3.1 document from the controllers; publish a typed client to an internal registry.
**Why:** Removes drift between spec, server, and frontend consumers.

### I-DX-02 · `mise run dev:fuzz` synthetic load 🟢
**What:** Background task that fires realistic score increments during local dev.
**Why:** Makes local SSE development actually interactive.

### I-DX-03 · Pre-commit via `lefthook` 🟢
**What:** Run lint, typecheck, and affected tests before every commit.

### I-DX-04 · Migration dry-run in CI 🟢
**What:** Apply pending migrations to a throwaway DB in CI; fail on `kysely migrate:latest` error.

---

## Testing & Quality

### I-TST-01 · Contract tests against a frozen OpenAPI 🟢
**What:** Snapshot the OpenAPI document; break the build on unintended changes.

### I-TST-02 · Property-based tests on the domain 🟡
**What:** `fast-check` properties for `UserScore.credit()` invariants.
**Why:** Pure domain logic → property tests are exceptionally high ROI.

### I-TST-03 · Mutation testing 🟡
**What:** Run `stryker-js` on the domain layer.
**Why:** Validates that tests actually catch regressions, not just hit lines.

### I-TST-04 · Load test in the release pipeline 🟡
**What:** `mise run test:load` executes in a pre-prod env before every release; fails on NFR regression.

---

## Known Gaps in This Spec

These are things the v1 spec does **not** yet answer and need a decision before implementation begins:

1. **JWT refresh flow** — we assume JWTs are short-lived; who refreshes them, and how does SSE survive a mid-stream refresh?
2. **User display name resolution** — `/leaderboard/top` returns `displayName`; is that denormalised into `user_scores`, or fetched from the Identity service on read?
3. **Offline-first mobile clients** — if mobile apps credit scores while offline, we need a conflict-resolution protocol.
4. **Abuse review queue** — T5/T6 threats are caught but not triaged; where do flagged events go?
5. **Admin UI** — I-BIZ-04 implies one; scope and ownership are unassigned.
6. **Score number format** — scores are integers in v1. If fractional scores (XP with multipliers) are ever needed, pick a fixed-point representation early.
7. **Backpressure under a thundering-herd** — what should `/scores:increment` return when the outbox lags by > 5 s? 503? Accept and queue? Needs a product call.
8. **Public exposure of leaderboard** — is `/leaderboard/top` public, or auth-gated? The spec assumes public read, but that may leak user IDs.
