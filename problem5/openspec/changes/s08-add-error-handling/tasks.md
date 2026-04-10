## 1. Error Code Enum and Metadata Map

- [ ] 1.1 Create `src/lib/error-codes.ts` exporting `ERROR_CODES` as an `as const` tuple and the `ErrorCode` type union
- [ ] 1.2 Export `ERROR_CODE_META` — a record mapping each `ErrorCode` to `{status: number, defaultMessage: string}`
- [ ] 1.3 Export helper `errorStatusFor(code: ErrorCode): number` and `defaultMessageFor(code: ErrorCode): string`
- [ ] 1.4 Add unit test `tests/unit/lib/error-codes.test.ts` asserting every code in the tuple has a meta entry and the status codes are in the expected HTTP ranges

## 2. Expanded Error Class Hierarchy

- [ ] 2.1 Rewrite `src/lib/errors.ts` with an `AppError` base class carrying `code`, `status`, `message`, `details?`, and `cause?`
- [ ] 2.2 Add subclasses: `ValidationError`, `BadRequestError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`, `RateLimitError`, `DependencyError`, `InternalError`
- [ ] 2.3 Each subclass derives its default status and message from `ERROR_CODE_META` but allows the constructor to override `message` and `details`
- [ ] 2.4 Add `wrapUnknown(err: unknown): AppError` that returns `err` unchanged if it's already an `AppError`, or wraps it in `InternalError` with the original attached as `cause`
- [ ] 2.5 Every subclass implements `Symbol.toStringTag` so `err.toString()` is stable and not `"Error"`
- [ ] 2.6 Add unit test `tests/unit/lib/errors.test.ts` asserting: every subclass extends `AppError`, every subclass sets the correct default status, `wrapUnknown(new Error("..."))` returns `InternalError`, `wrapUnknown(new ValidationError(...))` is a pass-through

## 3. Sensitive-Data Scrubber

- [ ] 3.1 Create `src/lib/sanitizer.ts` exporting `scrubHeaders(headers: Record<string, unknown>): Record<string, unknown>`
- [ ] 3.2 The default denylist is `['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization']`, case-insensitive
- [ ] 3.3 Accept an optional extra denylist via a `LOG_SCRUBBER_EXTRA_HEADERS` env var (comma-separated)
- [ ] 3.4 Denylisted values are replaced with the literal string `"[REDACTED]"`
- [ ] 3.5 Add unit test `tests/unit/lib/sanitizer.test.ts` covering: case-insensitive matching, extra headers from env, preservation of non-denylisted values, handling of array-valued headers (e.g., multi-value Set-Cookie)

## 4. Error Metadata Builder

- [ ] 4.1 Create `src/lib/error-metadata.ts` exporting `buildErrorMetadata(err, req, res): ErrorMetadata`
- [ ] 4.2 The payload contains: `errorId` (UUID), `errorClass` (constructor name), `code`, `status`, `message`, `stack`, `cause` (walked, max depth 5), `requestId`, `method`, `route` (Express route pattern or `__unmatched`), `headers` (scrubbed), `query` (sanitized, max 2KB), `body.size`, `body.contentType`, `userAgent`, `remoteAddr`, `timestamp`
- [ ] 4.3 The `cause` chain is an array of `{class, message}` entries; walking stops at depth 5 or at the first non-Error value
- [ ] 4.4 Add unit test `tests/unit/lib/error-metadata.test.ts` asserting: all required fields present, body bytes never appear, cause chain is walked correctly, sensitive headers are scrubbed in the returned object

## 5. Public Response Formatter

- [ ] 5.1 Create `src/lib/to-public-response.ts` exporting `toPublicResponse(err: AppError, requestId: string, errorId: string | null): { status: number, body: unknown }`
- [ ] 5.2 The body is constructed from scratch as `{error: {code, message, requestId}}` with `details` added only for `ValidationError` and `errorId` added only when status ≥ 500
- [ ] 5.3 The `message` is truncated to 200 chars with `"..."` suffix when the underlying message is longer
- [ ] 5.4 For `InternalError`, the `message` is always the generic `"Internal server error"` regardless of the underlying cause
- [ ] 5.5 Add unit test `tests/unit/lib/to-public-response.test.ts` covering: validation response has details, not-found response has no details and no errorId, internal error response has errorId and generic message, message truncation

## 6. Infrastructure Error Mapper

