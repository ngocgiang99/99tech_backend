# resources-management

## Purpose

Defines the `Resource` domain entity and the HTTP contract for creating,
reading, listing, updating, and deleting resources. Covers the request/response
schemas, filter and pagination semantics for the list endpoint, and the
shared error-response shape that all resource endpoints honor.

## Requirements

### Requirement: Resource Entity Schema

A `Resource` SHALL be persisted with the following fields: `id` (UUID, server-generated), `name` (non-empty string, ≤ 200 chars), `type` (non-empty string, ≤ 64 chars), `status` (non-empty string, ≤ 32 chars, defaults to `"active"`), `tags` (array of strings, each ≤ 64 chars, array length ≤ 32, may be empty), `ownerId` (UUID, nullable), `metadata` (JSON object, ≤ 16 KB when serialized, defaults to `{}`), `createdAt` (ISO-8601 timestamp, server-set), and `updatedAt` (ISO-8601 timestamp, server-set).

#### Scenario: Client creates a resource with only required fields

- **WHEN** a client `POST`s `{"name": "foo", "type": "widget"}` to `/api/v1/resources`
- **THEN** the response status is `201 Created`
- **AND** the response body contains all fields with server-generated `id`, `status = "active"`, `tags = []`, `metadata = {}`, and equal `createdAt`/`updatedAt`

#### Scenario: Client exceeds a size limit

- **WHEN** a client submits a `name` longer than 200 characters
- **THEN** the response status is `400 Bad Request`
- **AND** the body is `{"error": {"code": "VALIDATION", "message": "...", "details": [...]}}` identifying the offending field

### Requirement: Create Resource

The service SHALL accept `POST /api/v1/resources` with a JSON body matching the create schema, persist a new resource, and return the persisted representation.

#### Scenario: Valid create request

- **WHEN** a client sends a valid JSON body to `POST /api/v1/resources`
- **THEN** the response status is `201 Created`
- **AND** the `Location` header is `/api/v1/resources/{id}`
- **AND** the response body is the full `Resource` representation including server-generated fields

#### Scenario: Request body is not JSON

- **WHEN** a client sends `Content-Type: text/plain` or malformed JSON
- **THEN** the response status is `400 Bad Request`
- **AND** the body contains a `VALIDATION` error code

#### Scenario: Unknown fields in create body

- **WHEN** a client submits a body with fields outside the create schema
- **THEN** the response status is `400 Bad Request`
- **AND** the error details identify the unknown field(s)
- **AND** no database row is created

### Requirement: Get Resource by Id

The service SHALL accept `GET /api/v1/resources/:id` where `:id` is a UUID and SHALL return the persisted resource or a not-found error.

#### Scenario: Resource exists

- **WHEN** a client sends `GET /api/v1/resources/{existing-id}`
- **THEN** the response status is `200 OK`
- **AND** the body is the full `Resource` representation

#### Scenario: Resource does not exist

- **WHEN** a client sends `GET /api/v1/resources/{random-uuid}`
- **THEN** the response status is `404 Not Found`
- **AND** the body is `{"error": {"code": "NOT_FOUND", "message": "Resource not found"}}`

#### Scenario: Id is not a UUID

- **WHEN** a client sends `GET /api/v1/resources/not-a-uuid`
- **THEN** the response status is `400 Bad Request`
- **AND** the error code is `VALIDATION`

### Requirement: Update Resource

The service SHALL accept `PATCH /api/v1/resources/:id` with a partial JSON body, apply a field-level merge to the existing resource, refresh `updatedAt`, and return the new representation. Only fields present in the body are modified; `id`, `createdAt`, and `updatedAt` are never writable by the client.

#### Scenario: Partial update of a mutable field

- **WHEN** a client sends `PATCH /api/v1/resources/{id}` with `{"status": "archived"}`
- **THEN** the response status is `200 OK`
- **AND** the response body's `status` equals `"archived"`
- **AND** the `updatedAt` is strictly greater than the previous `updatedAt`
- **AND** all other fields are unchanged

#### Scenario: Update of metadata merges or replaces (policy: replace)

- **WHEN** a client sends `PATCH /api/v1/resources/{id}` with `{"metadata": {"k": "v"}}`
- **THEN** the stored metadata is exactly `{"k": "v"}` — the previous `metadata` object is replaced, not merged
- **AND** the response body reflects the replacement

