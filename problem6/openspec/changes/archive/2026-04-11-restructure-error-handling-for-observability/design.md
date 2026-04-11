## Context

problem6's `HttpExceptionFilter` was written to pass tests and to satisfy the GAP-03 Redis fail-CLOSED requirement. It works — no bug, no correctness issue. But operating it is painful: structured fields don't exist, `Error.cause` chains aren't walked, there's no per-error UUID for user-facing correlation, and the log format is a concatenated string with the stack as a second argument. When a 500 happens in production, the operator's workflow is "grep requestId, read the message, read the stack, guess at what called what."

problem5 — the sibling Express module in the same repo — solves this cleanly with a 6-file architecture: `error-codes.ts` (enum + metadata table), `errors.ts` (`AppError` hierarchy), `error-metadata.ts` (metadata builder that walks cause chains and captures request context), `to-public-response.ts` (allowlist response builder), `error-handler.ts` (middleware), and `infrastructure/db/error-mapper.ts` (Postgres SQLSTATE mapper). The pattern is mature, battle-tested within the same codebase's conventions, and directly applicable.

The adoption is not a straight copy-paste. problem6 is NestJS + Fastify rather than Express, it has a Redis fail-CLOSED requirement the Express module doesn't, it uses Kysely rather than raw `pg`, it runs zod validation rather than a custom validator, and its guards throw NestJS `HttpException` subclasses that cannot be removed (Nest itself throws `ForbiddenException` / `UnauthorizedException` from internal machinery). The design below makes the adaptations explicit so the refactor is predictable.

**Current state (what exists in problem6 today):**
- `src/scoreboard/interface/http/error-filter.ts` — the existing filter, 157 LOC, with `deriveHttpExceptionCode`, `isRedisInfrastructureError`, and an if/else chain handling `ZodError` / `InvalidArgumentError` / `HttpException` / generic `Error`.
- `src/scoreboard/domain/errors/` — a tiny handful of domain errors (`InvalidArgumentError`, `IdempotencyViolationError`) that are plain `Error` subclasses, not NestJS-aware.
- `src/shared/metrics/write-path-metrics.ts` — existing metrics module where we'll add the new `errorsTotal` counter.
- 33 throw sites across 14 files using NestJS built-ins (`ForbiddenException`, `UnauthorizedException`, `BadRequestException`, `InternalServerErrorException`, `ServiceUnavailableException`, generic `HttpException`).

**Current state (what exists in problem5 for reference):**
- 6 files totaling ~550 LOC across shared/ + middleware/ + infrastructure/db/.
- `ERROR_CODES` tuple with 8 entries; `ERROR_CODE_META` table mapping each to `{status, defaultMessage}`.
- `AppError` base class + 8 typed subclasses, each carrying `code`, `status`, `message`, `details`, `cause`.
- `buildErrorMetadata()` returning 13 fields, including a walked cause chain (max depth 5), scrubbed headers (via a default denylist), query capped at 2KB, and body size + content-type (but never body content).
- `toPublicResponse()` allowlist builder; `InternalError` always emits the generic message regardless of `err.message`.
- `mapDbError()` handling 7 SQLSTATE codes + non-pg fallback.

**Constraints that shape every decision below:**
- NestJS guards throw `HttpException` subclasses. The new hierarchy MUST extend `HttpException` (not `Error`) so that guard behavior is unchanged and DI/metadata reflection continues to work.
- Fastify reply API is different from Express: `reply.status(n).send(body)` vs `res.status(n).json(body)`. The filter's send-path must use Fastify.
- The Redis fail-CLOSED contract (GAP-03 / step-07 DECISION-1) MUST be preserved: `ioredis` infrastructure errors MUST surface as `503 TEMPORARILY_UNAVAILABLE` regardless of where they're thrown. The `isRedisInfrastructureError` detection logic moves into the filter's `wrapUnknown()` step, not into individual call sites.
- Kysely doesn't expose `pg.DatabaseError` as a class you can reliably `instanceof`-check — the package boundary is lossy. Use a structural check (`{ code: string, name: 'error' | 'DatabaseError' }`) same as problem5.
- There is no `nestjs-pino` wiring yet (step-04 deferred it). We log via `@nestjs/common`'s `Logger` which is a string-first API. The new filter SHOULD pass a structured object to the logger — NestJS's `Logger.error(obj, stack, context)` accepts an object as the first argument, which `nestjs-pino` will later render as structured JSON. Today it's a JSON.stringify'd string in the console; tomorrow it's a field-query-able Pino log line. Same code path works for both.