- [ ] 6.1 Create `src/db/error-mapper.ts` exporting `mapDbError(err: unknown): AppError`
- [ ] 6.2 Handle pg error codes via a lookup table: `23505` → `ConflictError`, `23502` → `ValidationError` (not-null violation), `23503` → `ValidationError` (foreign key violation), `22001` → `ValidationError` (string data right truncation), `40P01` → `DependencyError` (deadlock), `57014` → `DependencyError` (query canceled), `53300` → `DependencyError` (too many connections)
- [ ] 6.3 Unknown pg codes and non-pg errors map to `InternalError` with the original attached as `cause`; the raw pg code (if any) is exposed via a non-public property for logging
- [ ] 6.4 Modify `src/modules/resources/repository.ts` to wrap every query in `try { ... } catch (err) { throw mapDbError(err) }`
- [ ] 6.5 Add unit test `tests/unit/db/error-mapper.test.ts` covering each mapped pg code plus one unknown code

## 7. Rewrite Error-Handling Middleware

- [ ] 7.1 Rewrite `src/middleware/error-handler.ts` to:
  - Accept a `MetricsRegistry` (optional — if not present, skip metric increments) so it can emit `errors_total{code,status}`
  - Call `wrapUnknown(err)` to ensure a typed error
  - Generate an `errorId` via `crypto.randomUUID()`
  - Call `buildErrorMetadata(err, req, res)` to produce the log payload
  - Emit the log entry at `warn` level for status < 500 and `error` level otherwise
  - Call `toPublicResponse(err, req.id, status >= 500 ? errorId : null)` to produce the response
  - Set the HTTP status and send the response body
- [ ] 7.2 Ensure the middleware is idempotent — calling `next(err)` twice does not emit two log entries or two responses
- [ ] 7.3 Add unit tests covering each branch: known AppError, unknown Error, error with cause chain, thrown non-Error value (string, object literal)

## 8. Propagate Typed Errors Through the Stack

- [ ] 8.1 Audit `src/modules/resources/controller.ts` for any `throw new Error(...)` or bare `throw`; replace with typed `AppError` subclasses
- [ ] 8.2 Audit `src/modules/resources/service.ts` similarly; use `NotFoundError` for missing resources, `ValidationError` for domain validation failures, `ConflictError` for state conflicts
- [ ] 8.3 Audit `src/modules/resources/repository.ts` — every query catches and calls `mapDbError`
- [ ] 8.4 Add a unit-layer test that asserts every error thrown from the service layer is an `instanceof AppError`

## 9. Structured Logger Helper

- [ ] 9.1 Modify `src/lib/logger.ts` (or add `src/lib/log-with-metadata.ts`) to export `logWithMetadata(logger, level, err, context)` — a helper for any "I need to log a failure outside the middleware" path
- [ ] 9.2 Ensure the helper uses the same scrubber and metadata builder as the middleware
- [ ] 9.3 Update any existing `logger.error(err)` call site to use the helper

## 10. Integration Leak Test

- [ ] 10.1 Create `tests/integration/errors/leak.test.ts` that boots the test app (from `s04-add-test-suite`)
- [ ] 10.2 Define a constant `LEAK_DENYLIST = ['at /', 'pg:', 'kysely', 'ioredis', 'node_modules', 'stack', 'SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ', 'FROM ', 'WHERE ']`
- [ ] 10.3 Test case: POST an invalid body → assert the response body string contains none of the denylist entries
- [ ] 10.4 Test case: GET a non-existent id → assert the denylist
- [ ] 10.5 Test case: Force a 500 by injecting a repository stub that throws a fake pg error → assert the denylist AND assert the response contains a UUID `errorId`
- [ ] 10.6 Test case: Assert that the `errorId` in the response equals the `errorId` in the captured log entry (use pino's test transport or a spy on `logger.error`)

## 11. Wiring

- [ ] 11.1 Update `src/index.ts` (or the `createApp(deps)` factory) to construct the error-handling middleware with the logger, the (optional) metrics registry, and the scrubber config
- [ ] 11.2 Ensure the middleware is mounted LAST in the Express app, after all routes
- [ ] 11.3 Verify `pnpm dev` still starts cleanly

## 12. README Polish

- [ ] 12.1 Add an "Error contract" section to `README.md` documenting the stable error code enum, the response body shape, the `errorId` correlation flow, and the scrubber's denylist behavior
- [ ] 12.2 Include a copy-pasteable table mapping each error code to its HTTP status and example response
- [ ] 12.3 Document the `LOG_SCRUBBER_EXTRA_HEADERS` env var

## 13. Validation

- [ ] 13.1 Run `pnpm check` and confirm lint + typecheck pass
- [ ] 13.2 Run `pnpm test` — all unit and integration tests pass, including the new leak test and the typed-error assertions
- [ ] 13.3 Run `pnpm bench:smoke` and confirm no happy-path regression
- [ ] 13.4 Trigger each error class manually via `curl` and confirm the public response matches the expected shape and the log entry contains the full metadata payload with scrubbed headers
- [ ] 13.5 Run `openspec validate s08-add-error-handling` and confirm zero errors
