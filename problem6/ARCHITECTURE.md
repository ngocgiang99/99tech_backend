# Architecture — Scoreboard Module

Hexagonal (ports-and-adapters) DDD architecture for the `problem6/` scoreboard service. All diagrams are [Mermaid](https://mermaid.js.org/) and render natively on GitHub, GitLab, and most modern markdown renderers.

Diagrams:

1. [System Topology](#1-system-topology)
2. [DDD Layering (Hexagonal)](#2-ddd-layering-hexagonal)
3. [Sequence — Issue Action Token](#3-sequence--issue-action-token)
4. [Sequence — Score Increment](#4-sequence--score-increment-happy-path--idempotent-replay)
5. [Sequence — Live Updates via SSE (JetStream)](#5-sequence--live-updates-via-sse-jetstream)
6. [State — Action Token Lifecycle](#6-state--action-token-lifecycle)
7. [Outbox Flow (JetStream publish)](#7-outbox-flow-jetstream-publish)
8. [Failure Modes](#8-failure-modes--what-happens-when)

---

## 1. System Topology

```mermaid
graph LR
    subgraph Client
        B[Web Browser<br/>score board UI]
    end

    subgraph Edge
        LB[Load Balancer<br/>L7 + sticky sessions]
    end

    subgraph API_Layer[API Layer · 3 stateless instances]
        A1[NestJS / Fastify<br/>instance 1]
        A2[NestJS / Fastify<br/>instance 2]
        A3[NestJS / Fastify<br/>instance 3]
    end

    subgraph Redis[Redis 7]
        Z[(ZSET<br/>leaderboard:global)]
        IDM[(SETNX<br/>idempotency + rate limit)]
    end

    subgraph NATS["NATS JetStream 2.10 (local: R=1, prod: R=3)"]
        STREAM[("stream: SCOREBOARD<br/>subjects: scoreboard.&gt;<br/>retention: limits<br/>max_age=30d · max_msgs=1M · max_bytes=1GB<br/>dedup_window=2m")]
    end

    subgraph PG[Postgres 16]
        P1[(Primary<br/>user_scores / score_events / outbox_events)]
        P2[(Read replica)]
    end

    B -- HTTPS&nbsp;REST+SSE --> LB
    LB --> A1
    LB --> A2
    LB --> A3

    A1 <--> Z
    A1 <--> IDM
    A2 <--> Z
    A2 <--> IDM
    A3 <--> Z
    A3 <--> IDM

    A1 <--> STREAM
    A2 <--> STREAM
    A3 <--> STREAM

    A1 --> P1
    A2 --> P1
    A3 --> P1
    A1 -. read .-> P2
    A2 -. read .-> P2
    A3 -. read .-> P2
```

---

## 2. DDD Layering (Hexagonal)

```mermaid
graph TB
    subgraph InterfaceLayer[interface layer]
        CS[ScoreboardController<br/>POST /v1/scores:increment]
        CL[LeaderboardController<br/>GET /v1/leaderboard/top]
        CA[ActionsController<br/>POST /v1/actions:issue-token]
        CST[LeaderboardStreamController<br/>GET /v1/leaderboard/stream · SSE]
        HC[HealthController<br/>/health · /ready · /metrics]
    end

    subgraph ApplicationLayer[application layer]
        CMD[IncrementScoreHandler<br/>commands/]
        Q[GetLeaderboardTopHandler<br/>queries/]
    end

    subgraph DomainLayer["domain layer · pure"]
        AGG[UserScore aggregate]
        VO[Value objects<br/>UserId · Score · ScoreDelta · ActionId]
        EV[ScoreCredited · LeaderboardChanged events]
        ERR[IdempotencyViolationError · InvalidArgumentError]
        P1P[/UserScoreRepository port/]
        P2P[/LeaderboardCache port/]
        P4P[/DomainEventPublisher port/]
        P5P[/LeaderboardUpdatesPort port/]
        P6P[/ActionTokenIssuer port/]
    end

    subgraph InfraLayer["infrastructure layer · adapters"]
        KY[KyselyUserScoreRepository]
        RC[RedisLeaderboardCache<br/>singleflight-wrapped getTop]
        JSP[JetStreamEventPublisher<br/>msgID = outbox.id]
        JSS[JetStreamSubscriber<br/>ephemeral push consumer]
        LUA[LeaderboardUpdatesInProcessAdapter<br/>in-process pub/sub]
        OB[OutboxPublisherService<br/>leader-elected · Redis lock]
        HI[HmacActionTokenIssuer]
        HV[HmacActionTokenVerifier]
        JG[JwtGuard · ActionTokenGuard · RateLimitGuard]
        HS[HealthService<br/>infrastructure/health/]
    end

    CS --> CMD
    CL --> Q
    CA -.-> P6P
    CST -.-> P5P
    CST --> JSS
    HC --> HS
    CMD --> AGG
    CMD --> P1P
    Q --> P2P
    Q --> P1P
    AGG -. emits .-> EV

    KY -. implements .-> P1P
    RC -. implements .-> P2P
    JSP -. implements .-> P4P
    LUA -. implements .-> P5P
    HI -. implements .-> P6P
    OB --> JSP
    OB --> JSS

    CMD --> P4P
```

**Dependency rule**: arrows only point inward (toward `domain`). `domain` depends on nothing. `application` depends only on `domain` + `shared`. `infrastructure` implements ports declared in `domain` (and occasionally `application`). `interface` depends on `application` + `domain` (for port types and value objects) + `shared`. Enforced in CI via `eslint-plugin-boundaries`.

**Framework-idiom exemption**: `interface` controllers import `JwtGuard` / `ActionTokenGuard` / `RateLimitGuard` from `infrastructure/auth/` and `infrastructure/rate-limit/` via NestJS `@UseGuards(...)`. These imports carry a per-line `// eslint-disable-next-line boundaries/dependencies -- NestJS guard via @UseGuards` comment. Everything else must go through a port.

---

## 3. Sequence — Issue Action Token

```mermaid
sequenceDiagram
    autonumber
    participant U as User (Browser)
    participant LB as Load Balancer
    participant API as API (NestJS/Fastify)

    U->>LB: POST /v1/actions:issue-token { actionType }
    Note over U,LB: Header — Authorization: Bearer <jwt>
    LB->>API: forward
    API->>API: verify JWT (HS256 vs INTERNAL_JWT_SECRET, exp)
    API->>API: generate actionId (uuid v4)
    API->>API: HMAC-sign { sub, aid, atp, mxd, iat, exp }
    API-->>U: 200 { actionId, actionToken, expiresAt, maxDelta }
```

---

## 4. Sequence — Score Increment (happy path + idempotent replay)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant LB as Load Balancer
    participant CT as ScoreboardController
    participant H as IncrementScoreHandler
    participant R as Redis
    participant PG as Postgres
    participant OB as OutboxPublisher
    participant JS as NATS JetStream (SCOREBOARD)

    U->>LB: POST /v1/scores:increment { actionId, actionToken, delta }
    LB->>CT: forward
    CT->>CT: JwtGuard (HS256) · ActionTokenGuard (HMAC) · RateLimitGuard (Redis bucket)
    CT->>H: execute(IncrementScoreCommand)

    H->>PG: SELECT user_scores WHERE user_id = ? (aggregate hydrate)
    H->>H: aggregate.credit(actionId, delta, occurredAt)
    H->>PG: BEGIN

    alt first execution — unique (action_id) wins
        H->>PG: INSERT score_events (action_id UNIQUE)
        H->>PG: UPSERT user_scores SET total = aggregate.total
        H->>PG: INSERT outbox_events (ScoreCredited, LeaderboardChanged)
        H->>PG: COMMIT
        H->>R: ZADD leaderboard:global (score,userId)
        H->>R: ZREVRANGE 0 9 (rank · topChanged)
        Note over H,R: Redis cache errors are caught · rank/topChanged return null
        H-->>CT: { kind: 'committed', newScore, rank, topChanged }
        CT-->>U: 200 { newScore, rank, topChanged }
    else replay — INSERT raises IdempotencyViolationError
        Note over H: handler's own catch block — not the controller's
        H->>PG: SELECT prior score_event WHERE action_id = ?
        H-->>CT: { kind: 'idempotent-replay', newScore: prior.totalScoreAfter, rank: null, topChanged: null }
        CT-->>U: 200 { newScore, rank: null, topChanged: null }
    end

    Note over OB: runs continuously · leader-elected via Redis lock "outbox:lock"
    OB->>PG: SELECT * FROM outbox_events WHERE published_at IS NULL
    OB->>JS: js.publish(scoreboard.leaderboard.updated, payload, msgID=outbox.id)
    Note over JS: dedup_window = 2m · retry-safe
    OB->>PG: UPDATE outbox_events SET published_at = now()
```

**Key invariant**: `IncrementScoreHandler` owns its own idempotency recovery. The controller awaits `handler.execute(cmd)` once and returns — no `try/catch` on `IdempotencyViolationError` at the interface layer. The result type is a discriminated union: `{ kind: 'committed', ... } | { kind: 'idempotent-replay', ... }`.

---

## 5. Sequence — Live Updates via SSE (JetStream)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant LB as Load Balancer
    participant API as API instance
    participant R as Redis
    participant JS as NATS JetStream

    Note over API,JS: On boot, each API instance creates an ephemeral push consumer
    Note over API,JS: filter scoreboard.leaderboard.updated, deliver=new, ack=explicit

    U->>LB: GET /v1/leaderboard/stream with Bearer jwt
    LB->>API: forward via sticky session
    API->>API: verify JWT
    API->>R: ZREVRANGE leaderboard:global 0 9 WITHSCORES
    R-->>API: current top-10
    API-->>U: event snapshot with top10 payload

    loop whenever top-10 changes
        JS-->>API: deliver msg with top10
        API-->>U: event leaderboard.updated with top10
        API->>JS: ack
    end

    Note over API,JS: If API crashes pre-ack, JetStream redelivers after ack_wait

    loop every 15s
        API-->>U: event heartbeat ping
    end

    Note over U,API: On disconnect, browser auto-reconnects with Last-Event-ID
    Note over U,API: Server replies with a fresh snapshot and resumes push
```

---

## 6. State — Action Token Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Issued: POST /actions issue-token
    Issued --> Verified: POST /scores increment (HMAC + exp + sub OK)
    Issued --> Expired: now > exp
    Verified --> Consumed: SET NX wins, score committed
    Verified --> Rejected: SET NX loses, replay detected
    Expired --> [*]
    Consumed --> [*]
    Rejected --> [*]
```

---

## 7. Outbox Flow (JetStream publish)

```mermaid
flowchart LR
    TX[IncrementScoreHandler<br/>command] -- single transaction --> DB[(Postgres)]
    DB --> SE[score_events]
    DB --> US[user_scores]
    DB --> OBE[outbox_events]
    OBE -- poll every 50 ms --> OBP[OutboxPublisher worker]
    OBP -- ZADD --> Z[Redis ZSET]
    OBP -- diff top-10 --> COA{changed?}
    COA -- yes --> PUB["JetStream publish<br/>subject: scoreboard.leaderboard.updated<br/>msgID: outbox.id<br/>(dedup window: 2m)"]
    COA -- no --> SKIP[skip]
    PUB --> STREAM[(stream: SCOREBOARD<br/>max_age=30d · max_msgs=1M · max_bytes=1GB)]
    STREAM --> SUB1[API 1 · ephemeral consumer · SSE fan-out]
    STREAM --> SUB2[API 2 · ephemeral consumer · SSE fan-out]
    STREAM --> SUB3[API 3 · ephemeral consumer · SSE fan-out]
    OBP -- mark published_at --> OBE
```

---

## 8. Failure Modes — what happens when…

| Failure | Effect | Recovery |
|---|---|---|
| Redis ZSET wiped | `/leaderboard/top` returns 503; writes still commit to Postgres | `LeaderboardRebuilder` rehydrates from Postgres — target < 60 s (NFR-09) |
| JetStream broker down (no quorum) | Publishes return error; outbox row stays unpublished | Outbox publisher retries until quorum returns; `Nats-Msg-Id` dedup prevents duplicates |
| JetStream broker restart (transient) | Brief publish latency; no loss (persisted on replicas) | Automatic — JetStream replication rides through |
| Ephemeral consumer dies | That API instance stops receiving updates | `inactive_threshold=30s` garbage-collects the dead consumer; the live instance recreates a fresh one on next boot |
| API instance killed mid-SSE write | That client's in-flight message is redelivered to another consumer after `ack_wait` (5 s) | Browser auto-reconnects via `EventSource`; gets fresh snapshot + resumed push on the surviving instance |
| JetStream message exceeds retention (30 d) | Old messages expire; new subscribers only see the last month of history | By design — SSE clients always get a fresh snapshot from Redis on connect. MVP retention is sized for debugging, not steady state. |
| Postgres primary down | Writes fail with 503; reads continue from replica + cache | Failover; outbox publisher resumes from `published_at IS NULL` |
| Outbox publisher hangs | Writes still commit; live updates stop flowing | `outbox:lock` TTL expires → another instance claims leadership |
| Action-token secret rotated | In-flight tokens rejected | Dual-secret verification window during rotation (I-SEC-04) |

---

## Notes on Notation

- **Solid arrows** = synchronous calls within a request.
- **Dotted arrows** = asynchronous / eventual.
- **Sticky sessions** only apply to `/leaderboard/stream`; REST endpoints are session-free.
- Diagrams intentionally omit retry loops and TLS termination to stay readable; both are assumed.
- JetStream consumer semantics use `DeliverPolicy.New` + `AckPolicy.Explicit` + `inactive_threshold` for ephemeral, garbage-collected per-instance subscriptions.
