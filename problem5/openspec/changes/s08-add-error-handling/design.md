## Context

The error model today (after `s01` and `s02`) is adequate for a demo but wrong for production in three stacked ways. First, the log entry for an error is a message and a stack trace — no request context — so operators cannot tie an incident to the request that caused it. Second, the response body for an unhandled exception bubbles the original exception message, which is how an attacker learns your ORM, your table names, and sometimes your data. Third, there's no stable `code` contract for clients, so any client automation has to string-match the `message` field and every rewording breaks it.

This change is the "make the error model production-grade" change, and it deliberately treats all three problems together. Splitting "rich dev logs" from "minimal public responses" into two changes would leave an awkward in-between where one has been done and the other hasn't — and the integration test for leak prevention can't meaningfully pass until both are in place.

The trickiest part is **the allowlist posture**. Denylist-based sanitization ("strip these 20 dangerous substrings") is fragile: the next bug will introduce a 21st. Allowlist-based ("the response body may contain exactly these fields, and no others, ever") is rigid but correct. We take the allowlist posture, build it into the central `toPublicResponse` function, and add an integration test that actively looks for leak indicators in error responses.

## Goals / Non-Goals

**Goals:**

- Expand the error taxonomy so every error the service can produce maps to a named class.
- Every log entry for an error carries enough context (method, route pattern, sanitized headers, request id, user agent, timestamps, stack, cause chain) for an operator to diagnose the incident without re-running the request.
- Every public error response is constrained to a minimal allowlist. A bug that would have leaked an internal detail can't slip past the central formatter, and the integration suite actively checks for leak indicators.
- Introduce a stable error-code contract so clients can programmatically distinguish error types without string-matching.
- Translate infrastructure errors (Postgres, Redis) into domain errors at the repository boundary, so the service layer only ever sees typed `AppError` subclasses.
- Correlate 5xx responses with log entries via a per-error `errorId` UUID, so a user can paste the id from a report and the engineer can grep it out of the logs.
- Scrub sensitive request headers before logging to avoid leaking bearer tokens and cookies into log storage.

**Non-Goals:**

- Authentication or authorization errors. No auth layer exists; `RateLimitError` and `UnauthorizedError` classes are part of the taxonomy for future use but no endpoint throws them in this change.
- Rate limiting. The class exists; the middleware does not.
- Internationalization of error messages. Messages are English, bounded in length, and stable in wording.
- Retryable-vs-fatal classification of errors. We have `DependencyError` for retryable 503s; richer retry semantics are out of scope.
- OpenAPI / JSON Schema generation of the error shape. Desirable but a separate change.
- A centralized error-reporting backend (Sentry, Bugsnag). Log scraping is sufficient for a brief.

## Decisions

### Decision 1: Allowlist, not denylist, for public response fields

The `toPublicResponse(err)` function builds the response body from scratch, copying ONLY the fields on the allowlist. It never mutates or strips from the underlying error; it produces a new object with exactly `{error: {code, message, requestId, details?, errorId?}}`. A new field can only appear in the response if someone explicitly adds it to `toPublicResponse`.

The message string is passed through a truncation helper (`truncate(msg, 200)`) and through an "implementation-detail stripping" step that is itself belt-and-braces: it's there as defense in depth, but the primary guarantee is that we never set `message` from unsafe sources in the first place.

**Alternatives considered:**

- *Denylist-based message sanitization*: "Find and replace 'pg', 'kysely', 'node_modules', etc." Always losing: the list is never complete.
- *Response body produced by serializing the error object itself*: Couples response shape to internal shape. Any field added to a class leaks.

### Decision 2: Stable `code` enum as a string union type

```ts
export const ERROR_CODES = [
  'VALIDATION',
  'BAD_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'RATE_LIMIT',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
```

`as const` gives us a single source of truth that's a runtime array (iterable) AND a type union (exhaustive in switch statements). A future deprecation cycle for a code looks like "add the new one, mark the old one deprecated in JSDoc but keep it in the enum, remove after a grace period."

**Alternatives considered:**

