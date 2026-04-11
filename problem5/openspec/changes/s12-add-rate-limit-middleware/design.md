## Context

The Resources API today has no rate-limit producer. The error contract from `s08-add-error-handling` already declares `RATE_LIMIT` as a stable public error code and `RateLimitError` as a required `AppError` subclass — but nothing in the codebase ever throws or `next()`s a `RateLimitError`. The slot was reserved on the assumption that a follow-up change would wire the actual middleware. This is that change.

The constraint that makes this non-trivial is that the same project ships a benchmark suite. `s05-add-benchmarks-k6` runs k6 from the host machine (and from a `bench` profile inside `docker-compose.yml`), and `s11-add-multi-replica-prod-compose` runs k6 from the host against an nginx-fronted three-replica topology. The whole point of those scenarios is to push the API at thousands of requests per second from a single source IP for several minutes. Any rate limiter that ships also has to ship a bypass that is reliable end-to-end through nginx, narrow enough that it cannot be abused remotely, and observable enough that a future contributor cannot accidentally widen it without the test suite catching them.

The current middleware order in `src/http/app.ts` is:

```
requestId → http-metrics → pino-http → body-parser → routes → error-handler
```

The new middleware needs a slot that satisfies five constraints simultaneously:

1. After `requestId` so 429 logs carry a request id.
2. After `http-metrics` so 429 responses appear in `http_requests_total{status="429"}` (the s07 metrics already export this; no spec change needed).
3. After `pino-http` so each rate-limited request is logged once with full context.
4. Before `express.json()` so a flood of large POST bodies is bounced cheaply without paying the parse cost.
5. Before any router so `/healthz` and `/metrics` can be excluded by `req.path` check inside the middleware itself.

The slot that satisfies all five is **between `pino-http` and `express.json()`**. This is decision-bearing and is captured in §Decisions below.

The other unavoidable wrinkle is `req.ip` behind nginx. In `s11-add-multi-replica-prod-compose`, the API runs behind an nginx reverse proxy on the same Docker bridge network. Without `app.set('trust proxy', ...)` set correctly, every request to the API container has `req.ip === '<nginx container bridge IP>'`, and the per-IP limiter would treat all client traffic as one bucket and either rate-limit nginx itself instantly or, with a generous limit, never rate-limit any single real client. With `trust proxy` set incorrectly (e.g. `'true'` — trust all hops), a malicious client could spoof `X-Forwarded-For` and pretend to be `127.0.0.1`, bypassing the limiter entirely. The IETF-recommended conservative value is `'loopback, linklocal, uniquelocal'`, which trusts only addresses that cannot reach the API from the public internet.

## Goals / Non-Goals

**Goals:**

- Add a per-IP rate limiter that protects every route under `/resources` from runaway clients with a single global bucket per IP, returning `429 RATE_LIMIT` via the existing `AppError` pipeline so the response shape is identical to every other 4xx.
- Make the limiter shared-state across the three replicas in s11's prod compose, so the effective limit is N requests/IP/window regardless of how many API processes are running.
- Ship a bypass that is reliable end-to-end through nginx for host k6 (the canonical benchmark path) and that is also reliable for the in-compose `bench` profile k6 that targets the API directly.
- Make the bypass impossible to widen accidentally in production: the `0.0.0.0/0` and `::/0` CIDRs are rejected at startup when `NODE_ENV=production`.
- Wire `Retry-After` and IETF-draft `RateLimit-*` headers on 429 responses so well-behaved clients can self-throttle.
- Re-run the s11 prod benchmark with the limiter on (and bypass active) and confirm zero 429 errors and ≤5% RPS regression vs the s11 baseline. If regression exceeds 5%, the change is rejected.
- Add unit tests for the bypass `skip` function and an integration test that proves both the limiter fires and the bypass holds.

**Non-Goals:**