## Goals / Non-Goals

**Goals:**
- Single source of truth for HTTP error codes and their canonical statuses (`ERROR_CODE_META` table).
- Every 5xx response carries an `errorId` UUID that is also present in the structured log line.
- Every error log entry is a single structured object with at minimum: `errorId`, `errorClass`, `code`, `status`, `message`, `stack`, `cause[]`, `requestId`, `method`, `route`, `headers`, `query`, `body.{size,contentType}`, `userAgent`, `remoteAddr`, `timestamp`, and `pgCode` (if present).
- `Error.cause` chains are walked up to 5 levels deep; each entry captures `{class, message}`.
- Sensitive headers are redacted in logs via a default denylist (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `action-token`) plus an optional extra denylist (config-driven, deferred for now).
- Postgres SQLSTATE codes are preserved on the resulting `AppError` as a non-enumerable `pgCode` property so the metadata builder can log them without leaking to the public response.
- The public response envelope is built from an allowlist, never by serializing the underlying error. `InternalError` messages are ALWAYS replaced by the generic string.
- `scoreboard_errors_total{code,status}` Prometheus counter is emitted on every error that reaches the filter.
- Redis fail-CLOSED behavior is preserved: ioredis infrastructure errors become `503 TEMPORARILY_UNAVAILABLE` with `code: 'TEMPORARILY_UNAVAILABLE'` and are logged with their full cause chain.
- Existing status codes and response `code` strings remain identical for every existing throw site — the refactor is behavior-preserving at the HTTP boundary.
- Tests cover every subclass, the scrubber, the metadata builder, the pg mapper, the public response builder, and the filter's orchestration end-to-end.

**Non-Goals:**
- Alerting rules, Grafana dashboards, runbook entries. Operator configuration, not code.
- OpenTelemetry span-level error enrichment. Tracing integration is separate from HTTP filter concerns; leave it alone.
- Retry logic, circuit breakers, or any recovery strategy. This change is reporting only.
- Replacing NestJS's built-in `HttpException` hierarchy. `HttpException` remains the framework boundary — our classes extend it, we don't replace it.
- Rewriting auth, rate-limit, idempotency, or outbox semantics. The filter swaps constructors and adds metadata; it does not alter control flow or guard order.
- Introducing `nestjs-pino`. The logger interface is `@nestjs/common.Logger`; the structured object is passed as the first argument and will be rendered correctly once Pino lands in a future change.
- Adding an `extraScrubHeaders` config knob. Not needed today; trivial to add later.
- Renaming or moving existing domain-layer errors (`InvalidArgumentError`, `IdempotencyViolationError`). Those stay; they're re-routed through the filter's `wrapUnknown()` step.
- Touching the `/ready` endpoint's error envelope — `/ready` builds its own response body.
- Changing log levels for non-error paths.

## Decisions

### Decision 1 — File layout and capability boundary

**Decision**: All new error primitives live at `src/scoreboard/shared/errors/` with the following files:
- `error-codes.ts` — `ErrorCode` tuple + `ERROR_CODE_META` table
- `domain-error.ts` — `DomainError` base class extending `HttpException` + 10 concrete subclasses
- `error-metadata.ts` — `CauseEntry`, `ErrorMetadata`, `buildErrorMetadata()`
- `scrub-headers.ts` — `DEFAULT_HEADER_DENYLIST` + `scrubHeaders()`
- `map-db-error.ts` — `mapDbError()` + structural pg guard + `attachPgCode()`
- `to-public-response.ts` — `toPublicResponse()` allowlist builder
- `wrap-unknown.ts` — `wrapUnknown()` coercion helper
- `index.ts` — barrel export

