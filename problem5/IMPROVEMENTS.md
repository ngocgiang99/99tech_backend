# IMPROVEMENTS

Gaps between this service and a production-ready CRUD API. Ordered by priority.

Assumes s01–s11 are archived and s12 (rate limiting) lands. Does not repeat things the codebase already does well (metrics, logs, keyset pagination, graceful shutdown, cache-aside invalidation, layered architecture, Testcontainers tests, k6 benchmarks).

## 1. Authentication & authorization — blocker for prod

- `POST/GET/PATCH/DELETE /resources` is fully open. Anyone who reaches the port owns the data.
- `resources.owner_id` exists in the schema but nothing enforces it. A caller can read or mutate any resource by id.
- **Minimum:** JWT bearer (RS256, JWKS-verified) on every `/resources` route; `owner_id` derived from the token, not the request body; list/get/update/delete scoped to the token's subject unless an `admin` claim is present.
- Middleware slot: after `rate-limit` (so anonymous floods are cheap to reject), before `express.json()`.

## 2. Optimistic concurrency control on PATCH

- `PATCH /resources/:id` has no version guard. Two concurrent updates silently clobber — last writer wins, no 409.
- **Minimum:** send `ETag: "<updated_at ISO>"` on every GET; require `If-Match` on PATCH/DELETE; repository adds `AND updated_at = $expected` to the `UPDATE`; zero rows affected → `ConflictError`.
- Fits the existing `AppError` pipeline — no new error code needed.

## 3. CI pipeline

- No `.github/workflows`. `mise run check` exists but nothing enforces it on PR.
- **Minimum:** one workflow — install → `mise run check` (typecheck + lint + unit + integration) → `docker build`. Gate merges on green.
- Branch protection on `main` blocking force-push and requiring the check.

## 4. Secret management

- `.env` is the only story. No rotation, no Vault/SOPS/SSM, `DATABASE_URL` lives in the compose file.
- **Minimum:** document "how secrets are injected in prod" in README (e.g. mounted file, env from secrets manager). Remove any real credential from `.env.example` and `docker-compose.prod.yml`. Add a pre-commit hook or CI step that blocks committing `.env`.

---

## Scoped out on purpose

These are legitimate gaps but not worth doing in this repo:

- **OpenTelemetry tracing** — the existing metrics + logs + request IDs answer the questions a single-service CRUD API faces. Add it only when you have a multi-service call graph to trace.
- **Sentry / error aggregator** — centralised logs already group errors via `error_id`. Add it when you need stack traces from real users and release-tagged grouping.
- **Feature flags** — no feature-flag use case exists yet. Adding LaunchDarkly / Unleash infrastructure before the first flag is pure overhead.
- **Multi-region / active-active** — the service is stateless except for Postgres and Redis. Region replication is a data-store problem, not an app problem.
