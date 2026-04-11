## Why

problem6's `HttpExceptionFilter` currently produces shallow error output: the log line is a single concatenated string (`[${requestId}] HttpException 500: ${msg}`) with the stack attached as a second argument, and the response envelope carries only `{ code, message, requestId, hint }`. When a 500 hits at 3am, an operator has:

- The requestId, which collides with other log lines for the same request (info, warn, error) and makes grepping noisy.
- A top-level message and a stack — but no walked `Error.cause` chain, so wrapped errors (e.g. a domain `IdempotencyViolationError` wrapping a raw `pg` error) only show the top layer.
- No structured fields — you cannot query logs by `error.code`, `error.status`, `error.errorClass`, or `pg.sqlstate`.
- No per-error correlation UUID that the user can cite back to the operator: "here's the 500 I saw at 3pm" → "which one, I have 47 errors in that minute."
- No `errors_total{code,status}` Prometheus counter for fleet-wide alerting.
- No header/query/body-size context captured at the moment of failure, which means reproducing a failing request requires out-of-band correlation with access logs.

The sibling module at `problem5/` has a mature error-handling architecture that solves all of these: a typed `AppError` hierarchy with stable `code` fields, a `buildErrorMetadata` function that walks cause chains and captures scrubbed request context, a `toPublicResponse` allowlist builder that prevents internal fields from leaking, a `mapDbError` that preserves Postgres SQLSTATE codes, and an `errors_total` counter at the handler layer. We want to adopt the same architecture in problem6, adapted to its NestJS/Fastify stack and its specific constraints (Redis fail-CLOSED behavior for GAP-03, JetStream outbox wrapping, zod validation).

This change does not alter the module's security, auth, or idempotency semantics. It is purely a debuggability and observability improvement to the error subsystem. Redis fail-CLOSED (the `isRedisInfrastructureError` detection path that translates ioredis throws to 503) is preserved unchanged — its behavior is tightened and made more explicit via the new error hierarchy, not removed.

## What Changes