- Per-route or per-method limits (e.g. "stricter for POST"). The CRUD demo has no auth and no abuse model that justifies asymmetry; one global limit is the simplest correct answer. The middleware factory is structured so a future change can introduce per-route limits without re-architecting.
- Per-user or per-API-key limits. There is no auth layer to derive a user identity from. When auth lands, the key generator becomes an extension point — not a rewrite.
- Dynamic limits (Lua-script sliding window with Redis pipeline scripts, token bucket with refill, leaky bucket). The default `express-rate-limit` + `rate-limit-redis` fixed-window-with-INCR is correct enough for DoS protection on a CRUD API and adds one round-trip per request, no scripting.
- Hand-rolled limiter. Two well-maintained libraries already do this with TypeScript types and a `skip` callback. Hand-rolling adds code and bugs without buying anything observable.
- Distinct buckets per replica. The whole point of s11 was to make the three replicas behave like one logical service; separate buckets would silently triple the effective limit.
- Limit metrics beyond what `s07-add-prometheus-metrics` already exports. `http_requests_total{status="429"}` is enough to graph rate-limit pressure on a Grafana panel; a separate `rate_limit_dropped_total` counter would be redundant.
- Changing the public error contract. `RATE_LIMIT` is already declared by `s08-add-error-handling`; this change is the producer, not a contract revision.
- Disabling the limiter for tests by mutating module state. Unit tests use the factory directly with a small limit; integration tests set `RATE_LIMIT_ENABLED=false` via the test bootstrap if a scenario needs unlimited requests.

## Decisions

### Decision 1: Library choice — `express-rate-limit` + `rate-limit-redis`

**Choice**: Use `express-rate-limit` with the `rate-limit-redis` store backed by the existing ioredis client.

**Why**:
- Both libraries are mature, MIT-licensed, and have first-class TypeScript types.
- `express-rate-limit` exposes a `skip(req, res) => boolean` callback — exactly the extension point the bypass policy needs.
- `rate-limit-redis` uses the ioredis client we already have on the hot path for the response cache, so no new connection is opened.
- The default `INCR` + `EXPIRE` strategy is a fixed-window counter, which is simple, correct for DoS protection, and adds one round-trip per request.

**Alternatives considered**:
- **`fastify`-style hand-rolled middleware**: more code, more bugs, no benefit because the observable behavior is identical.
- **Node `cluster` module + per-process counters**: would have to reconcile across replicas anyway; same problem one layer down.
- **Token bucket / leaky bucket**: smoother rate shaping, more code, no measurable benefit for the DoS use case.
- **`@upstash/ratelimit`**: bundles its own Redis client, would force a second connection, no upside.

### Decision 2: Storage — Redis, not in-process memory

**Choice**: Use a Redis-backed store, even though Redis adds one round-trip per request.

**Why**: The s11 prod compose runs three replicas behind nginx. If the limiter is in-process, each replica counts independently and the effective limit is `3 × RATE_LIMIT_MAX` per IP, not `RATE_LIMIT_MAX`. That is silently three times more permissive than the dev stack with the same env, which is the worst kind of bug — invisible from logs, only visible in benchmark interpretation. Redis is already on the hot path for the response cache, so the marginal cost is one extra round-trip per request, not a new dependency.

**Trade-off**: This puts Redis on the hot path for **every** request, including writes that previously did not touch Redis. The change owns this cost by re-running the s05/s11 benchmarks and rejecting itself if `read-load` p99 regresses more than 5%.

**Alternatives considered**:
- **In-process memory + document the multiplier in `Benchmark_prod.md`**: simpler, faster, but the multiplier story is fragile — a future contributor reading the spec without the report would assume the limit is per-cluster.
- **In-process for dev compose, Redis for prod compose**: env-conditional storage means the test surface is doubled; both code paths would need integration coverage and the test suite would have to know which compose file is active.

### Decision 3: Scope — per-IP, single global bucket

**Choice**: One bucket per IP, shared across all routes and methods.

**Why**: There is no auth, so the only stable identity is the source IP. Per-route limits add complexity without solving any abuse model that exists in this codebase. A single global bucket is the simplest correct DoS protection.

**Trade-off**: A client behind a single shared NAT (corporate proxy, mobile carrier) shares one bucket with everyone behind the same NAT. The default limit of 1000 requests/minute is generous enough that this is unlikely to bite a real human user.

