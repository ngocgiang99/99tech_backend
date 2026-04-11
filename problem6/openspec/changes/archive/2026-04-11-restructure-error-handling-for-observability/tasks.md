## 1. Error codes + metadata table

- [x] 1.1 Create `src/scoreboard/shared/errors/error-codes.ts`
- [x] 1.2 Export `ERROR_CODES` readonly tuple with exactly these 10 strings in order: `VALIDATION`, `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE_ENTITY`, `RATE_LIMIT`, `TEMPORARILY_UNAVAILABLE`, `INTERNAL_ERROR`
- [x] 1.3 Export `ErrorCode` type as `typeof ERROR_CODES[number]`
- [x] 1.4 Export `ERROR_CODE_META: Record<ErrorCode, { status: number; defaultMessage: string }>` with statuses 400, 400, 401, 403, 404, 409, 422, 429, 503, 500 in that order
- [x] 1.5 Add helper functions `errorStatusFor(code)` and `defaultMessageFor(code)` that read from the table

## 2. DomainError hierarchy

- [x] 2.1 Create `src/scoreboard/shared/errors/domain-error.ts`
- [x] 2.2 Implement `abstract class DomainError extends HttpException` with properties `code: ErrorCode`, `details?: unknown`, `cause?: unknown`, constructor `(code, message, opts?)` that calls `super({code, message}, ERROR_CODE_META[code].status, opts?.cause !== undefined ? { cause: opts.cause } : undefined)` and sets `this.name = this.constructor.name`
- [x] 2.3 Implement the 10 concrete subclasses: `ValidationError`, `BadRequestError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`, `RateLimitError`, `DependencyUnavailableError`, `InternalError`. Each subclass ≈8 lines (constructor + `get [Symbol.toStringTag]()` override)
- [x] 2.4 `ValidationError` constructor accepts `(message?, details?)` — the other subclasses accept `(message?, opts?: { details?, cause? })`
- [x] 2.5 Create `test/unit/shared/errors/domain-error.test.ts` — one `describe` per subclass, verify `code`/`status`/`message`/`instanceof HttpException`/`instanceof DomainError`
- [x] 2.6 Run the test file in isolation: `mise run test -- test/unit/shared/errors/domain-error.test.ts` — confirm all green

## 3. Header scrubber

- [x] 3.1 Create `src/scoreboard/shared/errors/scrub-headers.ts`
- [x] 3.2 Export `DEFAULT_HEADER_DENYLIST: readonly string[]` containing `'authorization'`, `'cookie'`, `'set-cookie'`, `'x-api-key'`, `'action-token'`
- [x] 3.3 Export `scrubHeaders(headers: Record<string, unknown>, extraDenylist?: readonly string[]): Record<string, unknown>` that returns a NEW object with denylist entries replaced by `'[redacted]'`, case-insensitive
- [x] 3.4 Create `test/unit/shared/errors/scrub-headers.test.ts` — test each default denylist entry, case-insensitive matching, extra denylist parameter, non-denylist passthrough
- [x] 3.5 Run the test file in isolation

## 4. mapDbError

- [x] 4.1 Create `src/scoreboard/shared/errors/map-db-error.ts`
- [x] 4.2 Import only from `./domain-error.js` (never from `pg` directly — avoid the hard dependency)
- [x] 4.3 Implement `isPgError(err: unknown): err is { code: string; message: string; column?: string; name?: string }` as a structural type guard checking `typeof err.code === 'string' && (err.name === 'error' || err.name === 'DatabaseError')`
- [x] 4.4 Implement `attachPgCode(appErr: DomainError, pgCode: string): void` using `Object.defineProperty` with `enumerable: false, configurable: true, writable: false`
- [x] 4.5 Implement `mapDbError(err: unknown): DomainError` with a switch on `err.code` handling `23505 → ConflictError`, `23502 → ValidationError` (include column in details), `23503 → ValidationError`, `22001 → ValidationError`, `40P01 → DependencyUnavailableError`, `57014 → DependencyUnavailableError`, `53300 → DependencyUnavailableError`, default → `InternalError`. Attach `pgCode` to every mapped error. Non-pg values return `InternalError` with the original as cause
- [x] 4.6 Create `test/unit/shared/errors/map-db-error.test.ts` — one `it` per handled SQLSTATE, plus "unknown pg code falls through" and "non-pg value → InternalError", plus a test verifying `pgCode` is non-enumerable via `JSON.stringify(mapped).indexOf('pgCode') === -1`
- [x] 4.7 Run the test file in isolation

## 5. Error metadata builder