- *`enum ErrorCode { VALIDATION = 'VALIDATION', ... }`*: TypeScript enums are notoriously weird at runtime (reverse mappings for number enums, no runtime members for const enums). `as const` tuples are cleaner.
- *Numeric codes (`100`, `101`, `...`)*: Harder for humans to read in logs.

### Decision 3: `errorId` on 5xx only, `requestId` on everything

`requestId` identifies the request and is useful regardless of outcome. `errorId` identifies the specific error event and is only meaningful when there's a dev log entry for it (which is always, but 4xx errors are the client's fault and don't need correlation).

Adding `errorId` to every response would be defensible but:

1. Makes successful requests look cluttered.
2. Creates a false sense of importance around client errors (a 400 isn't an incident).
3. Doubles the UUIDs generated per request for no operational win.

**Alternatives considered:**

- *`errorId` on everything*: Simpler rule but adds noise.
- *`errorId` on 4xx too but only logged at debug*: Complicates the logging story.

### Decision 4: Dev-log payload is constructed by a dedicated helper, not ad-hoc at each log call

`buildErrorMetadata(err, req, res)` is the single function that produces the dev-log payload. The error-handling middleware calls it. Any downstream log-on-failure sites can call it too. Any future field added to the payload (for example, a `userId` when auth lands) is added in one place.

**Alternatives considered:**

- *Inline the payload construction inside the error middleware*: Leaks the payload shape into an ad-hoc middleware file.
- *Make `AppError` produce its own metadata via a method*: Mixes HTTP concerns into the error class.

### Decision 5: Denylist for scrubber, allowlist for log fields

The scrubber itself is a denylist ("these header names are sensitive, redact their values"). The overall log entry is an allowlist ("only these fields are ever logged"). The two are not contradictory: the scrubber runs against structured data the log entry has already decided to include. A header that is never included in the log entry doesn't need to be scrubbed, but a header that IS included must be scrubbed if it's sensitive.

Body content is NEVER in the log entry. Body size and content type ARE.

**Alternatives considered:**

- *Allowlist for headers*: Too restrictive. Operators legitimately want to see User-Agent, Accept, Content-Type, etc., and enumerating them is error-prone.
- *Log bodies and scrub them*: Even with the best scrubber, a body can contain PII we haven't thought of. Safer to never log it.

### Decision 6: Infrastructure error mapping lives in the data-access layer, not the middleware

A `pg` exception is meaningful to the repository (it knows what operation it just issued, it knows whether the error was retryable or fatal). By the time it reaches the error-handling middleware, that context is lost. We push the translation down: the repository wraps `pg` errors in `AppError` subclasses before throwing.

The middleware's job is then reduced to: (a) wrap unknown (non-`AppError`) errors in `InternalError`, (b) log, (c) format public response.

**Alternatives considered:**

- *Translate in the middleware*: Middleware has to know about `pg` specifics, which couples HTTP to data access.
- *Translate at the service layer*: Service layer has no visibility into `pg` error codes because repositories hide them.

### Decision 7: `cause` chain is walked and captured, not logged as a mutable object

The dev-log payload includes a `cause` field which is an array of `{class, message}` entries walked from `err.cause` down to the root. We walk it to a max depth of 5 (guarding against infinite chains from buggy code) and stop on the first non-Error value.

We do NOT include stack traces for each cause, only for the top-level error — that keeps the payload bounded.

**Alternatives considered:**

- *Log the full `err.cause` object tree*: Unbounded, can contain circular references.
- *Ignore cause*: Loses debugging context for wrapped errors.

### Decision 8: Integration test with an explicit leak denylist

A `tests/integration/errors/leak.test.ts` file forces each major error path to fire, reads the response body, and asserts that none of a set of leak indicator substrings appear. The list is: `"at /"`, `"pg"`, `"kysely"`, `"ioredis"`, `"node_modules"`, `"stack"`, `"SELECT "`, `"INSERT "`, `"UPDATE "`, `"DELETE "`, `"FROM "`, `"WHERE "`.

This is a belt-and-braces check. The primary guarantee is the allowlist in `toPublicResponse`. The test catches regressions when someone adds a well-intentioned "include error details" feature without noticing the contract.

**Alternatives considered:**

- *Rely on the allowlist alone*: Allowlists catch structural bugs but not string-interpolation bugs that splice unsafe data into `message`. The test catches the latter.

### Decision 9: Replace, don't extend, the `Central Error Handler` and `Error Response Shape` requirements

The original requirements from `s01` and `s02` are too loose. This change uses `## MODIFIED Requirements` deltas to replace them wholesale. When `s01` and `s02` archive before `s08`, the archived specs contain the weaker contract; when `s08` archives, the main specs get updated to the stricter contract. In the meantime, an implementer reads the most recent delta and follows it — which is exactly what the OpenSpec delta system is designed for.

**Alternatives considered:**

- *Add new requirements alongside the old ones*: Leaves contradictory specs in the repository.
- *Delete the old requirements via `## REMOVED`*: Loses continuity; the reviewer can't tell what the shape used to be.

## Risks / Trade-offs

- **[Risk: The 200-char `message` truncation loses information for long validation errors]** → Mitigation: The full message is preserved in `details[].message` for `VALIDATION` errors (and those aren't truncated to 200 chars; only the top-level `message` is). For non-validation errors, 200 chars is enough for "Resource not found" / "Internal server error".
- **[Risk: `errorId` creates friction for automated log-based alerting that groups by stack hash]** → Mitigation: Alerting groups by error class, code, or stack hash — NOT by `errorId`. The `errorId` is for human lookup, not aggregation.
- **[Risk: The scrubber's denylist misses an obscure sensitive header]** → Mitigation: `LOG_SCRUBBER_EXTRA_HEADERS` env var lets operators extend the list without a code change. A follow-up change can add a broader built-in list.
- **[Risk: Translating every `pg` error into `InternalError` by default loses specificity for unmapped codes]** → Mitigation: The mapper logs the raw pg code in the metadata payload even when it maps to `InternalError`, so the information survives.
- **[Risk: Truncation at 200 chars leaves trailing `"..."` which some test frameworks treat as a special character]** → Mitigation: The truncation marker is a plain ASCII ellipsis. Tests use `expect(...).toMatch(...)` with substring assertions, not exact equality.
- **[Risk: The integration leak test is implemented with mocked infrastructure, not real failure injection, so it doesn't cover real production errors]** → Mitigation: The test uses a mix of strategies: real Zod validation errors, a test-only route that throws `new Error("leak test: /var/lib/postgres/data")` to force the unknown-error path, and a temporary repository stub that throws a fake `pg` error. Covers the main classes of leak.
- **[Risk: Adding new error classes requires wiring into all of: the class file, the code enum, the code-to-status map, the test file]** → Mitigation: A single `ERROR_CODE_META` object at the top of `error-codes.ts` holds all of {code, status, defaultMessage}. Classes derive their defaults from this map. One file to edit.

## Migration Plan

1. Add the new error classes and the code enum.
2. Rewrite the error handler middleware, with tests.
3. Add the scrubber and the metadata helper.
4. Add the infrastructure error mapper and wire it into the repository.
5. Update the resources controller, service, repository to throw typed errors.
6. Add the integration leak test.
7. Update the README's error documentation.
8. Run the benchmark once more (post-change) to confirm the richer error path didn't introduce latency regression on the happy path.

Rollback: This change introduces stricter contracts. Rolling back means restoring the looser contracts, which would be a partial revert of the error-handling middleware plus the infrastructure mapper. Because no external client depends on the loose contracts, a rollback is safe if needed.

## Open Questions

- **Should we distinguish `NOT_FOUND` and `FORBIDDEN` in a world with auth?** When auth lands, yes. For now, everything is `NOT_FOUND` because there's no auth.
- **Should we include a `traceId` alongside `requestId`?** Not until distributed tracing arrives (OpenTelemetry change, separate scope).
- **Should we expose the error-code enum as an OpenAPI schema?** Desirable; deferred to a documentation-focused follow-up change.
- **Should the scrubber also redact query string values?** Low-risk to do so for known-sensitive parameter names (e.g., `token`, `key`, `password`). Adding a small parameter-name denylist to the scrubber is a reasonable follow-up; not done in this change to keep scope bounded.