#### Scenario: Attempt to write a server-controlled field

- **WHEN** a client sends `PATCH /api/v1/resources/{id}` with `{"id": "different", "createdAt": "..."}`
- **THEN** the response status is `400 Bad Request`
- **AND** no row is modified

#### Scenario: Target resource does not exist

- **WHEN** a client sends `PATCH /api/v1/resources/{unknown-id}` with a valid body
- **THEN** the response status is `404 Not Found`

### Requirement: Delete Resource

The service SHALL accept `DELETE /api/v1/resources/:id` and SHALL return `204 No Content` on success or `404 Not Found` if the resource does not exist. Deletes are hard deletes.

#### Scenario: Delete existing resource

- **WHEN** a client sends `DELETE /api/v1/resources/{existing-id}`
- **THEN** the response status is `204 No Content`
- **AND** the response body is empty
- **AND** a subsequent `GET /api/v1/resources/{id}` returns `404 Not Found`

#### Scenario: Delete non-existent resource

- **WHEN** a client sends `DELETE /api/v1/resources/{random-uuid}`
- **THEN** the response status is `404 Not Found`

### Requirement: List Resources with Filters and Keyset Pagination

The service SHALL accept `GET /api/v1/resources` with the filter query parameters defined below, return up to `limit` results ordered by `createdAt DESC, id DESC`, and use keyset (not offset) pagination. The response body SHALL be `{"data": Resource[], "nextCursor": string | null}`.

Supported filters:

- `type` — exact match, may be specified once.
- `status` — exact match, may be specified multiple times; multiple values are combined with OR.
- `tag` — tag membership, may be specified multiple times; multiple values are combined with AND (all listed tags must be present on the resource).
- `ownerId` — exact UUID match.
- `createdAfter` — ISO-8601 timestamp, inclusive lower bound on `createdAt`.
- `createdBefore` — ISO-8601 timestamp, exclusive upper bound on `createdAt`.
- `limit` — integer in `[1, 100]`, default `20`.
- `cursor` — opaque keyset cursor returned by a previous response.
- `sort` — one of `-createdAt` (default), `createdAt`, `-updatedAt`, `updatedAt`, `name`, `-name`.

#### Scenario: Unfiltered list returns newest first

- **WHEN** a client sends `GET /api/v1/resources?limit=5` against a table containing ten resources
- **THEN** the response status is `200 OK`
- **AND** the response contains exactly five resources
- **AND** results are ordered by `createdAt` descending, with ties broken by `id` descending
- **AND** `nextCursor` is a non-null opaque string

#### Scenario: Follow-up page via cursor

- **WHEN** a client sends `GET /api/v1/resources?limit=5&cursor={nextCursor}` using the cursor from the previous scenario
- **THEN** the response contains the next batch of resources in the same order
- **AND** no resource appears in both pages

#### Scenario: Last page

- **WHEN** a client pages until fewer than `limit` resources remain
- **THEN** the response contains the remaining resources
- **AND** `nextCursor` is `null`

#### Scenario: Filter by type

- **WHEN** a client sends `GET /api/v1/resources?type=widget`
- **THEN** every resource in `data` has `type == "widget"`

#### Scenario: Filter by multiple statuses

- **WHEN** a client sends `GET /api/v1/resources?status=active&status=pending`
- **THEN** every resource in `data` has `status` equal to `"active"` or `"pending"`

#### Scenario: Filter by multiple tags (AND semantics)

- **WHEN** a client sends `GET /api/v1/resources?tag=red&tag=urgent`
- **THEN** every resource in `data` has both `"red"` and `"urgent"` in its `tags` array

#### Scenario: Filter by createdAfter / createdBefore

- **WHEN** a client sends `GET /api/v1/resources?createdAfter=2026-01-01T00:00:00Z&createdBefore=2026-02-01T00:00:00Z`
- **THEN** every resource in `data` has `createdAt` in `[2026-01-01, 2026-02-01)`

#### Scenario: Invalid filter value

- **WHEN** a client sends `GET /api/v1/resources?limit=999`
- **THEN** the response status is `400 Bad Request`
- **AND** the error body identifies `limit` as the offending field