- [x] 5.1 Create `src/scoreboard/shared/errors/error-metadata.ts`
- [x] 5.2 Export `interface CauseEntry { class: string; message: string; }`
- [x] 5.3 Export `interface ErrorMetadata` with the 17 fields listed in the `scoreboard-errors` spec (errorId, errorClass, code, status, message, stack?, pgCode?, cause, requestId, method, route, headers, query, body, userAgent, remoteAddr, timestamp)
- [x] 5.4 Implement `walkCause(err: unknown, depth = 0): CauseEntry[]` recursive walker with `MAX_CAUSE_DEPTH = 5`, stops on non-Error
- [x] 5.5 Implement `buildErrorMetadata(err: DomainError, request: FastifyRequest & { requestId?: string }, errorId: string): ErrorMetadata` that extracts fields from `err` and `request`, calls `scrubHeaders` on the raw headers, caps query at `MAX_QUERY_BYTES = 2048`, reads `content-length` for body size (null if missing), and returns the full metadata object
- [x] 5.6 Use `request.routeOptions?.url ?? request.url ?? '__unmatched'` for the route field (Fastify-specific)
- [x] 5.7 Create `test/unit/shared/errors/error-metadata.test.ts` — test depth-5 cause walking, scrubbed headers, query capping with '...' suffix, null body size for missing content-length, non-enumerable pgCode capture
- [x] 5.8 Run the test file in isolation

## 6. Public response builder

- [x] 6.1 Create `src/scoreboard/shared/errors/to-public-response.ts`
- [x] 6.2 Export `truncate(s: string, maxLen: number): string` with `'...'` suffix on truncation
- [x] 6.3 Export const `MESSAGE_MAX_LEN = 200`
- [x] 6.4 Implement `toPublicResponse(err: DomainError, requestId: string | null, errorId: string | null): { status: number; body: { error: Record<string, unknown> } }` with the exact rules from the `scoreboard-errors` spec: allowlist, `InternalError` message replacement, `details` only for `ValidationError`, `errorId` only when non-null
- [x] 6.5 Create `test/unit/shared/errors/to-public-response.test.ts` — test standard envelope, `InternalError` leak prevention (message + embedded secret string), 200-byte truncation, `details`-only-for-`ValidationError`, `errorId`-only-for-non-null
- [x] 6.6 Run the test file in isolation

## 7. wrapUnknown

- [x] 7.1 Create `src/scoreboard/shared/errors/wrap-unknown.ts`
- [x] 7.2 Move the existing `isRedisInfrastructureError()` function from `error-filter.ts` into this file, unchanged
- [x] 7.3 Implement `wrapUnknown(exception: unknown): DomainError` with the 7-branch priority chain from design.md Decision 4
- [x] 7.4 Branch 2 (NestJS `HttpException`): map by `exception.getStatus()` — 400 → `BadRequestError`, 401 → `UnauthenticatedError`, 403 → `ForbiddenError`, 404 → `NotFoundError`, 409 → `ConflictError`, 422 → `UnprocessableEntityError`, 429 → `RateLimitError`, 503 → `DependencyUnavailableError`, any 5xx → `InternalError`, other 4xx → `BadRequestError`. Preserve the NestJS `exception.message`.
- [x] 7.5 Branch 3 (`ZodError`): wrap in `ValidationError` with `exception.issues` as `details`, and `exception.issues.map(i => i.message).join('; ')` as message
- [x] 7.6 Branch 4 (pg-shaped): delegate to `mapDbError(exception)` using the same structural check
- [x] 7.7 Branch 5 (Redis infra): wrap in `DependencyUnavailableError` with `'Service temporarily unavailable'` message and the original as cause
- [x] 7.8 Create `test/unit/shared/errors/wrap-unknown.test.ts` — one test per branch, including the pass-through case
- [x] 7.9 Run the test file in isolation

## 8. Barrel export + shared/errors index

- [x] 8.1 Create `src/scoreboard/shared/errors/index.ts` exporting: `DomainError`, all 10 subclasses, `ErrorCode`, `ERROR_CODES`, `ERROR_CODE_META`, `errorStatusFor`, `defaultMessageFor`, `wrapUnknown`, `buildErrorMetadata`, `ErrorMetadata`, `CauseEntry`, `scrubHeaders`, `DEFAULT_HEADER_DENYLIST`, `mapDbError`, `toPublicResponse`
- [x] 8.2 Run `mise run typecheck` — confirm the barrel compiles

## 9. Rewrite HttpExceptionFilter

