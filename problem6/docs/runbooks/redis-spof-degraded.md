# Redis SPOF — Degraded Mode Runbook

## Summary

Redis is a shared dependency for four subsystems in the scoreboard service: the idempotency layer-1 (SET NX), the rate-limit token bucket, the leaderboard ZSET cache, and the outbox publisher leader-election lock. When Redis becomes unreachable, the service enters a degraded mode: write requests are refused with 503 (fail-CLOSED, Decision-1 option b per GAP-03), reads fall back to Postgres, and the outbox publisher stops emitting events until Redis recovers. This runbook describes how to confirm the degraded state, interpret each subsystem's behaviour, and restore normal operation.

---

## Behaviour in Degraded Mode

| Subsystem | What happens when Redis is unreachable |
|-----------|----------------------------------------|
| **Idempotency layer 1** (Redis SET NX) | Falls back to layer 2: Postgres `UNIQUE(action_id)` constraint (ADR-07). Duplicate credits are still rejected; the constraint violation is caught and the handler returns `idempotent`. No data loss. |
| **Rate-limit guard** | **FAIL-CLOSED**: `bucket.consume()` throws; the guard increments `scoreboard_rate_limit_failed_closed_total`, logs `[RateLimitGuard] Redis error, failing closed` at ERROR level, and throws `503 TEMPORARILY_UNAVAILABLE`. All write requests are refused until Redis recovers. |
| **Leaderboard reads** (`GET /v1/leaderboard/top`) | Cache-miss fallback: the controller falls back to a direct Postgres query `SELECT * FROM user_scores ORDER BY total_score DESC, updated_at ASC LIMIT N` and returns the result with header `X-Cache-Status: miss-fallback`. Reads remain available. |
| **SSE stream initial snapshot** | The `/ready` endpoint returns 503 (redis check fails). Pods with an empty cache are removed from the load balancer. Existing SSE connections may remain open but will not receive new score events until the outbox publisher resumes. |
| **Outbox publisher leader election** | The publisher fails to acquire the Redis lock (`outbox:lock`). All instances become followers. No NATS messages are published until Redis recovers and a leader is elected. Events buffered in the Postgres outbox table are replayed automatically once a leader is elected. |

---

## Confirming Degraded Mode Is Active

### 1. Check the readiness probe

```bash
curl -s http://<pod-ip>:3000/ready | jq .
```

Expected response when Redis is down:

```json
{
  "status": "error",
  "checks": {
    "redis": "down",
    "postgres": "ok"
  }
}
```

HTTP status: `503 Service Unavailable`

### 2. Check the fail-CLOSED metric

```bash
curl -s http://<pod-ip>:3000/metrics | grep scoreboard_rate_limit_failed_closed_total
```

A value `> 0` and incrementing on each write attempt confirms the guard is failing closed.

### 3. Check application logs

```bash
# Docker / local
docker logs problem6-api 2>&1 | grep "RateLimitGuard"

# Kubernetes
kubectl logs -n <namespace> -l app=scoreboard-api --tail=100 | grep "RateLimitGuard"
```

Expected log line (ERROR level):

```
[RateLimitGuard] Redis error, failing closed  {"err": {"message": "ECONNREFUSED", ...}}
```

### 4. Direct Redis connectivity check

```bash
redis-cli -h <redis-host> -p 6379 ping
```

If Redis is unreachable this will time out or return `Could not connect to Redis`.

---

## Recovery Procedure

### Step 1 — Verify degraded mode is active

Use the checks in the section above to confirm:
- `/ready` returns 503 with `checks.redis: "down"`
- `scoreboard_rate_limit_failed_closed_total` counter is > 0 and rising
- Logs show `[RateLimitGuard] Redis error, failing closed`

### Step 2 — Restore Redis

Check what caused the Redis outage and resolve it:

```bash
# Check Redis process health (Docker compose)
docker logs problem6-redis --tail=50

# Kubernetes — check pod status
kubectl get pod -n <namespace> -l app=redis
kubectl describe pod -n <namespace> <redis-pod-name>

# Verify network path between API and Redis
redis-cli -h <redis-host> -p 6379 ping
```

If the issue was a network partition between the API pods and Redis, fix the network path first (security group rules, DNS, service mesh policy), then verify Redis is accepting connections before proceeding.

### Step 3 — Repopulate the leaderboard cache

Once Redis is back, trigger the LeaderboardRebuilder to repopulate `leaderboard:global` from Postgres:

```bash
cd problem6 && pnpm tsx scripts/manual-rebuild.ts
```

> **Note**: If `scripts/manual-rebuild.ts` does not exist yet, use the admin endpoint (if available) or restart one API pod — `LeaderboardRebuildBootstrap` runs on application bootstrap and will rebuild the cache automatically.

Verify the cache is populated:

```bash
redis-cli -h <redis-host> zcard leaderboard:global
# Should return the number of users with scores (> 0)
```

### Step 4 — Verify rate-limit is restored

```bash
# Counter should stop incrementing
curl -s http://<pod-ip>:3000/metrics | grep scoreboard_rate_limit_failed_closed_total

# Readiness probe should return 200
curl -s -o /dev/null -w "%{http_code}" http://<pod-ip>:3000/ready
# Expected: 200

# A test write should succeed (replace TOKEN and ACTION_TOKEN with valid values)
curl -s -X POST http://<pod-ip>:3000/v1/scores/increment \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actionToken": "'$ACTION_TOKEN'"}' | jq .
# Expected: 200 with { "newScore": <value> }
```

---

## Verification: Example curl Output

### 503 response during Redis outage (write request)

```bash
curl -s -X POST http://<pod-ip>:3000/v1/scores/increment \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actionToken": "..."}'
```

```json
{
  "statusCode": 503,
  "code": "TEMPORARILY_UNAVAILABLE",
  "message": "Rate limit service temporarily unavailable"
}
```

HTTP status: `503 Service Unavailable`

### 200 readiness response after recovery

```bash
curl -s http://<pod-ip>:3000/ready | jq .
```

```json
{
  "status": "ok",
  "checks": {
    "redis": "ok",
    "postgres": "ok"
  }
}
```

HTTP status: `200 OK`

### Successful credit after recovery

```bash
curl -s -X POST http://<pod-ip>:3000/v1/scores/increment \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actionToken": "'$ACTION_TOKEN'"}'
```

```json
{
  "newScore": 42
}
```

HTTP status: `200 OK`

---

## Known Limitations

- **Full write-path outage during Redis incident**: This is the deliberate trade-off of the fail-CLOSED policy (GAP-03 Decision-1, option b). When Redis is unreachable, all write requests return 503. No partial degraded write path is available.
- **No buffered-write replay**: The service does NOT buffer write requests that arrived during the outage. Clients must retry. The outbox table captures events from writes that succeeded before the outage; those are replayed automatically when the publisher leader is re-elected.
- **Outbox backlog**: Events committed to Postgres before the outage but not yet published will be replayed once the outbox publisher re-acquires the leader lock. There is no manual intervention needed for this — the publisher polls on startup.
