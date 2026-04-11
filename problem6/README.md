# Scoreboard Module — Backend Specification

**Document type:** Module Specification (for backend engineering implementation)
**Status:** Draft v1.0
**Owner:** Platform Backend
**Last updated:** 2026-04-11

> **Audience:** Backend engineers implementing this module.
> **Scope:** A scoreboard service that ranks the top 10 users by score, accepts authenticated score-increment requests triggered by user actions, and pushes live updates to connected clients. This document is the source of truth for implementers; it does **not** describe the action itself — only what happens to the user's score when an action completes.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Functional Requirements](#2-functional-requirements)
3. [Non-Functional Requirements](#3-non-functional-requirements)
4. [Architecture](#4-architecture)
5. [Domain Model](#5-domain-model)
6. [Persistence & Data Model](#6-persistence--data-model)
7. [API Contracts](#7-api-contracts)
8. [Live Updates](#8-live-updates)
9. [Authentication & Anti-Abuse](#9-authentication--anti-abuse)
10. [Scaling to 10k Concurrent Users](#10-scaling-to-10k-concurrent-users)
11. [DDD Project Layout](#11-ddd-project-layout)
12. [Observability](#12-observability)
13. [Local Development](#13-local-development)
14. [CI/CD & Docker](#14-cicd--docker)
15. [Testing Strategy](#15-testing-strategy)
16. [Rollout & Operations](#16-rollout--operations)
17. [Appendices](#17-appendices)

**Related documents**
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Mermaid component, sequence, and state diagrams
- [`IMPROVEMENTS.md`](./IMPROVEMENTS.md) — Forward-looking enhancements and known gaps

---

## 1. Overview

### 1.1 Purpose

Provide an authoritative, low-latency leaderboard of the top 10 users ranked by score, with live push of ranking changes to connected browser clients. Score increments are **server-authoritative** and cryptographically bound to the originating user action to prevent unauthorized score inflation.

### 1.2 In Scope

- REST endpoint to increment a user's score in response to a completed action
- REST endpoint to fetch the current top-10 snapshot
- Server-Sent Events (SSE) endpoint to stream live top-10 changes
- Authentication of the requesting user and authorization of the specific score-bearing action
- Idempotency, rate limiting, and basic abuse prevention
- Persistence to Postgres (durable) and Redis (cache + fan-out)

### 1.3 Out of Scope

- The user-facing action itself (what the user "does" to earn a score). This module only updates scores when informed that an action completed.
- User registration, profile management, session issuance — assumed to live in an existing Identity service that issues JWTs.
- Payment, rewards, season lifecycle — see [`IMPROVEMENTS.md`](./IMPROVEMENTS.md).
- Frontend implementation of the score board UI.

### 1.4 Key Constraints

- All code isolated in `./problem6/`
- DDD (hexagonal ports & adapters) architecture
- Postgres for source-of-truth storage
- Redis for caching, idempotency, and rate limiting
- **NATS** as the async message broker (live-update fan-out, domain events)
- Tool management via `mise`; `mise run <task>` is the canonical interface (not `npm run`)
- Multi-stage `Dockerfile` suitable for CI/CD
- `docker-compose.yml` provisioning all dependencies for local development
- Support **10,000 concurrent connected users** with sub-second live-update latency
- **Unit tests + integration tests (via Testcontainers) with ≥ 80 % coverage**, enforced in CI

---

## 2. Functional Requirements

| ID | Requirement |
|----|-------------|
| **FR-01** | Authenticated users can submit a *score-increment request* after completing an action; the server validates, persists, and reflects the new score. |
| **FR-02** | Each score-increment request must be **idempotent**: a retry with the same `actionId` must not double-credit. |
| **FR-03** | Unauthenticated or unauthorized requests must be rejected with `401`/`403`; no score changes occur. |
| **FR-04** | Score-increment requests whose **action token** is missing, forged, expired, or already consumed must be rejected with `403`. |
| **FR-05** | The system exposes a read endpoint returning the current top-10 users by descending score. |
| **FR-06** | The system exposes a streaming endpoint that pushes the current top-10 to connected clients whenever it changes, within ≤ 1 second of the change being committed. |
| **FR-07** | Ties are broken by earliest `last_updated_at` (earlier climbers rank higher). |
| **FR-08** | All score mutations are recorded in an append-only audit log (`score_events`) for investigation and reconciliation. |
| **FR-09** | The service must gracefully reject score deltas outside an allowed range (e.g., `1 ≤ delta ≤ 100` — configurable per action type). |

---

## 3. Non-Functional Requirements

| ID | Category | Requirement | Measurement |
|----|----------|-------------|-------------|
| **NFR-01** | Scale | Support 10,000 concurrently connected SSE users. | Load test with `k6` or `artillery`. |
| **NFR-02** | Throughput | Sustain ≥ 1,500 score increments / sec. | `POST /v1/scores:increment` p99 < 150 ms under load. |
| **NFR-03** | Latency | Top-10 change → all connected clients notified in ≤ 1,000 ms at p95. | End-to-end probe from writer → SSE receiver. |
| **NFR-04** | Availability | 99.9 % monthly in single-AZ deployment; tolerate one API instance loss with no user-visible impact. | Kubernetes `PodDisruptionBudget` + health checks. |
| **NFR-05** | Security | All write endpoints authenticated (JWT) and action-authorized (HMAC action token). | Security review + negative tests. |
| **NFR-06** | Durability | Zero lost score events after 200 ms of commit acknowledgement. | Outbox pattern + `fsync` semantics. |
| **NFR-07** | Maintainability | DDD boundaries enforced by `eslint-plugin-boundaries` (or `dependency-cruiser`). | CI lint gate. |
| **NFR-08** | Observability | RED metrics per endpoint, structured JSON logs, OpenTelemetry traces. | Prometheus + Loki + Tempo (or equivalent). |
| **NFR-09** | Recoverability | Full leaderboard state reconstructible from Postgres within 60 s after Redis failure. | Chaos drill: flush Redis, measure cold-rebuild. |
| **NFR-10** | Portability | Single OCI image; deployable to any container runtime. | `docker run` + Kubernetes manifests. |
| **NFR-11** | Quality | Unit tests for all domain + application logic; integration tests (Testcontainers, real Postgres/Redis/NATS) for all infrastructure adapters; overall **line + branch coverage ≥ 80 %**. | Jest `--coverageThreshold`; CI build fails below threshold. |

---

## 4. Architecture

### 4.1 Stack Decisions

| Layer | Choice | Rationale |
|------|--------|-----------|
| Language / runtime | **Node.js 22 LTS + TypeScript 5** | Event-loop concurrency fits SSE fan-out; TS provides type safety for DDD. |
| HTTP framework | **NestJS 11 (Fastify adapter)** | NestJS modules map cleanly to bounded contexts; Fastify is ~2× Express throughput and has first-class streaming. NestJS 11 brings native ESM, decorator refinements, and improved streaming primitives vs NestJS 10. |
| Query builder | **Kysely 0.27** | Type-safe SQL builder with zero ORM runtime; explicit, predictable SQL; tiny footprint. |
| Migrations / codegen | **`kysely-ctl` + `kysely-codegen`** | TypeScript migration files run via CLI; DB schema → TypeScript type generation keeps `src/database/types.generated.ts` in sync. |
| Cache / counters | **Redis 7 (ioredis)** | ZSET for O(log N) leaderboard, SETNX for idempotency, token-bucket rate limiting. |
| Async messaging + event retention | **NATS JetStream 2.10** (`nats` client) | Durable persistent streams with configurable retention and `Nats-Msg-Id` dedup window. Sub-ms fan-out, cluster-native, subject-based routing. Ephemeral push consumers per API instance for SSE fan-out; short-window replay lets reconnecting subscribers catch up without touching the DB. |
| Database | **Postgres 16** | ACID, strong indexing, read-replica scaling. |
| Package manager | **pnpm 9** | Fast, disk-efficient, stable for monorepos. |
| Task runner | **mise** | Replaces `npm run`; also manages Node & pnpm versions. |
| Testing | **Jest + supertest + Testcontainers** | Real Postgres, Redis, and NATS in integration tests; ≥ 80 % coverage enforced by Jest `--coverageThreshold` in CI. |

### 4.2 High-Level Topology

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for full Mermaid diagrams. Summary:

```
Client (Browser)
     │ HTTPS (REST + SSE)
     ▼
Load Balancer (L7, sticky sessions for /stream)
     │
     ├──► API Instance 1 ─┐       ┌─► Postgres Primary
     ├──► API Instance 2 ─┼──────►│     + read replicas
     └──► API Instance 3 ─┘       ├─► Redis  (ZSET | SETNX | rate-limit)
                                  └─► NATS   (subject: leaderboard.updates)
```

### 4.3 Architectural Style

- **Hexagonal / Ports & Adapters** inside each bounded context.
- **DDD tactical patterns**: aggregate, entity, value object, domain event, domain service, repository port.
- **CQRS-lite**: commands and queries routed through separate handlers but share one store. Upgradeable to full CQRS if read volume warrants.
- **Outbox pattern + JetStream dedup**: domain events persisted atomically with state changes, then published asynchronously to a **NATS JetStream** stream with header `Nats-Msg-Id = outbox.id`. The Postgres outbox guarantees no lost events on crash; JetStream's dedup window (2 min) makes the publisher safely retryable; the stream's retention policy provides short-window replay for reconnecting subscribers.

### 4.4 Request Lifecycle (Write Path)

1. Client `POST /v1/scores:increment` with `Authorization: Bearer <jwt>` and `actionToken` in body.
2. **Auth guard** verifies JWT signature, extracts `userId`.
3. **Action-token guard** verifies HMAC, checks `exp`, rejects if bound `userId` mismatches.
4. **Idempotency guard** consumes `actionId` via Redis `SET NX EX` — duplicate requests short-circuit.
5. **Rate limiter** checks per-user token bucket in Redis — rejects with `429` if exhausted.
6. `IncrementScoreHandler` opens a Postgres transaction:
    a. Insert into `score_events` (audit)
    b. Upsert `user_scores.total_score += delta, updated_at = now()`
    c. Insert into `outbox_events` with the new score snapshot
    d. Commit
7. Outbox publisher (background worker) picks the row, `ZADD leaderboard:global`, checks whether the top-10 changed, publishes the new snapshot to the **JetStream stream `SCOREBOARD`** on subject `scoreboard.leaderboard.updated` with header `Nats-Msg-Id: <outbox.id>` (idempotent via the 2-min dedup window), then marks the outbox row sent.
8. Every API instance creates an **ephemeral push consumer** on the `SCOREBOARD` stream (filter subject `scoreboard.leaderboard.updated`) at boot; JetStream pushes each message to every instance, which fans it out to its locally connected SSE clients and then acks.

---

## 5. Domain Model

### 5.1 Bounded Context

**Scoreboard** — a single bounded context responsible for the lifecycle and ranking of user scores.

### 5.2 Ubiquitous Language

| Term | Definition |
|------|-----------|
| **User** | An authenticated principal identified by `userId`. Owned by the Identity context; referenced here by ID only. |
| **Action** | An opaque activity the user performs; its content is irrelevant to this module. Identified by `actionId`. |
| **Score Event** | An immutable, append-only record of a score change. |
| **User Score** | The *current* cumulative score of a single user — a projection of all their score events. |
| **Leaderboard** | The ordered collection of user scores; the public-facing top-10 slice is the *primary read model*. |
| **Action Token** | A short-lived, HMAC-signed capability granting the bearer the right to credit exactly one score event. |

### 5.3 Aggregates

- **UserScore** (aggregate root)
    - Identity: `userId`
    - Invariants:
        - `totalScore >= 0`
        - `totalScore` is the sum of all `ScoreEvent.delta` for this user (enforced by transactional update, not re-computed on every write)
        - `updatedAt` is monotonically non-decreasing
    - Commands: `credit(actionId, delta, occurredAt)`
    - Emits: `ScoreCredited` domain event

- **ScoreEvent** (entity within UserScore, persisted as its own row for auditability)
    - Fields: `id`, `userId`, `actionId` (unique), `delta`, `createdAt`
    - Invariant: `actionId` globally unique → enforces idempotency at the storage layer as defence-in-depth

### 5.4 Value Objects

| VO | Shape | Validation |
|----|-------|-----------|
| `UserId` | UUID v4 | Format check |
| `ActionId` | UUID v4 | Format check |
| `Score` | non-negative integer | `>= 0`, `<= 2^53 - 1` |
| `ScoreDelta` | integer | `1 ≤ delta ≤ MAX_DELTA` (config) |

### 5.5 Domain Events

| Event | Payload | Emitted When |
|-------|---------|--------------|
| `ScoreCredited` | `{ userId, actionId, delta, newTotal, occurredAt }` | `UserScore.credit()` succeeds |
| `LeaderboardChanged` | `{ previousTop10, newTop10, changedAt }` | Outbox publisher detects top-10 diff |

### 5.6 Invariants Enforced at the Boundary

- No partial updates: score_events insert and user_scores upsert are in the same Postgres transaction.
- Idempotency: (1) Redis SETNX as fast path, (2) Postgres UNIQUE constraint on `score_events(action_id)` as durable fallback.
- Authority: the domain never trusts a score value coming from the client — it only accepts a bounded `delta`, and only after the action token has been verified.

---

## 6. Persistence & Data Model

### 6.1 Postgres Schema

```sql
-- Append-only audit of every credited score event.
CREATE TABLE score_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL,
    action_id    UUID NOT NULL,
    delta        INTEGER NOT NULL CHECK (delta > 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_score_events_action UNIQUE (action_id)
);
CREATE INDEX idx_score_events_user_created ON score_events (user_id, created_at DESC);

-- Current total per user (read-optimised projection).
CREATE TABLE user_scores (
    user_id        UUID PRIMARY KEY,
    total_score    BIGINT NOT NULL DEFAULT 0 CHECK (total_score >= 0),
    last_action_id UUID,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_scores_total_updated
    ON user_scores (total_score DESC, updated_at ASC);

-- Transactional outbox for durable domain-event publication.
CREATE TABLE outbox_events (
    id            BIGSERIAL PRIMARY KEY,
    aggregate_id  UUID NOT NULL,
    event_type    TEXT NOT NULL,
    payload       JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished
    ON outbox_events (id) WHERE published_at IS NULL;
```

**Rationale**
- `score_events` is the source of truth; the business could rebuild `user_scores` from it at any time.
- `user_scores` is the *hot* read projection used for writes (RMW) and leaderboard rebuilds.
- `outbox_events` guarantees at-least-once publication of domain events; consumers must be idempotent.

### 6.2 Redis Key Design

| Key | Type | Purpose | TTL |
|-----|------|---------|-----|
| `leaderboard:global` | ZSET | Member = `userId`, score = `total_score`. Top-10 read via `ZREVRANGE 0 9 WITHSCORES`. | none (persistent) |
| `leaderboard:snapshot` | STRING (JSON) | Cached JSON payload of the current top-10, refreshed by the publisher. | 5 s (soft TTL) |
| `idempotency:action:<actionId>` | STRING | Set via `SET NX EX 86400`. Acts as one-shot replay guard. | 24 h |
| `rate:user:<userId>` | STRING (integer) | Token-bucket counter (with Lua script for atomic decrement + TTL). | 60 s |
| `outbox:lock` | STRING | Leader-election lock for outbox publisher (`SET NX EX`). | 10 s, renewed |

> **Note:** Async messaging and domain-event retention do **not** live in Redis — they travel through the NATS JetStream stream `SCOREBOARD` on subject `scoreboard.leaderboard.updated`. See [§6.5](#65-nats-jetstream-stream-configuration) for the stream spec and [§8](#8-live-updates) for the rationale.

### 6.3 Consistency Model

- **Strong** between `score_events` and `user_scores` (same Postgres transaction).
- **Eventual** between Postgres and Redis ZSET (via outbox publisher, typically < 100 ms).
- **Eventual** between API instances re: connected-client fan-out (via NATS, typically < 5 ms).

### 6.4 Cold-Start / Recovery

On API boot or Redis flush, a `LeaderboardRebuilder` service:

```sql
SELECT user_id, total_score
FROM user_scores
ORDER BY total_score DESC, updated_at ASC
LIMIT 10000;  -- configurable warm-up window
```

… and `ZADD`s them into `leaderboard:global`. Target rebuild time: < 60 s for 10 M users (NFR-09).

### 6.5 NATS JetStream Stream Configuration

All async domain events flow through a single JetStream stream. Retention for the MVP is **deliberately generous (1 month)** — a reconnecting SSE instance only needs the last few minutes, but keeping a month of events makes incident investigation, post-hoc debugging, and late-binding consumer backfill trivial at negligible cost. Retention will be reviewed and likely tightened post-MVP once real traffic data is available (see `IMPROVEMENTS.md → I-SCL-02b`).

**Stream definition**

| Setting | MVP value | Rationale |
|---|---|---|
| `name` | `SCOREBOARD` | One stream per bounded context. |
| `subjects` | `scoreboard.>` | Wildcard catches current and future subjects (`leaderboard.updated`, `score.credited`, …). |
| `storage` | `file` | Durable across broker restarts. |
| `retention` | `limits` | Messages kept until a limit is hit; consumers do not drain the stream. |
| `max_age` | **`720h` (30 days / 1 month)** | MVP: long-window retention for debugging and replay of any in-stream event. |
| `max_msgs` | **`1_000_000`** | Hard ceiling on queued messages; headroom for MVP write rates. |
| `max_bytes` | **`1 GB`** | Secondary cap (~1 KB/msg avg × 1 M msgs). |
| `discard` | `old` | When a cap is hit, drop the oldest (never block writers). |
| `duplicate_window` | `2m` | `Nats-Msg-Id` dedup — idempotent publisher retries. |
| `num_replicas` | **`1` local** / `3` prod | **Local development uses a single-node NATS — R=1, file storage, no replication.** Production uses a 3-node JetStream cluster with R=3 quorum replication. |

**Published subjects**

| Subject | Payload | Publisher | Subscribers |
|---|---|---|---|
| `scoreboard.leaderboard.updated` | `{ entries[], generatedAt }` | `OutboxPublisher` (on top-10 diff) | Every API instance → SSE fan-out (ephemeral push consumers) |
| `scoreboard.score.credited` | `{ userId, actionId, delta, newTotal, occurredAt }` | `OutboxPublisher` (every credit) | Optional: analytics, anomaly detection, achievements (durable pull consumers) |

**Consumer pattern — SSE fan-out**

Each API instance creates an **ephemeral push consumer** at boot:

```ts
await js.consumers.create("SCOREBOARD", {
  filter_subject:      "scoreboard.leaderboard.updated",
  deliver_policy:      DeliverPolicy.New,       // only messages from now onward
  ack_policy:          AckPolicy.Explicit,      // ack after successful SSE write
  ack_wait:            5_000_000_000,           // 5 s redelivery if no ack
  inactive_threshold:  30_000_000_000,          // 30 s → GC on instance death
});
```

- **Ephemeral** because each instance's local SSE clients are a distinct audience — there is no shared work to distribute across consumers.
- **`DeliverPolicy.New`** because reconnecting SSE clients always receive a fresh snapshot from Redis first; they don't need historical replay from NATS.
- **`inactive_threshold`** auto-cleans up consumer state when an instance is killed — no manual teardown needed.

**Stream bootstrap**

On application boot, `StreamBootstrap` calls `jsm.streams.add({...})` — idempotent, safely re-runnable. In production the stream is also managed by infrastructure-as-code (Helm chart, NATS account config, or `nats` CLI in a pre-deploy job) so the app's bootstrap is a safety net, not the source of truth.

---

## 7. API Contracts

Base path: `/v1`
Content type: `application/json; charset=utf-8`
All write endpoints require `Authorization: Bearer <jwt>`.

### 7.1 `POST /v1/actions:issue-token`

Issues a short-lived action token that grants one future score-credit. The client must call this *before* performing the scoring action.

**Request**
```json
{ "actionType": "level-complete" }
```

**Response `200`**
```json
{
  "actionId":   "7c0b2a6e-3a9e-4a4d-b1f2-0c9e2a1d0f1e",
  "actionToken":"eyJhbGciOiJIUzI1NiIsInR...signed",
  "expiresAt":  "2026-04-11T12:34:56.000Z",
  "maxDelta":   10
}
```

**Errors** `401` invalid JWT · `429` rate-limited · `400` unknown actionType.

### 7.2 `POST /v1/scores:increment`

Credits the authenticated user's score. Idempotent by `actionId`.

**Request**
```json
{
  "actionId":    "7c0b2a6e-3a9e-4a4d-b1f2-0c9e2a1d0f1e",
  "actionToken": "eyJhbGciOiJIUzI1NiIsInR...signed",
  "delta":       5
}
```

**Response `200`**
```json
{
  "userId":     "a0e3…",
  "newScore":   142,
  "rank":       7,
  "topChanged": true
}
```

**Response `200` (idempotent replay)**
Same shape; the server returns the *existing* outcome rather than re-crediting.

**Errors**
| Code | Meaning |
|------|---------|
| `400 INVALID_DELTA` | `delta` outside allowed range |
| `401 UNAUTHENTICATED` | missing / invalid JWT |
| `403 INVALID_ACTION_TOKEN` | token forged, expired, or user mismatch |
| `403 ACTION_ALREADY_CONSUMED` | token was used already (race condition loser) |
| `429 RATE_LIMITED` | per-user quota exhausted |
| `503 TEMPORARILY_UNAVAILABLE` | downstream (DB/Redis) degraded |

### 7.3 `GET /v1/leaderboard/top?limit=10`

Returns the current top-N snapshot. `limit` max 100, default 10.

**Response `200`**
```json
{
  "entries": [
    { "userId": "…", "displayName": "Ada",    "score": 9_001, "rank": 1 },
    { "userId": "…", "displayName": "Grace",  "score": 8_772, "rank": 2 }
  ],
  "generatedAt": "2026-04-11T12:34:56.000Z"
}
```

### 7.4 `GET /v1/leaderboard/stream`  *(Server-Sent Events)*

Pushes the top-10 whenever it changes.

**Response headers**
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**Events**
```
event: snapshot
data: {"entries":[…], "generatedAt":"…"}
id: 1712832000123

event: leaderboard.updated
data: {"entries":[…], "generatedAt":"…"}
id: 1712832001456

event: heartbeat
data: "ping"
id: 1712832015000
```

Clients reconnect with `Last-Event-ID`; the server sends a fresh `snapshot` and resumes live updates.

### 7.5 `GET /health`, `GET /ready`, `GET /metrics`

- `/health` — liveness (always `200` if the process is alive).
- `/ready` — readiness; `200` only if Postgres and Redis are reachable.
- `/metrics` — Prometheus text exposition.

### 7.6 Error Envelope

```json
{
  "error": {
    "code":       "INVALID_ACTION_TOKEN",
    "message":    "Action token is expired or already consumed.",
    "requestId":  "01HXXYZ…",
    "hint":       "Request a fresh token from /v1/actions:issue-token."
  }
}
```

---

## 8. Live Updates

### 8.1 Mechanism Choice: Server-Sent Events (SSE)

| Criterion | SSE | WebSocket |
|-----------|-----|-----------|
| Direction | server → client (one-way) | bidirectional |
| Transport | plain HTTP/1.1 or HTTP/2 | upgrade to `ws://` |
| Proxy / LB compatibility | straightforward | often requires config |
| Auto-reconnect (`Last-Event-ID`) | built into browsers | must be hand-rolled |
| Head-of-line blocking under HTTP/2 | none | n/a |
| Client API complexity | `new EventSource(url)` | `new WebSocket(url)` + framing |

The score board is **read-mostly, push-only** from the server. SSE is the simpler, cheaper, and more resilient choice. WebSocket offers no advantage here.

### 8.2 Fan-out Flow

1. `IncrementScoreHandler` commits the transaction (including outbox row).
2. Outbox publisher reads unpublished rows, `ZADD`s to the ZSET, reads the new top-10, compares to the previous snapshot.
3. If the top-10 differs, the publisher calls `js.publish("scoreboard.leaderboard.updated", payload, { msgID: outbox.id })`. The `Nats-Msg-Id` header makes the publish idempotent within the stream's 2-min dedup window — crashes and retries cannot produce duplicate fan-out.
4. Each API instance's ephemeral JetStream push consumer receives the message, writes the SSE frame to each of its locally-connected clients, and acks.
5. Clients receive the `leaderboard.updated` event within ≤ 1 s (NFR-03). If an instance crashes mid-delivery before acking, JetStream redelivers after `ack_wait` to the next live consumer.

### 8.3 Coalescing

If score updates arrive in bursts, publishing every single change risks thundering-herd fan-out. The publisher **coalesces** events within a 100 ms tumbling window: at most 10 `leaderboard.updated` messages / sec per API cluster.

### 8.4 Heartbeat & Reconnect

- `heartbeat` event every 15 s keeps intermediate proxies from idling the connection.
- On disconnect the browser retries automatically after 3 s with `Last-Event-ID`.
- The server ignores `Last-Event-ID` semantically (leaderboard is a latest-value stream) but always sends a fresh `snapshot` first so reconnecting clients immediately sync.

### 8.5 Why NATS JetStream (and not Redis Pub/Sub, Redis Streams, or Kafka)?

NATS JetStream is the async messaging layer for this module because it combines exactly the properties we need:

| Requirement | Redis Pub/Sub | Redis Streams | Kafka | **NATS JetStream** |
|---|:---:|:---:|:---:|:---:|
| At-least-once delivery | ❌ | ✅ | ✅ | ✅ |
| Dedup-by-message-id | ❌ | partial | ✅ | ✅ (dedup window) |
| Short-term retention + replay | ❌ | ✅ | ✅ | ✅ |
| Sub-ms publish latency | ✅ | ✅ | ❌ | ✅ |
| Cluster-native subject propagation | ❌ | ❌ | ✅ | ✅ |
| Operational footprint | trivial | trivial | heavy | light |
| Separation from data-plane Redis | n/a | ❌ | ✅ | ✅ |

Concretely:

- **Retention is the reason we picked JetStream over NATS Core.** Core is fire-and-forget; a subscriber disconnected at publish time loses the message. JetStream persists events in the stream for a short window, so reconnecting API instances (after a deploy, restart, or transient network blip) resume without losing top-10 updates.
- **`Nats-Msg-Id` dedup** makes the outbox publisher safely idempotent. If it crashes after publishing but before marking the outbox row, the retry is deduplicated by JetStream — not double-delivered.
- **Ephemeral push consumers** give per-instance subscriptions without the operational cost of managing durable consumer state; JetStream garbage-collects dead consumers via `inactive_threshold`.
- **Subject hierarchy** (`scoreboard.>`) means future event types (`scoreboard.score.credited`, `scoreboard.season.ended`, …) land on the same stream without re-provisioning.
- **Redis stays a datastore**, NATS stays a broker — clean separation of concerns.

Kafka was considered and rejected: its operational footprint (ZooKeeper/KRaft, broker state, topic provisioning) is disproportionate for a single-bounded-context module. Kafka makes sense as a cross-service event backbone; we'll revisit if this module ever becomes that.

---

## 9. Authentication & Anti-Abuse

### 9.1 Threat Model

| Threat | Example | Mitigation |
|--------|---------|------------|
| **T1 — Unauthenticated credit** | Attacker POSTs to `/scores:increment` with no token. | JWT required; rejected at auth guard. |
| **T2 — Forged action claim** | Attacker with a valid JWT forges a score-increment for an action they never performed. | HMAC-signed action token, issued only after a valid `POST /actions:issue-token`. |
| **T3 — Replay** | Attacker replays a legitimate request to double-credit. | Redis SETNX + Postgres UNIQUE constraint on `action_id`. |
| **T4 — Token lift** | Attacker steals another user's action token. | Token payload binds `userId` and is verified against JWT `sub`. |
| **T5 — Volume abuse** | Scripted client floods legitimate requests. | Per-user token bucket + global circuit breaker. |
| **T6 — Oversized delta** | Client claims `delta = 1_000_000`. | Server enforces `delta ≤ maxDelta` for that action type; overrides client value. |
| **T7 — Clock skew** | Attacker shifts client clock to extend token lifetime. | Server-side `exp` check — client clock is irrelevant. |
| **T8 — MITM** | Token sniffed in transit. | TLS required at the edge; HSTS enforced. |

### 9.2 JWT (User Identity)

- problem6 today is a **self-contained auth boundary** — it mints and verifies its own JWTs using HS256 against `INTERNAL_JWT_SECRET`. No external IdP or JWKS endpoint is required.
- Symmetric (HS256). Verified directly with `INTERNAL_JWT_SECRET` — no HTTP fetch, no key cache.
- Required claims: `sub` (userId), `iat`, `exp`. `iss` and `aud` claims are **not** checked (they were meaningful only with an external IdP; the shared secret IS the audience binding).
- Bearer header only; no cookies for this API.
- Forward-compatible: if an external IdP is adopted later, a separate `JwksGuard` can be introduced alongside this guard — this change does not need to be reverted.

> **Dev JWT one-liner** (sign a short-lived JWT for local testing):
> ```bash
> node -e 'import("jose").then(async j => { console.log(await new j.SignJWT({sub:"00000000-0000-0000-0000-000000000005"}).setProtectedHeader({alg:"HS256"}).setExpirationTime("5m").setIssuedAt().sign(new TextEncoder().encode(process.env.INTERNAL_JWT_SECRET))) })'
> ```

### 9.3 Action Token (Action Authorization)

A **capability token** binding a single score credit to a specific user and action type. The server is the sole issuer and verifier.

**Payload**
```
header:  { alg: "HS256", typ: "AT+JWT" }
payload: {
  iss: "scoreboard",
  sub: "<userId>",
  aid: "<actionId>",       // unique per issuance
  atp: "<actionType>",     // informational; drives maxDelta policy
  mxd: 10,                 // max permissible delta
  iat: 1712832000,
  exp: 1712832300          // short TTL, default 5 minutes
}
signature: HMAC_SHA256(secret, header || "." || payload)
```

**Verification pipeline**
1. Parse header; reject if `alg` ≠ `HS256` (prevents `alg=none` attacks).
2. Recompute HMAC with server secret; reject on mismatch.
3. Check `exp > now()`.
4. Check `sub == jwt.sub` — rejects T4 (token lift).
5. Check `actionId` matches the one in the request body.
6. Check `delta ≤ mxd`.
7. Check Redis `SET NX EX` on `idempotency:action:<aid>`. If loser, return the cached prior result.

The secret is loaded from an environment variable injected via a secret manager; it is **never** stored in Git.

### 9.4 Idempotency

- **Fast path** — Redis `SET NX EX 86400` on the action ID. O(1), sub-millisecond.
- **Durable path** — Postgres `UNIQUE (action_id)` on `score_events`. Catches the vanishingly rare case where Redis is evicted between the fast-path check and the commit.
- **Response caching** — the API returns the stored outcome on replay so clients see a stable answer.

### 9.5 Rate Limiting

- Per-user token bucket implemented via Redis Lua script (atomic `GET`/`DECR`/`EXPIRE`).
- Defaults: 10 increments / sec, burst 20. Tunable per deployment.
- Exceeding the bucket returns `429` with a `Retry-After` header.
- Global circuit breaker at 5,000 req/sec aggregate → returns `503` and sheds load.

### 9.6 Transport Security

- TLS terminates at the load balancer.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` on all responses (NestJS `@fastify/helmet`).

---

## 10. Scaling to 10k Concurrent Users

### 10.1 Back-of-Envelope Sizing

**Assumptions**
- 10,000 concurrent SSE clients at steady state.
- Peak score-increment rate: 1,500 / sec (NFR-02).
- Average SSE payload: 2 KB (top-10 JSON).

**Memory per SSE connection (Node + Fastify)**
Idle SSE connection ≈ 40–60 KB (socket + TLS + Fastify per-request state). 10,000 × 60 KB ≈ **600 MB** active memory for connection state.

**API instance sizing**
One NestJS-on-Fastify instance comfortably holds 5,000 open SSE connections on a **2 vCPU / 2 GB** pod. Recommend **3 instances** for 10k concurrent with n-1 redundancy and room for request-response traffic.

**Redis**
- ZSET with 10 M members, top-10 query: O(log N + 10) ≈ sub-millisecond.
- Expected load: well inside a single primary; add a replica for resilience.

**NATS JetStream** (MVP sizing: `max_age=30d`, `max_msgs=1M`, `max_bytes=1GB`)
- Peak publish rate with ~100 ms coalescing ≈ 150 publishes/sec. Sustained at that rate, the 1 M message ceiling is reached in roughly 1.85 h; in realistic (sparse, bursty) traffic, a month of history fits comfortably within the caps. Whichever limit (age, count, bytes) is hit first triggers old-message discard — writers are never blocked.
- Disk footprint at full capacity: **~1 GB per replica** — well inside any modern volume.
- **Local**: single-node NATS (R=1), file storage on the `natsdata` docker volume. One container, no clustering, no quorum overhead.
- **Production**: 3-node JetStream cluster with R=3 replication; quorum-acked publishes typically < 2 ms.
- Ephemeral push consumers: one per API instance; state is garbage-collected via `inactive_threshold` when an instance dies.
- Retention is intentionally **MVP-sized for debugging ergonomics**, not for steady state. Tuning is planned post-MVP once real traffic and incident data exist (`IMPROVEMENTS.md → I-SCL-02b`).

**Postgres**
- 1,500 writes/sec of small transactions → ~150 MB WAL/hour. One primary on SSD handles this with p99 < 20 ms.
- Add one read replica for the cold-rebuild path and any analytics (out of scope for MVP).

### 10.2 Horizontal Scalability

- API instances are **stateless** — any instance can service any REST request.
- SSE connections require **sticky sessions** (cookie-based or source-IP hash) so reconnects land on the same instance and the event id sequence is monotonic per connection.
- NATS delivers each publish to every subscribed instance → each instance fans out to its local SSE clients → linear scale-out.

### 10.3 Bottlenecks & Mitigations

| Bottleneck | Symptom | Mitigation |
|-----------|---------|-----------|
| Postgres write throughput | p99 latency creeps up | Outbox batching; connection pooling via PgBouncer transaction mode. |
| Redis single-thread | CPU saturation | Move rate-limit and idempotency to a dedicated Redis instance / use Redis Cluster. |
| SSE memory per instance | OOM kills | `MAX_SSE_CONN_PER_INSTANCE=5000` guard; new connections 503 until capacity. |
| Event storm on burst writes | Thundering herd | 100 ms coalescing window in outbox publisher. |
| Cold start after deploy | Empty ZSET, slow reads | Pre-warm on boot (`LeaderboardRebuilder`) before accepting traffic; readiness probe gates the LB. |

### 10.4 SLOs

| SLO | Target |
|-----|--------|
| Read availability (`/leaderboard/top`, `/leaderboard/stream` initial snapshot) | 99.95% |
| Write availability (`/scores:increment`) | 99.9% |
| Write latency p99 | < 150 ms |
| End-to-end live update latency p95 | < 1 s |
| Error budget | 0.1% / 28 days |

---

## 11. DDD Project Layout

### 11.1 Folder Tree

```
problem6/
├── README.md                  ← this document
├── ARCHITECTURE.md             ← Mermaid diagrams of topology, layers, flows
├── IMPROVEMENTS.md
├── docs/
│   └── runbooks/              ← ops runbooks (Redis SPOF, action-token rotation, …)
├── mise.toml                  ← tool + task management
├── Dockerfile                 ← multi-stage production build
├── docker-compose.yml         ← local infra (Postgres, Redis, tools)
├── package.json               ← dependencies only; scripts live in mise.toml
├── pnpm-lock.yaml
├── tsconfig.json
└── src/
    ├── main.ts                ← NestJS bootstrap (Fastify adapter)
    ├── app.module.ts
    ├── config/                ← typed env loading
    │
    ├── database/              ← Kysely wiring + migrations
    │   ├── schema.ts          ← DatabaseSchema type (source of truth)
    │   ├── types.generated.ts ← from `kysely-codegen`, committed
    │   ├── kysely.factory.ts  ← Kysely instance wired to pg Pool
    │   └── migrations/
    │       ├── 20260411000000_init.ts
    │       └── ...
    │
    ├── scoreboard/            ← bounded context
    │   ├── domain/
    │   │   ├── user-score.aggregate.ts
    │   │   ├── score-event.entity.ts
    │   │   ├── value-objects/
    │   │   │   ├── user-id.vo.ts
    │   │   │   ├── action-id.vo.ts
    │   │   │   ├── score.vo.ts
    │   │   │   └── score-delta.vo.ts
    │   │   ├── events/
    │   │   │   ├── score-credited.event.ts
    │   │   │   └── leaderboard-changed.event.ts
    │   │   ├── services/
    │   │   │   └── leaderboard.domain-service.ts
    │   │   └── ports/
    │   │       ├── user-score.repository.ts
    │   │       ├── leaderboard.cache.ts
    │   │       ├── idempotency-store.ts
    │   │       └── domain-event-publisher.ts
    │   │
    │   ├── application/
    │   │   ├── commands/
    │   │   │   ├── increment-score.command.ts
    │   │   │   └── increment-score.handler.ts
    │   │   ├── queries/
    │   │   │   ├── get-top-leaderboard.query.ts
    │   │   │   └── get-top-leaderboard.handler.ts
    │   │   ├── ports/
    │   │   │   └── action-token.verifier.ts
    │   │   └── dto/
    │   │       ├── increment-score.dto.ts
    │   │       └── leaderboard-entry.dto.ts
    │   │
    │   ├── infrastructure/
    │   │   ├── persistence/
    │   │   │   ├── kysely/
    │   │   │   │   └── user-score.repository.impl.ts
    │   │   │   └── redis/
    │   │   │       ├── redis.client.ts
    │   │   │       ├── leaderboard.cache.impl.ts
    │   │   │       └── idempotency-store.impl.ts
    │   │   ├── messaging/
    │   │   │   └── nats/
    │   │   │       ├── nats.client.ts               ← connection + JetStream context
    │   │   │       ├── stream-bootstrap.ts          ← ensures SCOREBOARD stream exists on boot
    │   │   │       ├── jetstream.event-publisher.ts ← implements DomainEventPublisher (msg-id dedup)
    │   │   │       └── jetstream.subscriber.ts      ← ephemeral push consumer for SSE fan-out
    │   │   ├── auth/
    │   │   │   ├── jwt.guard.ts
    │   │   │   └── action-token.verifier.impl.ts
    │   │   ├── outbox/
    │   │   │   ├── outbox.repository.ts
    │   │   │   └── outbox.publisher.ts   ← background worker
    │   │   └── rate-limit/
    │   │       └── token-bucket.ts
    │   │
    │   ├── interface/
    │   │   ├── http/
    │   │   │   ├── scoreboard.controller.ts   ← REST endpoints
    │   │   │   ├── leaderboard-stream.controller.ts  ← SSE endpoint
    │   │   │   ├── dto/
    │   │   │   └── error-filter.ts
    │   │   └── health/
    │   │       └── health.controller.ts
    │   │
    │   └── scoreboard.module.ts
    │
    └── shared/
        ├── logger/
        ├── metrics/
        └── tracing/
```

### 11.2 Dependency Rules

```
interface ──► application ──► domain
                 ▲
                 │
infrastructure ──┘   (adapters implementing domain ports)
```

- **domain** depends on nothing. Pure TypeScript, no framework imports, no I/O.
- **application** depends only on **domain**.
- **infrastructure** depends on **application** + **domain** (to implement ports).
- **interface** depends on **application** (to dispatch commands/queries) and on framework modules.
- The dependency graph is enforced by `eslint-plugin-boundaries`; violations fail CI.

### 11.3 Port → Adapter Mapping

| Port (domain / application) | Adapter (infrastructure) |
|---|---|
| `UserScoreRepository` | `KyselyUserScoreRepository` |
| `LeaderboardCache` | `RedisLeaderboardCache` (ZSET) |
| `IdempotencyStore` | `RedisIdempotencyStore` (SETNX) |
| `DomainEventPublisher` | `NatsEventPublisher` (driven by `OutboxPublisher`) |
| `ActionTokenVerifier` | `HmacActionTokenVerifier` |
| `RateLimiter` | `RedisTokenBucket` |

### 11.4 Why Single-Module Bounded Context

This is a **single bounded context** with a single aggregate. A multi-module split would be premature. If the module grows to include seasons, achievements, or multi-leaderboard support, each should become its own bounded context (`seasons/`, `achievements/`) within `src/`.

---

## 12. Observability

### 12.1 Metrics (Prometheus exposition)

| Metric | Type | Labels |
|--------|------|--------|
| `scoreboard_http_requests_total` | counter | `method`, `route`, `status` |
| `scoreboard_http_request_duration_seconds` | histogram | `method`, `route` |
| `scoreboard_score_increment_total` | counter | `result = committed\|idempotent\|rejected` |
| `scoreboard_action_token_verify_total` | counter | `outcome = ok\|forged\|expired\|user_mismatch\|consumed` |
| `scoreboard_sse_connections` | gauge | `instance` |
| `scoreboard_sse_push_latency_seconds` | histogram | — |
| `scoreboard_outbox_lag_seconds` | gauge | — |
| `scoreboard_nats_publish_total` | counter | `subject`, `result = ok\|dedup\|error` |
| `scoreboard_nats_publish_latency_seconds` | histogram | `subject` |
| `scoreboard_nats_consumer_pending` | gauge | `consumer` |
| `scoreboard_nats_consumer_ack_total` | counter | `consumer`, `result = ok\|nak\|term` |
| `scoreboard_rate_limit_hits_total` | counter | `outcome = allowed\|rejected` |

### 12.2 Logs

- **Format:** structured JSON, one event per line (Pino).
- **Required fields:** `ts`, `level`, `msg`, `requestId`, `userId` (hashed), `route`, `latencyMs`.
- **Never logged:** JWTs, action tokens, raw secrets.
- **Destination:** stdout → container log collector.

### 12.3 Traces

- OpenTelemetry with `@opentelemetry/instrumentation-fastify` and `@opentelemetry/instrumentation-pg`.
- Trace context propagated from the load balancer via `traceparent`.
- Key spans: `jwt.verify`, `action-token.verify`, `idempotency.check`, `db.tx`, `redis.zadd`, `sse.fanout`.

### 12.4 Dashboards (Grafana)

- **Scoreboard — Overview:** RED metrics per endpoint, SSE connection count, error rate.
- **Scoreboard — Security:** rate-limit hits, action-token failure breakdown.
- **Scoreboard — Data path:** Postgres tx latency, outbox lag, Redis op latency.

---

## 13. Local Development

### 13.1 Prerequisites

- [mise](https://mise.jdx.dev/) installed (`curl https://mise.run | sh`)
- Docker 24+ with Docker Compose v2
- That's it — `mise` installs Node.js, pnpm, and everything else.

**k6 (for load tests only):**
```bash
# Option A — via mise (if k6 tool is listed in mise.toml)
mise install k6

# Option B — via Homebrew (macOS)
brew install k6

# Option C — official installer
# https://k6.io/docs/get-started/installation/
```

Run the load test (requires docker-compose stack to be up):
```bash
cd problem6
# Quick 1-minute smoke run
mise run test:load -- --quick
# Full 40-minute soak test
mise run test:load
```

### 13.2 Quickstart

```bash
cd problem6
mise install             # installs pinned Node + pnpm versions
mise run setup           # pnpm install + kysely codegen
mise run infra:up        # starts Postgres + Redis via docker compose
mise run db:migrate      # applies Kysely migrations (via kysely-ctl)
mise run dev             # starts the API in watch mode on :3000
```

Smoke test:
```bash
curl -sS http://localhost:3000/health
curl -sS http://localhost:3000/v1/leaderboard/top | jq
```

Stop infra:
```bash
mise run infra:down
```

### 13.3 Environment Variables

Provide a `.env` file at `problem6/.env`. All variables are required unless marked optional.

| Variable | Example | Description |
|---------|---------|-------------|
| `NODE_ENV` | `development` | runtime mode |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/scoreboard` | Postgres DSN |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis DSN |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL (comma-separated for clusters) |
| `NATS_STREAM_NAME` | `SCOREBOARD` | JetStream stream name (bootstrapped on app start) |
| `NATS_STREAM_MAX_AGE_SECONDS` | `2592000` (30 days / 1 month) | MVP retention — generous for debugging; tighten post-MVP |
| `NATS_STREAM_MAX_MSGS` | `1000000` | Stream message cap |
| `NATS_STREAM_MAX_BYTES` | `1073741824` (1 GB) | Stream byte cap |
| `NATS_STREAM_REPLICAS` | `1` (local) / `3` (prod) | JetStream replica count — local dev is single-node |
| `NATS_DEDUP_WINDOW_SECONDS` | `120` | `Nats-Msg-Id` dedup window |
| `INTERNAL_JWT_SECRET` | *(32+ random bytes)* | 32+ random bytes used to HS256-sign and verify internal JWTs — generate with `openssl rand -hex 32` |
| `ACTION_TOKEN_SECRET` | *(32+ random bytes)* | HMAC secret for action tokens |
| `ACTION_TOKEN_TTL_SECONDS` | `300` | action token lifetime |
| `RATE_LIMIT_PER_SEC` | `10` | per-user write budget |
| `MAX_SSE_CONN_PER_INSTANCE` | `5000` | SSE backpressure cap |
| `LOG_LEVEL` | `info` | pino log level |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(optional)* | traces target |

---

## 14. CI/CD & Docker

### 14.1 Dockerfile Strategy

The [`Dockerfile`](./Dockerfile) is a **four-stage** build:

1. **`base`** — Alpine + Node + pnpm (shared cache layer for subsequent stages).
2. **`deps`** — `pnpm install --frozen-lockfile` in its own layer with a BuildKit cache mount → maximises layer hit rate on unchanged `pnpm-lock.yaml`.
3. **`build`** — copies sources, runs `pnpm nest build`, then `pnpm prune --prod` to shrink `node_modules`. No ORM codegen — Kysely types live under `src/database/` and are committed to the repo.
4. **`runtime`** — minimal Alpine image with `tini` as init, a non-root `app` user, only `dist/`, `node_modules/`, and `package.json` copied in.

**Key optimisations**
- Multi-stage keeps the final image under ~180 MB.
- BuildKit cache mount on `pnpm` store → incremental builds in CI under 30 s when dependencies unchanged.
- `HEALTHCHECK` hits `/health` so Docker / Compose can report unhealthy containers.
- Non-root user is mandatory for Kubernetes `PodSecurityStandard: restricted`.

### 14.2 Image Tagging

CI tags images with `git sha`, `git tag` (if any), and `env` (`dev`, `staging`, `prod`):
```
ghcr.io/acme/problem6-scoreboard:sha-<shortsha>
ghcr.io/acme/problem6-scoreboard:v1.2.3
ghcr.io/acme/problem6-scoreboard:prod
```

### 14.3 CI Pipeline (recommended)

1. `mise install`
2. `mise run lint`
3. `mise run typecheck`
4. `mise run test`
5. `mise run test:integration` (Testcontainers spin up Postgres + Redis + NATS)
6. `mise run test:coverage` (enforces ≥ 80 % line + branch coverage)
6. `docker build --target runtime -t $IMAGE .`
7. `docker push`
8. Deploy via your orchestrator (Helm, Argo CD, etc.)

---

## 15. Testing Strategy

| Tier | Scope | Tool | Runs |
|------|-------|------|------|
| **Unit** | Domain + application layers. No I/O, no framework. | Jest | On every save, every CI commit. |
| **Integration** | Infrastructure adapters against real Postgres, Redis, and NATS via Testcontainers. | Jest + Testcontainers | Every CI commit. |
| **Contract** | HTTP request/response conformance to [`7. API Contracts`](#7-api-contracts). | Supertest + schema assertion (zod / JSON Schema) | Every CI commit. |
| **E2E** | Full stack via `docker-compose`, including SSE flow. | Playwright (for SSE client) | Nightly and pre-release. |
| **Load / Soak** | 10k SSE connections + 1.5k writes/sec for 30 min. | k6 | Weekly and pre-release. |
| **Chaos** | Kill Redis / Postgres / API instance, measure recovery. | `toxiproxy` or `pumba` | Monthly. |

**Coverage targets**
- **Overall: ≥ 80 % lines and branches** — enforced by Jest `--coverageThreshold` (`lines`, `branches`, `functions`, `statements` all ≥ 80). CI fails below.
- Domain: 100 % line coverage (pure logic — no excuse not to).
- Application: ≥ 90 %.
- Infrastructure: ≥ 70 % (the rest is covered by integration tests).

**Testing goals (mandatory)**
- **G-TEST-01**: every domain aggregate, value object, and application handler has focused Jest unit tests (no I/O, no framework).
- **G-TEST-02**: every infrastructure adapter has integration tests that hit a **real** Postgres, Redis, and NATS spun up per test suite via Testcontainers — no in-memory or mocked replacements for these.
- **G-TEST-03**: the CI pipeline runs `mise run test:coverage`; the build fails if overall coverage drops below 80 %.

---

## 16. Rollout & Operations

### 16.1 Initial Deployment

1. Provision Postgres, Redis, and a **3-node NATS JetStream cluster** (managed service preferred).
2. Run Kysely migrations from a one-shot `migrate` job (`kysely migrate:latest`).
3. Ensure the JetStream `SCOREBOARD` stream exists — managed by infrastructure-as-code in production; the app's `StreamBootstrap` re-applies the config idempotently on boot as a safety net.
4. Deploy 3 API replicas behind the load balancer.
5. Wait for `/ready` to return 200 (it checks Postgres, Redis, **and** JetStream reachability) before adding replicas to the LB pool.
6. Run synthetic smoke test (`POST /scores:increment` with a signed test token) and verify that an SSE client receives the `leaderboard.updated` event.
7. **MIN-02 verification** — run the cold-rebuild benchmark to confirm NFR-09 (< 60 s for 10M rows):
   ```bash
   pnpm tsx scripts/benchmark-rebuild.ts --rows 10000000
   # Expected output: {"usersProcessed":10000000,"elapsedMs":<number>,"durationOk":true}
   # Exit code 0 = pass, 1 = fail (rebuild took ≥ 60 s — investigate Postgres/Redis connection or hardware)
   ```
   For a quick smoke check during local dev:
   ```bash
   pnpm tsx scripts/benchmark-rebuild.ts  # default 100k rows
   ```

### 16.2 Rollback

- Every deploy is a new immutable image tag → rollback = re-deploy the previous tag.
- Database migrations are additive only in v1; destructive changes go behind a feature flag and a two-phase migration (write-both, then read-new).

### 16.3 Runbook Pointers

| Symptom | First step |
|---------|-----------|
| SSE clients see stale data | Check `scoreboard_outbox_lag_seconds`; then `scoreboard_nats_consumer_pending` per instance. Restart outbox publisher if lag > 10 s. |
| JetStream publish errors spiking | `nats stream info SCOREBOARD` — check cluster/replica health; confirm quorum. |
| SSE silent but writes succeed | Consumer may be stuck — check `scoreboard_nats_consumer_ack_total`; rolling-restart the affected instance. |
| `429` spike | Inspect `scoreboard_rate_limit_hits_total` by `userId` hash — look for a bad actor. |
| High write latency | Check Postgres `pg_stat_activity`; consider PgBouncer connection saturation. |
| Redis ZSET empty | Trigger `LeaderboardRebuilder` manually; verify Postgres is reachable. |
| JetStream stream missing | Re-run `StreamBootstrap` or apply the infra-as-code stream config. |

### 16.4 Responsibility Boundaries

- **IP-level rate limiting** is the responsibility of the ingress layer (nginx/ALB); problem6 enforces per-user quotas via `RateLimitGuard` only.
- **`X-Cache-Status: hit|miss`** is emitted by `GET /v1/leaderboard/top` for k6 load-test assertions. The header is informational and MUST NOT be relied on by production clients.

### 16.5 Local observability (dev only)

`mise run obs:up` boots a developer-only Prometheus + Grafana pair under the `observability` compose profile. Prometheus scrapes the host-bound dev server at `host.docker.internal:3000/metrics` every 5 seconds; Grafana auto-loads the committed `scoreboard-overview.json` dashboard (8 panels covering HTTP traffic, write path, rate limiting, errors, and uptime). Default `mise run infra:up` is unaffected — opt in only when you need it.

- **Prometheus**: `http://localhost:59090` (no auth)
- **Grafana**: `http://localhost:53000` (anonymous admin — no login)

This stack is strictly for local iteration. The configuration (anonymous admin, loopback-only binding, ephemeral Grafana state) is explicitly **not** transferable to `infra/helm/` or any production topology. Full documentation, troubleshooting, and the dashboard edit-and-commit workflow live in [`infra/local/README.md`](./infra/local/README.md).

---

## 17. Appendices

### Appendix A — Error Code Reference

| HTTP | `code` | Meaning |
|------|--------|---------|
| 400 | `INVALID_REQUEST` | Schema validation failed. |
| 400 | `INVALID_DELTA` | `delta` outside allowed range. |
| 401 | `UNAUTHENTICATED` | Missing or invalid JWT. |
| 403 | `INVALID_ACTION_TOKEN` | Action token forged, expired, or mismatched user. |
| 403 | `ACTION_ALREADY_CONSUMED` | Idempotency loser. |
| 404 | `NOT_FOUND` | Unknown route. |
| 429 | `RATE_LIMITED` | Per-user quota exhausted. |
| 500 | `INTERNAL_ERROR` | Unhandled exception; details in logs. |
| 503 | `TEMPORARILY_UNAVAILABLE` | Downstream (DB/Redis) degraded; client may retry. |

### Appendix B — Related Files

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Mermaid sequence & component diagrams.
- [`IMPROVEMENTS.md`](./IMPROVEMENTS.md) — Known gaps and forward-looking enhancements.
- [`mise.toml`](./mise.toml) — Pinned toolchain and task definitions.
- [`Dockerfile`](./Dockerfile) — Four-stage production build.
- [`docker-compose.yml`](./docker-compose.yml) — Local infrastructure.

### Appendix C — Conventions

- Commit messages: Conventional Commits (`feat(scoreboard): …`).
- Branches: `feature/<ticket>-<slug>`.
- Code style: ESLint + Prettier, enforced in CI.
- Type-only imports: `import type { … }` to keep runtime graph clean.
- No default exports in `domain/` or `application/`.

---

**End of Specification**