The existing domain-layer errors (`src/scoreboard/domain/errors/invalid-argument.error.ts`, `idempotency-violation.error.ts`) stay where they are — they're part of the domain boundary, not the shared error primitives. They remain plain `Error` subclasses; `wrapUnknown()` catches them and coerces to the appropriate `DomainError` subclass inside the filter.

**Rationale**: `src/scoreboard/shared/` already exists as the module's framework-adjacent catchall (`metrics/`, `config/` paths land near there). Errors that are used by interface + application + infrastructure layers belong in a shared subdirectory, not in any one of them. Keeping the domain-layer errors as plain `Error` subclasses preserves the clean hexagonal boundary: domain doesn't import from `@nestjs/common`.

**Alternatives rejected**:
- *Put errors in `src/scoreboard/domain/errors/`*: rejected — domain depends on nothing but TypeScript. Importing `HttpException` in domain would break the eslint-boundaries layering.
- *Put errors in `src/shared/errors/` (top-level)*: rejected — this module is problem6's only bounded context today, but a future multi-module split would want module-scoped errors. Keep them inside `src/scoreboard/`.
- *Inline inside `interface/http/`*: rejected — error primitives are used by application and infrastructure layers too (e.g. `mapDbError` from the repository), so they can't live under interface.

### Decision 2 — `DomainError` base class shape

**Decision**: The base class is:

```ts
abstract class DomainError extends HttpException {
  public readonly code: ErrorCode;      // stable string, machine-readable
  public readonly details?: unknown;    // structured payload (ValidationError only)
  public override readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { details?: unknown; cause?: unknown },
  ) {
    // HttpException takes (response, status). We pass a structured response
    // so that if some consumer calls getResponse() it still gets a sane shape,
    // but the filter NEVER reads getResponse() — it reads our own fields.
    super({ code, message }, ERROR_CODE_META[code].status, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    if (opts?.details !== undefined) this.details = opts.details;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}
```

Subclasses (10 total) each extend `DomainError`, pass the appropriate code, and accept optional `message` + `opts`:

```ts
class ValidationError extends DomainError { constructor(message?: string, details?: unknown) { super('VALIDATION', message ?? DEFAULT, details !== undefined ? { details } : undefined); } }
class ConflictError extends DomainError { constructor(message?: string, opts?: {...}) { super('CONFLICT', message ?? DEFAULT, opts); } }
// ...etc
```

**Rationale**: Extending `HttpException` is non-negotiable (Constraint 1). Wrapping `HttpException`'s response payload as `{code, message}` gives us a sane shape for any consumer that accidentally calls `getResponse()` (e.g. a future downstream filter), without relying on it. The filter reads `code` / `details` / `cause` directly from the class instance, not via `getResponse()`.

`code` is the union type from `error-codes.ts`, not a free string — this makes exhaustiveness checking work when we add a new code and forget to update the filter. TypeScript will flag any unhandled case.

The `opts` destructuring matches problem5's shape so the mental model transfers cleanly for anyone reading both modules.

**Alternatives rejected**:
- *Single concrete class with a `code` parameter*: rejected — losing the `instanceof ValidationError` pattern makes the filter and repository mapper uglier. Each subclass is ~8 lines; 10 classes is 80 lines of boilerplate for a massive readability win.
- *No base class, just an enum + a helper*: rejected — loses type narrowing in catch blocks.
- *Extend a custom `Error` and lose `HttpException` compatibility*: rejected — Constraint 1 says no.

### Decision 3 — `ErrorCode` union and `ERROR_CODE_META` table

**Decision**: The union is a readonly tuple plus `typeof...[number]`, same as problem5:

```ts
export const ERROR_CODES = [
  'VALIDATION',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE_ENTITY',
  'RATE_LIMIT',
  'TEMPORARILY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = typeof ERROR_CODES[number];
```

The table carries `{status, defaultMessage}` per code. The 10 codes map 1:1 with the 10 `DomainError` subclasses. `TEMPORARILY_UNAVAILABLE` replaces problem5's `DEPENDENCY_UNAVAILABLE` because that's the string problem6's existing filter already uses (preservation of current public envelope is a non-negotiable goal).