- **NEW (capability)**: `scoreboard-errors` — a new capability owning the `AppError`/`DomainError` hierarchy, `buildErrorMetadata`, `toPublicResponse`, the header scrubber, and the `mapDbError` Postgres mapper. This is the "shared primitives" layer that the interface, application, and infrastructure layers all import from. The hierarchy lives at `src/scoreboard/shared/errors/` (or a similar path chosen in design.md Decision 1).
- **NEW (code)**: `DomainError extends HttpException` as the abstract base, with the following concrete subclasses that each wrap a stable `ErrorCode` string, a canonical HTTP status, an optional structured `details` payload, and an optional `cause` chain: `ValidationError` (400), `BadRequestError` (400), `UnauthenticatedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409), `UnprocessableEntityError` (422), `RateLimitError` (429), `IdempotencyReplayError` (a 200 pseudo-error for replay responses — see design.md Decision 4), `DependencyUnavailableError` (503), `InternalError` (500). Each subclass is ~10 lines; the whole hierarchy is ~120 LOC.
- **NEW (code)**: `buildErrorMetadata()` in the `scoreboard-errors` capability — walks `Error.cause` up to 5 levels deep, captures method/route/query (capped at 2KB)/scrubbed headers/body size + content-type/userAgent/remoteAddr/timestamp/pgCode(if present)/errorClass/stack. Returns a serializable object for Pino structured logging. ~120 LOC including the scrubber.
- **NEW (code)**: `scrubHeaders()` — redacts sensitive headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `action-token`, any configured extras) to the string `"[redacted]"`. Default denylist + caller-provided extras. ~30 LOC.
- **NEW (code)**: `mapDbError()` — intercepts Postgres errors (structural check on `{ code, name }` to avoid hard dependency on `pg.DatabaseError`), maps 7 SQLSTATE codes to typed domain errors (`23505 → ConflictError`, `23502 → ValidationError`, `23503 → ValidationError`, `22001 → ValidationError`, `40P01 → DependencyUnavailableError`, `57014 → DependencyUnavailableError`, `53300 → DependencyUnavailableError`), and attaches the raw `pgCode` as a non-enumerable property for the metadata builder. ~80 LOC.
- **NEW (code)**: `toPublicResponse()` — allowlist builder that constructs the public envelope from scratch (NEVER serializing the raw error object). Emits `{ code, message, requestId, details? (Validation only), errorId? (5xx only) }`. For any `InternalError`, always replaces the message with the generic `"Internal server error"` as a leak-prevention guarantee. ~60 LOC.
- **MODIFIED (code)**: `HttpExceptionFilter` is rewritten to orchestrate the new primitives: (1) `headersSent` idempotency guard, (2) `wrapUnknown()` coerces any thrown value to an `AppError`, (3) generate a fresh `errorId` UUID for 5xx correlation, (4) call `buildErrorMetadata()` for the structured log payload, (5) emit one structured Pino log line at `warn` (<500) or `error` (≥500), (6) increment `scoreboard_errors_total{code,status}` counter, (7) call `toPublicResponse()` and send. The `isRedisInfrastructureError` detection is preserved — when matched, the filter wraps the raw error in `DependencyUnavailableError` with `code: 'TEMPORARILY_UNAVAILABLE'` before the metadata pass, so the log/response/metric all show the fail-CLOSED semantics uniformly.
- **MODIFIED (code)**: 33 throw sites across 14 files are refactored from `throw new ForbiddenException(...)` / `throw new UnauthorizedException(...)` / `throw new HttpException(...)` / `throw new InternalServerErrorException(...)` to the new `DomainError` subclasses. Files touched: guards (`jwt.guard.ts`, `action-token.guard.ts`, `rate-limit.guard.ts`), controllers (`scoreboard.controller.ts`, `actions.controller.ts`, `leaderboard.controller.ts`), domain value objects and aggregate (mostly `InvalidArgumentError` → `ValidationError`), infrastructure adapters (`user-score.repository.impl.ts`, `jetstream.event-publisher.ts`, `hmac-action-token.verifier.ts`, `leaderboard-types.ts`). The public HTTP behavior for each site is preserved — status codes do not change.
- **MODIFIED (code)**: `KyselyUserScoreRepository` (and any other repository that issues raw Kysely calls) wraps its operations in a try/catch that routes errors through `mapDbError()`. `IncrementScoreHandler`'s existing `IdempotencyViolationError` catch path keeps working because `mapDbError` returns a `ConflictError` subclass that the handler can still pattern-match on (the handler's `instanceof` check is updated to use the new class, or a compatibility alias is added — decided in design.md Decision 7).
- **MODIFIED (code)**: `WritePathMetrics` (or wherever Prometheus counters live) gains an `errors_total` counter with labels `{code, status}`. Wired into the filter.
- **MODIFIED (spec)**: `scoreboard-observability` gets a new requirement: "Error envelope and structured log metadata". Scenarios cover errorId presence for 5xx, cause chain walking, scrubbed headers, metric emission, InternalError message leak prevention.
- **MODIFIED (spec)**: `scoreboard-quality` testing requirements are extended to mandate unit tests for every `DomainError` subclass, for the header scrubber denylist, for `mapDbError` against all 7 SQLSTATE codes, and for `toPublicResponse`'s InternalError leak guarantee.
- **MODIFIED (docs)**: No user-visible README changes. An internal note may be added to `src/scoreboard/shared/errors/README.md` (or inline JSDoc) explaining the hierarchy + when to use each subclass.
- **NOT CHANGED**: NestJS guards still throw subclasses of `HttpException` — the new `DomainError` extends `HttpException`, so `@UseGuards()` integration is unchanged. Rate limit guard continues to throw its 503 (fail-CLOSED) path via the new `DependencyUnavailableError`. Zod validation still produces `ZodError`, which the filter maps to `ValidationError` as part of `wrapUnknown()`. The `InvalidArgumentError` domain class is either absorbed into the new `ValidationError` or kept as a thin alias — decided in design.md.

## Capabilities

### New Capabilities

- `scoreboard-errors`: Typed error hierarchy, error metadata builder, header scrubber, Postgres SQLSTATE mapper, public-response allowlist builder, and the error-handling filter contract. This is the shared primitives layer for all error handling across the module.

### Modified Capabilities

- `scoreboard-observability`: Adds requirements for errorId generation on 5xx, structured Pino log metadata fields (method/route/headers/body size/userAgent/remoteAddr/cause chain), `scoreboard_errors_total{code,status}` counter, and the `InternalError` message leak prevention rule.
- `scoreboard-quality`: Extends testing requirements to mandate unit test coverage for the new error primitives (hierarchy, scrubber, metadata builder, pg mapper, public-response builder) and integration tests for the rewritten filter's end-to-end behavior.

## Impact

**New code (~500 LOC):**
- `src/scoreboard/shared/errors/error-codes.ts` — the `ErrorCode` union and `ERROR_CODE_META` table (~40 LOC)
- `src/scoreboard/shared/errors/domain-error.ts` — `DomainError` base class + 10 subclasses (~140 LOC)
- `src/scoreboard/shared/errors/error-metadata.ts` — `buildErrorMetadata()` + `CauseEntry` + cause walker (~120 LOC)
- `src/scoreboard/shared/errors/scrub-headers.ts` — default denylist + `scrubHeaders()` (~30 LOC)
- `src/scoreboard/shared/errors/map-db-error.ts` — Postgres SQLSTATE mapper (~80 LOC)
- `src/scoreboard/shared/errors/to-public-response.ts` — response allowlist builder (~60 LOC)
- `src/scoreboard/shared/errors/wrap-unknown.ts` — coerce arbitrary thrown values to `AppError` (~20 LOC)
- `src/scoreboard/shared/errors/index.ts` — barrel export (~10 LOC)

**Modified code (~200 LOC):**
- `src/scoreboard/interface/http/error-filter.ts` — rewritten to orchestrate the new primitives (~120 LOC net — roughly a wash; the old `deriveHttpExceptionCode` switch disappears)
- 33 throw sites in 14 files — each change is ~1-3 lines (swap the constructor), total ~80 LOC of diffs
- `src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts` — wrap DB calls in `mapDbError` (~15 LOC)
- `src/shared/metrics/write-path-metrics.ts` — add `errorsTotal` counter (~10 LOC)

**New tests (~400 LOC):**
- `test/unit/shared/errors/domain-error.test.ts` — class hierarchy tests (~80 LOC)
- `test/unit/shared/errors/scrub-headers.test.ts` — denylist tests (~50 LOC)
- `test/unit/shared/errors/error-metadata.test.ts` — cause walking, field shape, pgCode handling (~100 LOC)
- `test/unit/shared/errors/map-db-error.test.ts` — all 7 SQLSTATE codes + non-pg fallback (~80 LOC)
- `test/unit/shared/errors/to-public-response.test.ts` — allowlist, InternalError leak prevention (~50 LOC)
- `test/unit/shared/errors/wrap-unknown.test.ts` — pass-through, unknown coercion (~30 LOC)
- Existing `test/unit/interface/http/error-filter.test.ts` updated to match the new orchestration (~50 LOC net change)

**Operational consequences:**
- Structured logs. Grep-by-requestId loses ambiguity because errorId is a distinct correlation field for 5xx. Cause chains become visible in log JSON.
- One new metric. `scoreboard_errors_total{code,status}` — enables Grafana alerts on error rate by code.
- No behavior change on the hot path. Happy-path requests don't hit the filter, so throughput is unaffected. Error-path latency goes up by ~0.5ms per call (metadata builder + pg code detection), which is irrelevant against the existing 5xx SLO.
- No config changes. No new env vars.
- No database migration.
- No breaking API change. The public envelope gains optional fields (`errorId`, `details`) and a promise that `InternalError`'s message is always generic. Existing clients that only read `code`/`message`/`requestId` continue to work unchanged.

**Out of scope:**
- Alerting rules and Grafana dashboards — operator configuration, not code.
- OpenTelemetry span-level error enrichment — the existing tracer integration is untouched; this change operates at the HTTP filter layer only.
- Retry semantics or circuit breakers — purely defensive error reporting, not recovery strategy.
- Any change to auth (`JwtGuard`, `ActionTokenGuard`), rate limit behavior, idempotency, or outbox semantics. The refactor swaps exception constructors but does not alter control flow.
- Removing NestJS's built-in exceptions from the codebase entirely — third-party libraries (Nest itself, `@nestjs/throttler` if added later, etc.) may still throw `HttpException` subclasses, and the filter's fallback branch handles them.