- [x] 9.1 Open `src/scoreboard/interface/http/error-filter.ts`
- [x] 9.2 Delete `deriveHttpExceptionCode`, `isRedisInfrastructureError` (moved to wrap-unknown), and the `ErrorEnvelope` interface (replaced by `toPublicResponse` output shape)
- [x] 9.3 Import `wrapUnknown`, `buildErrorMetadata`, `toPublicResponse` from the barrel
- [x] 9.4 Inject the `errorsTotal` counter via `@Inject(METRIC_ERRORS_TOTAL)` (token name declared in Task 10.1)
- [x] 9.5 Rewrite `catch()` to exactly 9 steps: (1) idempotency guard `if (reply.raw.headersSent) return;`, (2) `const appErr = wrapUnknown(exception)`, (3) `const errorId = crypto.randomUUID()`, (4) `const metadata = buildErrorMetadata(appErr, request, errorId)`, (5) determine level by `appErr.getStatus() >= 500`, (6) call `logger[level](metadata, 'Request error')`, (7) increment the counter with `{code, status}`, (8) build `{status, body} = toPublicResponse(appErr, requestId, appErr.getStatus() >= 500 ? errorId : null)`, (9) `reply.status(status).send(body)`
- [x] 9.6 No `instanceof` branches remain in the filter after this refactor
- [x] 9.7 Update `test/unit/interface/http/error-filter.test.ts` — test each of the 10 `DomainError` subclasses, plus the Redis fail-CLOSED path (ioredis error), plus the idempotency guard (`headersSent = true`), plus the counter increment
- [x] 9.8 Run the filter test file in isolation — all green
- [x] 9.9 Run `mise run typecheck` — zero errors
- [x] 9.10 Run `mise run lint` — zero warnings

## 10. Metrics wiring

- [x] 10.1 Open `src/shared/metrics/write-path-metrics.ts`
- [x] 10.2 Add a `scoreboard_errors_total` Counter with labels `['code', 'status']`
- [x] 10.3 Export a DI token `METRIC_ERRORS_TOTAL = 'METRIC_ERRORS_TOTAL'`
- [x] 10.4 Register the counter in `src/shared/metrics/metrics.module.ts` via a provider
- [x] 10.5 Import the metrics module wherever `HttpExceptionFilter` is registered so the token is resolvable
- [x] 10.6 Run `mise run test -- test/unit/shared/metrics/` — confirm existing metric tests still pass and the new counter is registered

## 11. Refactor throw sites — guards

- [x] 11.1 Open `src/scoreboard/infrastructure/auth/jwt.guard.ts` — replace `throw new UnauthorizedException(...)` with `throw new UnauthenticatedError(...)` (5 occurrences)
- [x] 11.2 Open `src/scoreboard/infrastructure/auth/action-token.guard.ts` — replace `throw new ForbiddenException('INVALID_ACTION_TOKEN')` with `throw new ForbiddenError('INVALID_ACTION_TOKEN')` (at least 3 sites) and `throw new ForbiddenException('ACTION_ALREADY_CONSUMED')` with `throw new ForbiddenError('ACTION_ALREADY_CONSUMED')`
- [x] 11.3 Open `src/scoreboard/infrastructure/rate-limit/rate-limit.guard.ts` — replace `throw new HttpException('RATE_LIMITED', 429)` with `throw new RateLimitError(...)`, and the fail-CLOSED 503 throw with `throw new DependencyUnavailableError('TEMPORARILY_UNAVAILABLE', { cause: redisErr })`
- [x] 11.4 Run `mise run typecheck && mise run test -- test/unit/auth test/unit/rate-limit` — confirm all green
- [x] 11.5 Update the corresponding unit tests to match (`test/unit/auth/*.test.ts`, `test/unit/rate-limit/rate-limit.guard.test.ts`) — if any test asserts on `HttpException` construction, swap to `instanceof ForbiddenError` / `instanceof UnauthenticatedError` / etc.

## 12. Refactor throw sites — controllers

- [x] 12.1 Open `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` — the `InternalServerErrorException` throw inside the `IdempotencyViolationError` catch block becomes `throw new InternalError('Prior credit record not found for idempotent replay')`. Domain `IdempotencyViolationError` import unchanged — it's a plain Error, not a DomainError
- [x] 12.2 Open `src/scoreboard/interface/http/controllers/leaderboard.controller.ts` — audit and replace any NestJS exception imports with DomainError subclasses
- [x] 12.3 Open `src/scoreboard/interface/http/controllers/actions.controller.ts` — audit and replace
- [x] 12.4 Run `mise run test -- test/unit/interface/http/controllers` — confirm all green

## 13. Refactor throw sites — domain + infrastructure