**Rationale**: problem6's existing `deriveHttpExceptionCode` produces the strings `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `TEMPORARILY_UNAVAILABLE`, `INTERNAL_ERROR`, `BAD_REQUEST`, `HTTP_ERROR`. The new table preserves all of those except two: `RATE_LIMITED` becomes `RATE_LIMIT` (matches problem5's string; the "-ED" in the current filter is arbitrary) and `HTTP_ERROR` is removed (it was a catch-all for unknown statuses, which won't happen once every throw site uses a typed class). This is technically a public-envelope break for the `RATE_LIMITED → RATE_LIMIT` rename; design.md Decision 8 below covers compatibility.

**Alternatives rejected**:
- *Preserve `RATE_LIMITED` exactly*: rejected as a nit — no client depends on this string today (there's no prod release), and matching problem5 is worth more than preserving an arbitrary suffix.
- *Preserve `HTTP_ERROR` as a fallback code*: rejected — we want the filter to be exhaustive over `ErrorCode`; a catch-all defeats the point. The fallback path is `INTERNAL_ERROR` via `wrapUnknown()`.
- *Split `UNAUTHENTICATED` into `UNAUTHORIZED` (current) and keep the existing string*: rejected — the current filter outputs `UNAUTHENTICATED` which is the semantically correct term. Keep it.

### Decision 4 — Redis fail-CLOSED detection moves into `wrapUnknown()`

**Decision**: `isRedisInfrastructureError` (the ioredis error shape detector currently in `error-filter.ts`) moves into `wrap-unknown.ts`. `wrapUnknown()` has the following priority chain:

```
1. If exception instanceof DomainError → return as-is
2. If exception instanceof HttpException → convert to matching DomainError subclass
   (preserving the NestJS message and status)
3. If exception instanceof ZodError → wrap in ValidationError with issues as details
4. If exception is a pg-shaped error (structural check) → map via mapDbError()
5. If exception instanceof Error and isRedisInfrastructureError(exception)
      → wrap in DependencyUnavailableError with code TEMPORARILY_UNAVAILABLE,
        with the original as cause (so the log shows the ioredis details)
6. If exception instanceof Error → wrap in InternalError with original as cause
7. Otherwise → InternalError with stringified exception as cause
```

The filter then proceeds with a single path: `buildErrorMetadata()`, log, counter, `toPublicResponse()`, send.

**Rationale**: Having the filter do classification via a chain of `if`s works today but doesn't scale — each case has different behavior, different log shape, different metric. Centralizing in `wrapUnknown()` means the filter is a single fall-through pipeline and the type the filter sees is always `DomainError`. This also lets us unit-test `wrapUnknown()` in isolation against synthetic throws without booting Nest.

Redis fail-CLOSED logic lives in `wrapUnknown` because that's the function that decides "what kind of error is this really?" — the same question it answers for pg errors and Nest errors.

**Alternatives rejected**:
- *Keep Redis detection in the filter*: rejected — same classification logic in two places, filter test becomes a router test again.
- *Require every repository to catch its own Redis errors*: rejected — too many call sites, too easy to miss one, and the fail-CLOSED contract needs to be uniform. Centralized detection is safer.

### Decision 5 — Metadata field list and cause-walking depth

**Decision**: `ErrorMetadata` has 14 fields (adapted from problem5's 13):

```ts
{
  errorId: string;           // UUID generated in filter
  errorClass: string;        // err.constructor.name
  code: ErrorCode;           // err.code (from our hierarchy)
  status: number;            // err.getStatus() (HttpException API)
  message: string;           // err.message
  stack?: string;            // err.stack
  pgCode?: string;           // if attached by mapDbError
  cause: CauseEntry[];       // walked Error.cause chain, max 5 deep
  requestId: string | null;  // from request.requestId (set upstream)
  method: string;            // req.method
  route: string;             // req.routeOptions?.url or req.url fallback
  headers: Record<string, unknown>; // scrubbed
  query: string;             // capped at 2KB
  body: { size: number | null; contentType: string | null };
  userAgent: string | null;
  remoteAddr: string | null;
  timestamp: string;         // ISO-8601
}
```

Cause walking stops at depth 5 or when `err.cause` is not an `Error`. Each entry captures only `{class, message}` — NOT the full stack, NOT the inner error's inner cause (that's what the recursion is for).

Query capping is 2048 bytes with `"..."` suffix on truncation (same as problem5).

Body content is NEVER included — only size (from `content-length` header) and content-type. This is a hard rule; revisit only if we gain a compelling use case for body logging under an explicit opt-in.

**Rationale**: This is the biggest debugging-info feature of the whole change. Each field is chosen to answer a specific operator question:

| Field | Question answered |
|---|---|
| `errorId` | "Which specific failure was this?" |
| `errorClass`, `code`, `status` | "What kind of error?" |
| `stack` + `cause[]` | "Where did it come from, all the way down?" |
| `pgCode` | "What did the database actually say?" |
| `method`, `route`, `query` | "Which endpoint was hit?" |
| `headers` (scrubbed) | "Was it authenticated? What content-type? What user agent?" |
| `body.size`, `body.contentType` | "Was the request body huge? Was it JSON or something else?" |
| `userAgent`, `remoteAddr` | "Which client?" |
| `requestId` | "How do I correlate with upstream logs?" |
| `timestamp` | "When exactly?" |

**Alternatives rejected**:
- *Cause walk depth 10*: rejected — 5 is already deep enough that you rarely hit it; 10 invites log bloat from pathological recursion.
- *Include body content*: rejected — see non-goals. PII/secrets risk.
- *Skip the cause walker and just log `err.stack`*: rejected — the stack only shows the top of the chain; wrapped errors lose their inner detail. This is the core debugging-info gap we're trying to close.

### Decision 6 — `toPublicResponse()` allowlist and InternalError leak guard

**Decision**: The public envelope is built from scratch via an allowlist:

```ts
function toPublicResponse(err: DomainError, requestId: string | null, errorId: string | null) {
  // InternalError ALWAYS emits the generic message, regardless of err.message.
  const message = err instanceof InternalError
    ? ERROR_CODE_META.INTERNAL_ERROR.defaultMessage
    : truncate(err.message, MESSAGE_MAX_LEN);

  const error: Record<string, unknown> = {
    code: err.code,
    message,
    requestId: requestId ?? null,
  };

  // details ONLY for ValidationError
  if (err instanceof ValidationError && err.details !== undefined) {
    error.details = err.details;
  }

  // errorId ONLY for 5xx
  if (errorId !== null) error.errorId = errorId;

  return { status: err.getStatus(), body: { error } };
}
```

`MESSAGE_MAX_LEN` is 200 bytes (same as problem5).

The `InternalError` message leak guard is a HARD GUARANTEE, not a convention. Any wrapped low-level error (e.g. a pg error with a query string in its message) must not surface to the client. The `wrapUnknown()` → `InternalError` branch catches every unhandled throw, and `toPublicResponse()` always replaces its message with the generic.

**Rationale**: This is the security property of the error subsystem. It prevents stack traces, SQL snippets, file paths, and other internal strings from leaking into 500 responses. It's cheap to guarantee (one `instanceof` check) and impossible to violate accidentally once the path is centralized.

**Alternatives rejected**:
- *Sanitize every error message via a regex*: rejected — blocklist approach, endless corner cases.
- *Make it opt-in via a config flag*: rejected — the safe behavior must be the default; leak prevention is not a feature, it's a contract.
- *Serialize the error object directly*: rejected — exactly the thing we're trying to prevent.

### Decision 7 — Compatibility with the existing `IdempotencyViolationError` catch path

**Decision**: `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` currently has a catch block that does:

```ts
} catch (err) {
  if (err instanceof IdempotencyViolationError) {
    // layer 2 replay handling
  }
}
```

This stays working because:
1. `IdempotencyViolationError` remains a plain `Error` subclass in `src/scoreboard/domain/errors/`.
2. `mapDbError()` is NOT used inside `IncrementScoreHandler` — the handler's existing `repo.credit()` call chain continues to throw `IdempotencyViolationError` from the domain layer. That's a deliberate choice: the handler owns layer-2 replay semantics and wants a domain-level signal, not a generic `ConflictError`.
3. `mapDbError()` IS used anywhere else that issues raw Kysely calls (e.g. leaderboard reads, outbox reads). There, a unique-violation becomes a `ConflictError` that the filter treats as a 409.

The handler's catch block is unchanged. The throw site inside the repository that converts `23505` to `IdempotencyViolationError` is also unchanged — that's domain-layer logic and owns its own mapping.

**Rationale**: The `IdempotencyViolationError` catch path exists specifically to return the *prior* score event, not a generic 409. That's application-layer logic that the generic error mapper can't express. Keeping the domain-layer error as an untouched "first responder" preserves the replay behavior; `mapDbError()` is a *second* responder for everywhere else.

**Alternatives rejected**:
- *Delete `IdempotencyViolationError`, use `ConflictError` everywhere*: rejected — would require the handler's catch to inspect the `ConflictError`'s `code` + `pgCode` + `details` to distinguish "this is the replay case" from "this is an unrelated 23505". The signal is clearer as a dedicated class.
- *Make `IdempotencyViolationError extends ConflictError`*: rejected — the domain layer shouldn't depend on HttpException (via ConflictError via DomainError). Keeping it as a plain domain Error preserves the hexagonal boundary.

### Decision 8 — Code string rename: `RATE_LIMITED` → `RATE_LIMIT`

**Decision**: The public response `code` for 429 responses changes from `RATE_LIMITED` (problem6 today) to `RATE_LIMIT` (matching problem5). This is a minor public-envelope change.

**Rationale**: We're aligning with problem5's code strings so the two modules speak the same error vocabulary. The old string was arbitrary; the new string matches the standard "nominal code, not past tense" convention used everywhere else (`VALIDATION` not `VALIDATED`, `CONFLICT` not `CONFLICTED`). Today problem6 has no prod release, no external clients, no documented contract consumer — the window to standardize is now.

**Alternatives rejected**:
- *Keep `RATE_LIMITED` for backward compat*: rejected — there's nothing to be backward compatible with; no client depends on it yet.
- *Match problem5 on everything except `RATE_LIMIT`*: rejected — inconsistency is worse than breaking an arbitrary string nobody depends on.

**Risk**: If any test asserts on the exact string `RATE_LIMITED`, it will fail. Task list Group 10 (tests) explicitly enumerates updating those tests.

### Decision 9 — `wrapUnknown` vs. duplicate-dispatch: one path, no branches in filter

**Decision**: After `wrapUnknown()` runs, the filter sees a `DomainError` — always. There are no more `instanceof` checks in the filter. The sequence is:

```
1. headersSent guard
2. appErr = wrapUnknown(exception)
3. errorId = crypto.randomUUID()  (always, used only if status >= 500)
4. metadata = buildErrorMetadata(appErr, request, errorId)
5. level = appErr.getStatus() >= 500 ? 'error' : 'warn'
6. logger[level](metadata, 'Request error')
7. errorsTotal.inc({code: appErr.code, status: String(appErr.getStatus())})
8. {status, body} = toPublicResponse(appErr, requestId, appErr.getStatus() >= 500 ? errorId : null)
9. reply.status(status).send(body)
```

**Rationale**: Filter simplicity is the outcome. Ten lines, no branches. Every behavior is a pure function of the wrapped error. Unit tests for each piece (`wrapUnknown`, `buildErrorMetadata`, `toPublicResponse`, scrubber) cover the logic; the filter test just verifies orchestration.

**Alternatives rejected**:
- *Inline classification in the filter*: rejected — same classification in two places (filter + wrapUnknown), doubles the test surface.
- *Multiple filters via NestJS's `@Catch(SpecificType)`*: rejected — Nest's filter chaining doesn't help when the goal is "one path for all errors," and testing becomes `@Catch(ZodError) + @Catch(HttpException) + @Catch()` interaction which is a minor nightmare.

### Decision 10 — Metric naming and label cardinality

**Decision**: The counter is `scoreboard_errors_total` with labels `{code, status}`. Label values:
- `code` ∈ `ErrorCode` union (10 values)
- `status` ∈ `{'400', '401', '403', '404', '409', '422', '429', '500', '503'}` (9 values)

Cardinality ceiling: 90 series. Realistic cardinality: ~15 series (most code×status combinations don't exist).

**Rationale**: Low, bounded cardinality. No per-user-id or per-route labels — those would blow up cardinality. If per-route error rates become important later, add a separate metric with a route label; do not extend this one.

**Alternatives rejected**:
- *Add `route` as a label*: rejected — route cardinality can be high if path params aren't normalized, and the existing `http_request_duration_seconds` metric already has route labels. Cross-reference by requestId if needed.
- *Add `errorClass` as a label*: rejected — redundant with `code`.
- *Skip `status` and derive it from `code`*: rejected — easier for Grafana queries to filter by `status=~"5.."` for "any 5xx."

## Risks / Trade-offs

- **[Filter tests need rewriting]** → Mitigation: Group 10 of tasks.md explicitly lists rewriting `test/unit/interface/http/error-filter.test.ts` to match the new orchestration. Most existing test scenarios (ZodError → 400, HttpException → status passthrough, Redis error → 503) stay valid; they just target `wrapUnknown` now instead of the filter directly.
- **[`RATE_LIMITED` → `RATE_LIMIT` is a public-envelope change]** → Mitigation: no prod release, no documented contract, no external clients today (step-07 is still in progress). Task 2.8 adds a regression test for the new string so we don't accidentally revert.
- **[33 throw sites refactor is mechanical but tedious]** → Mitigation: task list groups the refactor by layer (guards → controllers → domain → infra) so each commit is small. Each throw-site change is 1-3 lines. Grep is reliable because NestJS's built-in exceptions have predictable names.
- **[`HttpException` extension may affect `Reflect.getMetadata` behavior]** → Mitigation: unlikely — NestJS uses reflection for decorators, not for exceptions. `DomainError extends HttpException` is a plain class inheritance and doesn't touch metadata reflection. Validated by running the existing `@Catch()` filter test suite after the refactor.
- **[Metadata builder is now on the error hot path]** → Mitigation: error-path latency is not an SLO concern (it's < 1% of requests at the p50 target), and the builder is ~30 lines of synchronous JS. Measure only if it becomes an issue.
- **[`mapDbError` structural check may miss exotic pg errors]** → Mitigation: Unknown shapes fall through to the non-pg branch and become `InternalError` with the original as cause. The full error is preserved in the log, just not mapped to a typed domain error. This is the same behavior problem5 has; it's safe.
- **[JSON-safe serialization of `CauseEntry[]` / `ErrorMetadata`]** → Pino handles this natively; NestJS's Logger currently JSON.stringifies the first arg. Task 10.3 verifies the log output is valid JSON end-to-end.
- **[Header scrubber denylist drifts from new header names]** → Mitigation: default denylist matches the current threat surface (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `action-token`). When a new sensitive header is introduced, add it to `DEFAULT_HEADER_DENYLIST`. No config knob today; adding one later is ~10 lines.

## Migration Plan

This is an in-place refactor; no data migration, no new config, no new deps.

**Order (enforced by task groups):**
1. Add the `scoreboard/shared/errors/` directory with all 8 new files. Unit tests green. (Groups 1-5 in tasks.md)
2. Rewrite `HttpExceptionFilter` against the new primitives; filter test green. (Group 6)
3. Refactor throw sites layer-by-layer (guards → controllers → domain helpers → infra adapters). (Groups 7-8)
4. Wire `mapDbError` into `KyselyUserScoreRepository` where appropriate. (Group 9)
5. Add `scoreboard_errors_total` counter. (Group 9)
6. Update integration tests that depend on error shape. (Group 10)
7. Validate end-to-end: typecheck, lint, unit tests, integration tests. (Group 11)
8. `openspec validate`. (Group 12)

**Rollback**: Revert the commit. No data to roll forward or back. The filter is pure infrastructure; a rollback is mechanically equivalent to undoing a code change.

**Staging strategy**: The refactor is committable in ~10 commits (one per task group). Each commit is independently buildable; any commit can be `git reset`-ed without affecting earlier ones. This is a deliberate invariant of how the task groups are ordered.

## Open Questions

None. The exploration that preceded this change covered the full ROI matrix and design space. Decisions 1-10 close every architectural question. Any remaining uncertainty is at the implementation level (which task ordering is most efficient) and is left to `/opsx:apply`.