**Alternatives considered**:
- **Per-route per-IP**: would catch "POST flood while reads are quiet" cases, but no such abuse model exists in a CRUD demo.
- **Per-method per-IP** (e.g. stricter for writes): same critique; the body parser already caps writes at 64KB and metadata at 16KB.

### Decision 4: Bypass policy — loopback always + env CIDR allow-list

**Choice**: The `skip` function returns `true` for any request whose `req.ip` is `127.0.0.1`, `::1`, or `::ffff:127.0.0.1` (the IPv4-mapped form ioredis sometimes sees). It also returns `true` for any IP that matches a CIDR in the parsed `RATE_LIMIT_ALLOWLIST_CIDRS` env var. Otherwise it returns `false`.

**Why**:
- **Loopback always** is the cleanest possible bypass for the host-k6 path. After `trust proxy` is set correctly (Decision 5), only requests that genuinely originate from the same kernel can have a loopback IP. There is no remote way to forge this.
- **Env CIDR allow-list** is the escape hatch for the in-compose k6 path. The Docker bridge subnet (e.g. `172.16.0.0/12`) can be added to `RATE_LIMIT_ALLOWLIST_CIDRS` only in the `bench` profile of `docker-compose.yml` and the equivalent in `docker-compose.prod.yml`. The dev workflow (`mise run up`) does not set this env, so the bridge subnet is not allow-listed in normal use.

**Why the `0.0.0.0/0` startup assertion exists**: A single misconfigured `.env` could turn the limiter into a no-op silently. The startup check makes that misconfiguration impossible in production.

**Alternatives considered**:
- **Bypass header (`X-Bench-Bypass: <secret>`)**: would let k6 run from any host, but introduces a long-lived secret that has to be rotated and protected. Not worth it for a benchmark scenario.
- **Loopback only (no CIDR)**: would not cover the in-compose `bench` profile, where k6 sees the API as `http://api:3000` over the bridge network.
- **`RATE_LIMIT_ENABLED=false` only**: no fine-grained control; tests can use this, but the production path needs a per-source bypass.

### Decision 5: Trust-proxy — conservative IETF list

**Choice**: `app.set('trust proxy', 'loopback, linklocal, uniquelocal')`.

