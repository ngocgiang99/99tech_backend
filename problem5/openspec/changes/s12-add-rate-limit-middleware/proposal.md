## Why

The Resources API exposes `GET/POST/PUT/PATCH/DELETE /resources` to anyone who can reach the port, with no per-IP throttling. The error contract from `s08-add-error-handling` already reserves `RateLimitError` and the public `RATE_LIMIT` error code, but no producer is wired in — the slot is reserved and empty. A single misbehaving client (or a benign integration test that forgot a backoff) can drive the API to its CPU ceiling and starve every other caller, and there is no first line of defense in front of the application logic. At the same time, the s05/s11 benchmark workflow needs k6 to push thousands of requests per second from `localhost` against the same API, so any rate limiter that ships also has to expose a reliable, narrowly-scoped bypass — otherwise the very capability that protects production silently breaks the benchmark suite.

This change adds a per-IP rate-limit middleware backed by Redis (the same instance the response cache already uses), wires it into `src/http/app.ts` between the request logger and the body parser, and ships a loopback bypass plus an env-configurable allow-list so host k6 runs against the dev *and* prod (s11) compose stacks continue to hit zero 429s. It closes the open contract from `error-handling` by emitting `RATE_LIMIT` 429 responses through the existing `AppError` path, and it does so without changing any existing endpoint, scenario script, or threshold.

## What Changes

- Introduce a new `src/middleware/rate-limit.ts` middleware factory that returns an `express-rate-limit` instance configured with a `rate-limit-redis` store, a per-IP key generator, a sliding window, an env-configurable limit and window, and a `skip` callback that consults the bypass policy (loopback + allow-list).
- Wire the middleware into `src/http/app.ts` **after** `pinoHttp` and **before** `express.json()`, so rate-limited requests are logged (with request id) and counted in HTTP metrics but never pay the body-parse cost.
- Exclude `/healthz` and `/metrics` from the limiter entirely (not just bypassed) so Docker healthchecks and Prometheus scrapes never consume the bucket — neither path participates in the counter at all.
- Set `app.set('trust proxy', 'loopback, linklocal, uniquelocal')` in `buildApp` so `req.ip` reflects the real client IP when the API runs behind nginx in the s11 prod stack, instead of always reading the nginx container's bridge address.
- Wire `RateLimitError` (already defined in `src/shared/errors.ts` from s08) as the producer: when `express-rate-limit`'s handler fires, it constructs and `next()`s a `RateLimitError` with the standard `Retry-After` value attached to `details`, so the central error handler renders the canonical `{ error: { code: "RATE_LIMIT", ... } }` body and logs at the documented level. No bespoke 429 JSON body is constructed in the middleware.
- Add IETF-draft response headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and a `Retry-After` header on 429 responses, sourced from `express-rate-limit`'s built-in `standardHeaders: 'draft-7'` mode. Existing `X-Request-Id` and `X-Cache` headers are unchanged.
- Add config to `src/config/env.ts`: `RATE_LIMIT_ENABLED` (boolean, default `true`), `RATE_LIMIT_WINDOW_MS` (default `60000`), `RATE_LIMIT_MAX` (default `1000`), `RATE_LIMIT_ALLOWLIST_CIDRS` (comma-separated CIDR list, default empty). Add a startup assertion that refuses to boot when `NODE_ENV=production` and the parsed allow-list contains `0.0.0.0/0` or `::/0` — the wide-open bypass is the obvious foot-gun, and it should be impossible to ship by accident.
- Loopback bypass (`127.0.0.1`, `::1`) is **always on** regardless of env: it requires no configuration, has no security story (a remote attacker cannot have a loopback source IP after `trust proxy` is set correctly), and it is the exact code path host k6 takes against both compose stacks.
- Update the `bench` profile in `docker-compose.yml` and the `k6` service in `docker-compose.prod.yml` so an in-compose k6 run from inside the Docker bridge network is also covered: `RATE_LIMIT_ALLOWLIST_CIDRS` is set to the bridge subnet for those compose runs only — this is a per-compose-file env override, not a code change.
- Add unit tests for the bypass `skip` function (loopback always allowed; allow-list CIDR matching; non-matching IP not allowed) and for the `RateLimitError` mapping. Add an integration test that hammers `GET /resources` from supertest until a 429 is observed, asserts the response body shape matches the `error-handling` allowlist, and asserts `Retry-After` is present and parseable. Add a second integration test that runs the same hammer from `127.0.0.1` and asserts zero 429s are observed.
- Add a benchmark sanity step to `Benchmark.md` and `Benchmark_prod.md` re-runs (covered by s11): the smoke scenario must report 0% 429 errors after this change lands. If it does not, the bypass is broken end-to-end and the change is rejected.
- Document the new env vars in `.env.example` and add a "Rate limiting" subsection to `README.md` covering: what is limited, the default limits, the bypass policy, how to disable it for local development, and the production safety assertion.