- [x] 13.1 Open each value-object file: `user-id.ts`, `action-id.ts`, `score-delta.ts`, `score.ts`, `user-score.aggregate.ts`. These throw `InvalidArgumentError` which is a domain-layer error. DO NOT change these — they remain plain domain errors. `wrapUnknown()` will catch them via the generic Error branch and coerce them to `ValidationError` inside the filter
- [x] 13.2 Alternative option for Task 13.1: create a compatibility branch in `wrapUnknown()` that specifically checks `err instanceof InvalidArgumentError` and wraps in `ValidationError` with `err.message` preserved. This is cleaner than relying on the generic fallback and makes the mapping intentional. Choose this path
- [x] 13.3 Open `src/scoreboard/infrastructure/auth/hmac-action-token.verifier.ts` — the throws here are `InvalidActionTokenError` (a plain Error). Keep them as plain Errors; the guard catches them and rethrows as `ForbiddenError`. No change needed
- [x] 13.4 Open `src/scoreboard/infrastructure/persistence/redis/leaderboard-types.ts` — audit the throws; these are input validation on a type boundary, can stay as plain Errors and be caught by `wrapUnknown`'s generic fallback
- [x] 13.5 Open `src/scoreboard/infrastructure/messaging/nats/jetstream.event-publisher.ts` — audit any throws; keep as plain Errors
- [x] 13.6 Run `mise run typecheck && mise run test` — confirm all green

## 14. Wire mapDbError into the repository layer

- [x] 14.1 Open `src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts`
- [x] 14.2 Audit every raw Kysely call site. The `credit()` method currently catches unique-violation and throws `IdempotencyViolationError` — this is domain-layer logic and must be preserved exactly (see design.md Decision 7). Do NOT route `credit()` through `mapDbError`
- [x] 14.3 For other read/write methods (e.g. `findByUserId`, `findScoreEventByActionId`), add a thin try/catch that calls `mapDbError(err)` and rethrows. This only affects non-credit paths
- [x] 14.4 If the leaderboard cache (`src/scoreboard/infrastructure/persistence/redis/leaderboard-cache.ts`) issues raw Redis calls that should be unified under fail-CLOSED, confirm the existing error handling surfaces them as `Error` instances that `wrapUnknown()` will catch via `isRedisInfrastructureError`. If not, add a try/catch that rethrows via `wrapUnknown` semantics (i.e. just rethrow; the filter catches it)
- [x] 14.5 Run `mise run test -- test/unit/scoreboard/infrastructure` — confirm green
- [x] 14.6 Run `mise run test:integration` — confirm the Testcontainers suite still passes (this validates that DB errors still surface correctly end-to-end)

## 15. Public-envelope contract regression tests

- [x] 15.1 Create `test/unit/shared/errors/public-envelope-shape.test.ts` (or add to `to-public-response.test.ts`)
- [x] 15.2 Add one regression test for the `RATE_LIMITED → RATE_LIMIT` code rename: construct a `RateLimitError`, call `toPublicResponse`, assert `body.error.code === 'RATE_LIMIT'` (not `'RATE_LIMITED'`)
- [x] 15.3 Add one regression test verifying the old `hint: null` field is NOT present in the envelope (it was in problem6's old filter; we removed it)
- [x] 15.4 Run the test file in isolation

## 16. End-to-end validation

- [x] 16.1 Run `mise run typecheck` — exit 0
- [x] 16.2 Run `mise run lint` — exit 0, no warnings
- [x] 16.3 Run `mise run test` (unit) — exit 0
- [x] 16.4 Run `mise run test:coverage` — exit 0, all thresholds met (including the new 100% threshold on `src/scoreboard/shared/errors/`)
- [x] 16.5 Run `mise run test:integration` — exit 0
- [x] 16.6 Manual smoke test: `mise run dev`, trigger a 400 (invalid body) and a 500 (force an error), inspect the log output — confirm the structured fields are present and the public envelope matches the new spec
- [x] 16.7 Git diff review — confirm the files touched are exactly: `src/scoreboard/shared/errors/*`, `src/scoreboard/interface/http/error-filter.ts`, guards under `infrastructure/auth/*`, `infrastructure/rate-limit/rate-limit.guard.ts`, controllers under `interface/http/controllers/*`, `infrastructure/persistence/kysely/user-score.repository.impl.ts`, `shared/metrics/*`, `test/unit/shared/errors/*`, `test/unit/interface/http/error-filter.test.ts`, and the openspec change directory. No auth/idempotency/outbox semantics changed

## 17. OpenSpec validation

- [x] 17.1 Run `openspec validate restructure-error-handling-for-observability` from inside `problem6/` — confirm exit 0
- [x] 17.2 Confirm all three spec files parse: `specs/scoreboard-errors/spec.md` (ADDED), `specs/scoreboard-observability/spec.md` (MODIFIED), `specs/scoreboard-quality/spec.md` (ADDED)
- [x] 17.3 Mark the change done by archiving in a follow-up commit once all 16 task groups are complete