**Why**: This is the IETF-recommended conservative value. It tells Express to trust `X-Forwarded-For` only when the immediate hop is loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), or unique-local (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`). The nginx container in the s11 prod compose lives in a `172.x.x.x` Docker bridge subnet, which falls under `uniquelocal`, so its `X-Forwarded-For` header is trusted. A request from the public internet has a routable source IP that matches none of these, so its `X-Forwarded-For` is *not* trusted and `req.ip` falls back to the actual TCP peer — which is a defense against header spoofing.

**Why not `'true'`**: trusts every hop, so a malicious client can put `X-Forwarded-For: 127.0.0.1` in their request and bypass the limiter.

**Why not `1`** (one hop): would work for s11's nginx but break the day a second proxy layer is added (e.g. cloud LB + nginx).

**Why not `false`** (the Express default): would treat every request behind nginx as coming from the nginx bridge IP, putting all traffic in one bucket.

### Decision 6: Middleware order — between `pino-http` and `express.json()`

**Choice**: Insert the rate-limit middleware after `pinoHttp` and before `express.json()`. The exclusion list (`/healthz`, `/metrics`) is enforced inside the middleware via a `req.path` check, not by mounting the middleware on a sub-router.

**Why**: This satisfies all five ordering constraints from §Context. Logging and metrics fire before the limiter, so 429s are observable. Body parsing fires after, so a flood of large POSTs is bounced cheaply. The exclusion list lives in code (not in route mounting) because the alternative — mounting the middleware on `app.use('/resources', limiter, resourcesRouter)` — would put the limiter inside the resources module factory, breaking the layering rule that `src/modules/<feature>/` does not know about cross-cutting concerns.

**Alternatives considered**:
- **Mount per-router**: clean encapsulation but breaks the module layering rule from `module-layered-architecture` spec.
- **Before `requestId`**: 429 logs would lack a request id — bad for debugging.
- **After `express.json()`**: a flood of large POSTs would pay the parse cost before being bounced — wasted CPU.

### Decision 7: 429 emission via `RateLimitError`, not bespoke JSON

**Choice**: When the limiter fires, the configured `handler` callback constructs `new RateLimitError({ retryAfterSeconds: <computed> })` and calls `next(err)`. The central error handler from `s08-add-error-handling` renders the canonical body, the central logger logs at the documented level, and the central metrics middleware counts the 429. The middleware also sets the `Retry-After` HTTP header directly (because `express-rate-limit`'s `standardHeaders: 'draft-7'` mode handles `RateLimit-*` but not `Retry-After` consistently across versions).

**Why**: The whole point of `s08-add-error-handling` was that no controller, middleware, or feature constructs JSON error bodies — they all `next(err)` and let the handler format. This change does not get to break that rule.

**Alternatives considered**:
- **Use `express-rate-limit`'s built-in 429 response**: bypasses the central error handler, ships a non-standard body shape, and the response would not show up in the integration test's `error-handling` leak-check assertions.

### Decision 8: Headers — IETF draft-7

**Choice**: Set `standardHeaders: 'draft-7'` in `express-rate-limit` config. This emits `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` per the [IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) on every response, and `Retry-After` on the 429 response.

**Why**: The IETF draft is the closest thing to a standard for rate-limit headers and is what well-behaved clients (including some HTTP libraries' built-in retry logic) actually look for. The legacy `X-RateLimit-*` headers exist for compatibility but are unnecessary for a greenfield service.

### Decision 9: Configuration surface — four env vars + production assertion

**Choice**: Four env vars in `src/config/env.ts`:

| Var | Type | Default | Purpose |
|---|---|---|---|
| `RATE_LIMIT_ENABLED` | boolean | `true` | Master switch — `false` disables the middleware entirely (for unit/integration tests that need unlimited requests) |
| `RATE_LIMIT_WINDOW_MS` | int | `60000` | Window length in milliseconds (1 minute) |
| `RATE_LIMIT_MAX` | int | `1000` | Max requests per window per IP |
| `RATE_LIMIT_ALLOWLIST_CIDRS` | string | `''` | Comma-separated CIDRs that bypass the limiter (in addition to loopback, which is always bypassed) |

A startup assertion in `loadConfig()` parses `RATE_LIMIT_ALLOWLIST_CIDRS` and refuses to boot when `NODE_ENV === 'production'` and the parsed list contains `0.0.0.0/0` or `::/0`. The error message points at this design doc.

**Why these four and not more**: every config knob is a future maintenance burden. These four cover: enable/disable, window, limit, bypass. Anything finer (per-route, per-method, per-key-strategy) is YAGNI.

## Risks / Trade-offs

| Risk | Impact | Mitigation |
|---|---|---|
| **Redis on the hot path of every request** | RPS regression vs `Benchmark.md` baseline | Re-run `read-load` and `mixed` scenarios after the change. Reject the change if p99 regresses >5%. If it does, fall back to in-process storage and document the multiplier story in the spec. |
| **`trust proxy` mis-set** | Limiter either bypassed by everyone (loopback always matches the public client's spoofed header) or by no one (real client IP invisible) | Decision 5 pins the value to `'loopback, linklocal, uniquelocal'`. An integration test asserts that a request with a forged `X-Forwarded-For: 127.0.0.1` from a non-loopback peer is still rate-limited. |
| **Allow-list misconfigured to `0.0.0.0/0`** | Limiter is silently a no-op in production | Startup assertion in `loadConfig()` refuses to boot. Unit test asserts the assertion fires for `0.0.0.0/0` and `::/0` (and any CIDR that includes them, e.g. `0.0.0.0/1`). |
| **Healthcheck or metrics scrape consumes the bucket** | Three replicas × healthcheck-every-5s × forever eventually trips the limit on the nginx container's IP | Exclusion list (`/healthz`, `/metrics`) inside the middleware skips counting entirely — these paths are not bypassed (which would still count, just not block); they are not seen by the limiter at all. |
| **`req.ip` is undefined for some path** (e.g. tests using mock requests) | Limiter throws on `undefined.indexOf(...)` | Defensive check: if `req.ip` is falsy, skip and log at `warn` level once per process. Unit test covers this. |
| **`rate-limit-redis` version incompatible with the ioredis version we have** | Build break or runtime error | Pin both versions in `package.json` at install time and confirm the integration test passes against the running Testcontainers Redis. |
| **Bypass leak via `X-Forwarded-For` from a misconfigured nginx** | Real clients get treated as loopback | Decision 5 pins `trust proxy` to a conservative list. The s11 nginx config does not set `X-Forwarded-For: 127.0.0.1` — this would be a separate, deliberate misconfiguration. |
| **Integration test flakiness from clock dependency** | Test occasionally fails when the window boundary lands mid-test | Use a small `RATE_LIMIT_MAX` (e.g. 5) and `RATE_LIMIT_WINDOW_MS=60000` so the test fires the limiter in well under a window. Reset Redis between tests via the existing Testcontainers fixture. |
| **The 5% regression budget is too tight** | Change is rejected for a measurement-noise regression | The benchmark methodology in `Benchmark.md` already documents run-to-run variance. The 5% budget is on p99 from a multi-run mean, not a single run. If the variance bites, run more iterations rather than relaxing the budget. |
| **New deps introduce supply-chain risk** | npm package compromise | `pnpm-lock.yaml` pins the resolved tree. Both packages are widely used (`express-rate-limit` has >2M weekly downloads); risk is not zero but is not unique to this change. |

## Migration Plan

This is an additive change. There is no migration of existing data, no DB schema change, no config rename.

1. Add the dependencies and pin them.
2. Add the four env vars to `src/config/env.ts` with defaults that preserve the dev workflow (`RATE_LIMIT_ENABLED=true`, generous defaults).
3. Land the middleware factory + tests + wiring in `src/http/app.ts` in a single commit.
4. Re-run `mise run check` (typecheck + lint + unit + integration) — must pass.
5. Re-run `mise run bench:smoke` against the dev compose stack — must report 0% 429s.
6. Re-run `mise run bench:read` against the dev compose stack — must show <5% p99 regression vs `Benchmark.md`.
7. Re-run `mise run bench:prod:smoke` and `mise run bench:prod:read` against the s11 prod compose stack (if s11 is available) — same assertions.
8. Update `Benchmark.md` and `Benchmark_prod.md` Methodology sections to note that the limiter is on and the bypass is the loopback path.
9. Document the new env vars in `.env.example` and the `README.md`.

**Rollback**: If the benchmark regression budget is exceeded, revert the wiring in `src/http/app.ts` (keep the middleware factory file but do not call it). The four env vars can remain — they are no-ops if the middleware is not wired.

## Open Questions

1. **What should `RATE_LIMIT_MAX` actually default to?** The proposal says 1000/min. Verify against `Benchmark.md`'s achieved single-replica RPS (~5,000) — at 5,000 rps a benchmark client would hit 1000 in 200 ms and need the bypass. The bypass *is* the design, but the default needs to be high enough that a *real* user (browser, mobile app) never hits it. 1000/min = ~16/sec sustained, which is fine for any human-driven UI. **Answer at implementation time.**
2. **Should the limiter's 429 carry the canonical `Retry-After` value from `express-rate-limit`'s computed reset time, or a fixed value?** The library exposes `req.rateLimit.resetTime` — use that. **Answer: use the library value, no fixed override.**
3. **Should the `loopback` skip also include the IPv4-mapped IPv6 loopback `::ffff:127.0.0.1`?** Some Node versions surface loopback this way under dual-stack listeners. **Answer: yes, cover all three forms; unit test pins the list.**
4. **Should the in-compose `bench` profile in `docker-compose.yml` set `RATE_LIMIT_ALLOWLIST_CIDRS` to the bridge subnet, or set `RATE_LIMIT_ENABLED=false`?** The cleaner story is the allow-list (proves the bypass mechanism works in compose), but the simpler story is just disabling it (one less code path to test). **Lean: allow-list, because it exercises the same code path the host k6 uses.**
5. **Is the Docker bridge subnet stable enough to hardcode in compose env?** The default is `172.16.0.0/12` but Docker can pick a different range if there is a conflict. **Answer at implementation time — if it's not stable, fall back to `RATE_LIMIT_ENABLED=false` for the in-compose profile only.**