This change is **additive**. No existing endpoint, scenario script, benchmark threshold, or error code is modified. The `error-handling` capability already declares `RATE_LIMIT` as a stable code; this change is the producer that finally emits it.

## Capabilities

### New Capabilities

- `rate-limiting`: The contract for how the Resources API throttles incoming requests — what is counted, what scope (per-IP, global), how the bypass works, what 429 responses look like, and how the limit is observable through existing metrics and logs.

### Modified Capabilities

None. The `error-handling` capability already declares `RATE_LIMIT` as a stable error code with a reserved `RateLimitError` subclass; this change wires the producer without changing any existing requirement. The `metrics-observability` capability already counts every status code via `http_requests_total` so 429s show up automatically without a spec change.

## Impact

- **New files**:
  - `src/middleware/rate-limit.ts` — middleware factory.
  - `src/middleware/__tests__/rate-limit.test.ts` (or wherever the existing middleware unit tests live — sibling to `error-handler.ts`).
  - `tests/integration/rate-limit.test.ts` — supertest hammer + bypass test.
- **Modified files**:
  - `src/http/app.ts` — wire middleware, set `trust proxy`, exclude `/healthz` and `/metrics` paths.
  - `src/config/env.ts` — Zod schema entries + production safety assertion.
  - `.env.example` — document the four new env vars and the bypass behavior.
  - `README.md` — new "Rate limiting" subsection under the API documentation.
  - `package.json` / `pnpm-lock.yaml` — add `express-rate-limit` and `rate-limit-redis` dependencies.
  - `docker-compose.yml` (bench profile) and `docker-compose.prod.yml` (k6 service if present) — add `RATE_LIMIT_ALLOWLIST_CIDRS` env for the in-compose k6 path only.
- **New dependencies**: `express-rate-limit` (MIT) and `rate-limit-redis` (MIT). Both are mature, both have TypeScript types, both are pinned at install time.
- **APIs exposed**: No new routes. Every existing route MAY now return `429 RATE_LIMIT` instead of its 2xx/4xx response when the bucket is exhausted; the response body shape is the same `{ error: { code, message, requestId, ... } }` envelope used by all other errors.
- **Systems affected**: Redis is now on the hot path of every request (one `INCR` + `EXPIRE` round-trip per request through the limiter). The response cache was already on the hot path, so this is a marginal increase, but it must be measured: the change rejects itself if the s11 benchmark re-run shows a regression of more than 5% on `read-load` p99.
- **Breaking changes**: None. Existing 2xx/4xx responses are unchanged. New 429 responses are an addition to the documented error code set, and the code itself was already reserved by `error-handling`.
- **Depends on**: `s08-add-error-handling` (must be archived — provides `RateLimitError` and the central handler) and `s11-add-multi-replica-prod-compose` (must be on disk, not necessarily archived — provides the prod compose file that the trust-proxy decision and the in-compose k6 allow-list both target). Does NOT depend on `s07-add-prometheus-metrics` or `s09-add-grafana-dashboards`, but the 429 metric labels they already define are populated automatically once this change lands.