#### Scenario: Invalid cursor

- **WHEN** a client sends `GET /api/v1/resources?cursor=garbage`
- **THEN** the response status is `400 Bad Request`
- **AND** the error code is `VALIDATION`

#### Scenario: Cursor stability across unrelated writes

- **WHEN** a client receives a `nextCursor`, another client creates a new resource, and the first client then requests the next page
- **THEN** the next page does not duplicate any resource from the previous page
- **AND** keyset ordering guarantees are preserved (newer resources appear on earlier pages, not mid-sequence)

#### Scenario: Sort by name with a cursor compares names against names

- **GIVEN** a client has seeded multiple resources with distinct names that sort alphabetically
- **WHEN** the client issues `GET /api/v1/resources?limit=N&sort=name` to fetch page 1
- **AND** then follows the returned `nextCursor` to fetch page 2
- **THEN** page 2's resources are all alphabetically after page 1's last resource
- **AND** no resource appears on both pages
- **AND** the backing SQL predicate compares the `name` column against a string value taken from the last row's `name`, not against a timestamp

### Requirement: Error Response Shape

All error responses SHALL share exactly the shape `{error: {code, message, requestId, details?, errorId?}}` and SHALL NOT contain any additional fields. The HTTP status SHALL be the status mapped from the error `code` via the stable code-to-status mapping defined in the `error-handling` capability.

The fields are exhaustively enumerated:

- `code`: one of the stable error codes (`VALIDATION`, `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE_ENTITY`, `RATE_LIMIT`, `DEPENDENCY_UNAVAILABLE`, `INTERNAL_ERROR`); always present.
- `message`: a human-readable string of at most 200 characters that is safe for public exposure; always present; longer underlying messages are truncated with `"..."`.
- `requestId`: the request correlation id echoed from the inbound `X-Request-Id` header (or generated if absent); always present.
- `details`: present ONLY for `VALIDATION` errors; an array of `{path: string, code: string, message: string}` entries, one per validation failure.
- `errorId`: present ONLY for 5xx responses; a UUID correlating the response with the dev-log entry for the same error.

No other fields are permitted. The `message` field SHALL NOT contain implementation-specific information, including but not limited to: stack frames, file paths, SQL fragments, library or class names, internal identifiers, raw exception text, or values from offending rows.

#### Scenario: Validation error shape

- **WHEN** a request body fails Zod validation
- **THEN** the response body matches the shared error shape
- **AND** `code` is `"VALIDATION"`
- **AND** `details` is an array of field-level `{path, code, message}` entries
- **AND** no `errorId` field is present

#### Scenario: Not-found error shape

- **WHEN** a request targets an id that does not exist
- **THEN** the response body matches the shared error shape
- **AND** `code` is `"NOT_FOUND"`
- **AND** `requestId` matches the `X-Request-Id` response header
- **AND** no `details` or `errorId` fields are present

#### Scenario: 500 error shape and leak check

- **WHEN** the error handler is triggered for an unexpected error on any `/api/v1/resources` endpoint
- **THEN** the response body matches the shared error shape
- **AND** `code` is `"INTERNAL_ERROR"`
- **AND** `message` is the generic string `"Internal server error"`
- **AND** `errorId` is a UUID that matches the dev-log entry
- **AND** the response body contains no stack traces, SQL, file paths, library names, or class names

#### Scenario: Conflict error from unique violation

- **WHEN** a `POST /api/v1/resources` triggers a unique constraint violation in Postgres
- **THEN** the infrastructure error mapper translates the pg error (code `23505`) to `ConflictError`
- **AND** the response status is `409 Conflict`
- **AND** the response body is `{"error": {"code": "CONFLICT", "message": "Resource already exists", "requestId": "..."}}`
- **AND** the response body does NOT leak the constraint name, column name, or offending value

### Requirement: List cursor decoding is local to the raw repository

The system SHALL decode the opaque base64url `cursor` query parameter into a typed `CursorPayload` variant exactly once per request, and that decoded value SHALL remain a local variable inside the raw-repository `list()` function body — it MUST NOT escape that function to the layers above (service, cached-repository decorator, controller, response serializer). When the raw repository produces a `nextCursor` for the next page, it SHALL encode the payload to the opaque string form before returning, so every layer above the raw repo's SQL body sees only the wire-shape string. The cached-repository decorator and the service SHALL NOT import any cursor codec functions.

