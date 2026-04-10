## Why

After `s01-add-project-scaffold` and `s02-add-resources-crud`, the service has a basic error-handling middleware and a small `AppError` hierarchy (`ValidationError`, `NotFoundError`, `ConflictError`). That is enough for happy-path CRUD — but under realistic conditions it falls short in three ways that matter together, not separately:

1. **Operators can't debug production incidents.** Error logs today contain an error class and a message. They don't carry the request context (method, route pattern, sanitized headers, body shape, user agent, correlation ids, DB error codes), so diagnosing "why did this user see a 500 at 14:23 UTC" requires guesswork.
2. **The API leaks implementation details.** A 500 from an unhandled Postgres exception bubbles its stack trace and error message into the response body. An attacker probing the API can discover the ORM, the query shape, table names, and sometimes data values ("duplicate key violates unique constraint \"resources_pkey\""). That is a recon gift in a CRUD service, and it is the exact pattern CVE disclosures use to describe low-severity information leaks.
3. **There's no stable error code contract for clients.** A client that wants to distinguish "you passed an invalid uuid" from "the server had a hiccup" has to string-match the `message` field. Message strings are not a stable contract. A client that string-matches will break on every wording change.

These three problems share a root cause — the error layer is thin — and the fix has to treat them together. Splitting "rich dev logs" from "minimal public responses" into separate changes would produce two implementations that have to be reconciled later. This change lands them together so the contract is coherent from day one.

## What Changes

- Expand the `AppError` taxonomy in `src/shared/errors.ts` with additional classes that cover the cases `s02` did not: `BadRequestError`, `UnprocessableEntityError`, `RateLimitError`, `DependencyError`, `InternalError`, and a catch-all `wrapUnknown(error)` factory that turns any thrown value into an `InternalError` with the original attached as `cause`.
- Introduce a stable, machine-readable error code enum (`src/shared/error-codes.ts`) with string constants (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT`, `DEPENDENCY_UNAVAILABLE`, `UNPROCESSABLE_ENTITY`, `INTERNAL_ERROR`, etc.) and a fixed mapping from code to HTTP status.
- Introduce `src/shared/error-metadata.ts` — a helper that builds the **dev-log payload** for an error. The payload captures the error class, stack, `cause` chain, the request id, method, Express route pattern (not raw URL), sanitized headers, query string shape, body size (not body content), user-agent, timestamps, and a freshly generated `errorId` UUID that correlates the log entry with the response.
- Introduce `src/shared/sanitizer.ts` — a denylist-based scrubber that replaces the values of sensitive header names (`Authorization`, `Cookie`, `X-Api-Key`, `Set-Cookie`, `Proxy-Authorization`, and a configurable set) with `"[REDACTED]"` before the log is emitted. The same scrubber is used for any ad-hoc structured log fields downstream.
- Rewrite the error-handling middleware (`src/middleware/error-handler.ts`) to:
  - Generate a per-error `errorId` UUID.
  - Translate every error through a single `toPublicResponse(err)` function that returns the minimal-allowlist shape.
  - Emit a single structured log line at the appropriate level (`warn` for 4xx, `error` for 5xx) containing the full metadata payload.
  - Never let an unknown error type through without wrapping it; the final response for any unmapped error is `500 Internal Server Error` with a generic message.
- Introduce an **infrastructure-error mapper** (`src/infrastructure/db/error-mapper.ts`) that translates Postgres errors into `AppError` subclasses using `pg`'s numeric error code field. `23505` → `ConflictError`, `23502` → `ValidationError`, `23503` → `ValidationError` (foreign key), `40P01` → `DependencyError` (deadlock), `57014` → `DependencyError` (query canceled/timeout), and so on. The mapper is called from the repository layer, so the service layer sees only typed domain errors.
- **Tighten the public error response contract**: responses carry only `{error: {code, message, requestId, details?}}`. The `message` field is a safe, generic string for any `INTERNAL_ERROR`; it is the validation-specific message for `VALIDATION`. `details` is present only for `VALIDATION` and only contains field-level error information (`path`, `message`, `code`). Stack traces, SQL fragments, file paths, library names, and raw exception messages NEVER appear in the public response — only in the dev log.
- Introduce `errorId` in the public response when the status is 5xx (`{error: {code, message, requestId, errorId}}`). The reviewer or support team can take the `errorId` from a user report and grep it out of the logs. The `errorId` is ONLY present on 5xx because 4xx errors are the client's fault and do not need server-side correlation.
- Add a structured logger helper `logWithMetadata(level, err, context)` that the rest of the code can use for "I'm about to bail out but want to record why" moments, matching the same scrubber rules as the error middleware.
- Update every thrown error in the existing codebase (controllers, services, repositories) to use the new subclasses; any `throw new Error("...")` is upgraded to the appropriate `AppError`.

## Capabilities

### New Capabilities

- `error-handling`: The end-to-end contract for how errors are classified, logged, and exposed to API clients. Supersedes the looser error requirements from `s01` and `s02` (see modified deltas below).

### Modified Capabilities

- `project-bootstrap`: `### Requirement: Central Error Handler` is replaced with a stricter requirement that includes the metadata-logging and error-id contract from this change.
- `resources-management`: `### Requirement: Error Response Shape` is replaced with the minimal-allowlist shape from this change, dropping ambiguity about what `details` may contain and explicitly forbidding implementation details in `message`.

## Impact

- **New files**: `src/shared/error-codes.ts`, `src/shared/error-metadata.ts`, `src/shared/sanitizer.ts`, `src/infrastructure/db/error-mapper.ts`, `tests/unit/shared/error-codes.test.ts`, `tests/unit/shared/sanitizer.test.ts`, `tests/unit/shared/error-metadata.test.ts`, `tests/unit/infrastructure/db/error-mapper.test.ts`, `tests/integration/errors/leak.test.ts`.
- **Modified files**: `src/shared/errors.ts` (expanded taxonomy), `src/middleware/error-handler.ts` (rewritten around the new helpers), `src/modules/resources/presentation/controller.ts` and `src/modules/resources/application/service.ts` and `src/modules/resources/infrastructure/repository.ts` (throw typed errors via the new classes and the infrastructure mapper), `src/shared/logger.ts` (export a `logWithMetadata` helper), `README.md` (document the error contract and the `errorId` field).
- **New dependencies**: None. All additions are pure TypeScript using the existing Pino, Zod, and `pg` deps.
- **APIs exposed**: No new endpoints. The response shape on existing endpoints becomes stricter — this is technically an *observable* change for any client that was relying on the looser shape, but since no external client exists (greenfield), it is not a breaking change in practice.
- **Systems affected**: The log format becomes richer (more fields per entry) and denser (one structured metadata payload per error). Log volume increases modestly on the error path but is unchanged on the happy path.
- **Breaking changes**: None for clients. For developers, the convention shifts: plain `Error`/`throw new Error(...)` is no longer acceptable inside the service; code that forgets to use the taxonomy is caught by `tests/unit/shared/errors.test.ts` which asserts every class in the hierarchy implements `toPublicResponse`.