#### Scenario: Same-deployment cache key is stable for identical requests

- **GIVEN** the running deployment has served a request for `GET /api/v1/resources?limit=5&sort=-createdAt` and populated the response cache with the result
- **WHEN** an identical request arrives on the same deployment
- **THEN** the cache-key derivation produces bytes-identical key material to the first request
- **AND** the request is served as a cache HIT
- **AND** the response body matches the first request's body

#### Scenario: Cached-repository decorator and service do not import cursor codec

- **WHEN** the developer runs `grep -n 'decodeCursor\|encodeCursor' src/modules/resources/application/service.ts src/modules/resources/infrastructure/cached-repository.ts`
- **THEN** zero matches are returned
- **AND** the only production files importing `decodeCursor`/`encodeCursor` are inside the raw repository or its test

### Requirement: List query cursor is a per-column-typed discriminated union

The `CursorPayload` type SHALL be a discriminated union whose variants each carry a typed `value` field matching the SQL column the cursor is compared against. A timestamp-sorted cursor (`-createdAt`, `createdAt`, `-updatedAt`, `updatedAt`) SHALL carry `value: Date`. A name-sorted cursor (`name`, `-name`) SHALL carry `value: string` holding the last row's `name` (NOT a timestamp). Each variant SHALL implement a uniform codec interface exposing `encode`, `decode`, and `configFor` (sort-value to SQL sort config) members, so adding a new cursor variant is a purely additive change. The keyset-pagination predicate SHALL NOT use `as unknown`, `as never`, or any other escape-hatch cast to bypass the compiler's check that the cursor value type matches the column type.

#### Scenario: Production resources module has zero escape-hatch casts

- **GIVEN** the files `src/modules/resources/application/service.ts`, `src/modules/resources/infrastructure/repository.ts`, and `src/modules/resources/infrastructure/cached-repository.ts`
- **WHEN** the developer runs `grep -n 'as unknown\|as never'` across those files
- **THEN** zero real code matches are returned (comment-only mentions are permitted)
- **AND** the defensive `as unknown` on the `JSON.parse` call in `src/modules/resources/infrastructure/cursor.ts` is allowed to remain — it narrows `any` to force a later validation gate, a tightening rather than a loosening

#### Scenario: Adding an unhandled sort column breaks the build at multiple sites

- **GIVEN** a developer adds a new literal (e.g. `'-priority'`) to the `SORT_VALUES` tuple in `src/modules/resources/schema.ts` without creating a new cursor variant or extending an existing codec
- **WHEN** the project is type-checked with `pnpm typecheck`
- **THEN** TypeScript reports errors at multiple sites: the `decodeCursor` switch, the `sortConfigFor` switch, and the repository's `nextCursor` construction switch each flag the new sort literal as not handled (exhaustiveness check against `never`)
- **AND** the errors fire at compile time, not at runtime on the first request using the new sort

### Requirement: Internal cursor wire format change is accepted at deploy cutover

The encoded cursor string's inner JSON shape changes from a pre-refactor `{createdAt, id, sort}` to a discriminated union `{kind, value, id, sort}`. The HTTP query parameter `cursor` remains opaque base64url from the client's perspective, but cursors issued by the pre-refactor code SHALL be rejected by the post-refactor decoder, and post-refactor cache entries SHALL NOT share keys with any pre-refactor cache entry whose key material included a legacy-shape cursor. This is an accepted one-time regression at the deploy cutover — bounded in scope to clients mid-pagination and to cursor-keyed cache entries.

#### Scenario: A legacy-shape cursor is rejected with VALIDATION

- **GIVEN** a client holds a cursor encoded under the pre-refactor format (`{"createdAt":"...","id":"...","sort":"-createdAt"}` base64url-encoded)
- **WHEN** the client sends that cursor to the post-refactor service in `GET /api/v1/resources?cursor=<legacy>`
- **THEN** the service responds `400 Bad Request` with error code `VALIDATION`
- **AND** the client's recovery path is to re-request page 1 (omit the cursor)
