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

- **WHEN** a client `POST`s `{"name": "foo", "type": "widget"}` to `/resources`
- **THEN** the response status is `201 Created`
- **AND** the response body contains all fields with server-generated `id`, `status = "active"`, `tags = []`, `metadata = {}`, and equal `createdAt`/`updatedAt`

#### Scenario: Client exceeds a size limit

- **WHEN** a client submits a `name` longer than 200 characters
- **THEN** the response status is `400 Bad Request`
- **AND** the body is `{"error": {"code": "VALIDATION", "message": "...", "details": [...]}}` identifying the offending field

### Requirement: Create Resource

The service SHALL accept `POST /resources` with a JSON body matching the create schema, persist a new resource, and return the persisted representation.

#### Scenario: Valid create request

- **WHEN** a client sends a valid JSON body to `POST /resources`
- **THEN** the response status is `201 Created`
- **AND** the `Location` header is `/resources/{id}`
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

The service SHALL accept `GET /resources/:id` where `:id` is a UUID and SHALL return the persisted resource or a not-found error.

#### Scenario: Resource exists

- **WHEN** a client sends `GET /resources/{existing-id}`
- **THEN** the response status is `200 OK`
- **AND** the body is the full `Resource` representation

#### Scenario: Resource does not exist

- **WHEN** a client sends `GET /resources/{random-uuid}`
- **THEN** the response status is `404 Not Found`
- **AND** the body is `{"error": {"code": "NOT_FOUND", "message": "Resource not found"}}`

#### Scenario: Id is not a UUID

- **WHEN** a client sends `GET /resources/not-a-uuid`
- **THEN** the response status is `400 Bad Request`
- **AND** the error code is `VALIDATION`

### Requirement: Update Resource

The service SHALL accept `PATCH /resources/:id` with a partial JSON body, apply a field-level merge to the existing resource, refresh `updatedAt`, and return the new representation. Only fields present in the body are modified; `id`, `createdAt`, and `updatedAt` are never writable by the client.

#### Scenario: Partial update of a mutable field

- **WHEN** a client sends `PATCH /resources/{id}` with `{"status": "archived"}`
- **THEN** the response status is `200 OK`
- **AND** the response body's `status` equals `"archived"`
- **AND** the `updatedAt` is strictly greater than the previous `updatedAt`
- **AND** all other fields are unchanged

#### Scenario: Update of metadata merges or replaces (policy: replace)

- **WHEN** a client sends `PATCH /resources/{id}` with `{"metadata": {"k": "v"}}`
- **THEN** the stored metadata is exactly `{"k": "v"}` — the previous `metadata` object is replaced, not merged
- **AND** the response body reflects the replacement

#### Scenario: Attempt to write a server-controlled field

- **WHEN** a client sends `PATCH /resources/{id}` with `{"id": "different", "createdAt": "..."}`
- **THEN** the response status is `400 Bad Request`
- **AND** no row is modified

#### Scenario: Target resource does not exist

- **WHEN** a client sends `PATCH /resources/{unknown-id}` with a valid body
- **THEN** the response status is `404 Not Found`

### Requirement: Delete Resource

The service SHALL accept `DELETE /resources/:id` and SHALL return `204 No Content` on success or `404 Not Found` if the resource does not exist. Deletes are hard deletes.

#### Scenario: Delete existing resource

- **WHEN** a client sends `DELETE /resources/{existing-id}`
- **THEN** the response status is `204 No Content`
- **AND** the response body is empty
- **AND** a subsequent `GET /resources/{id}` returns `404 Not Found`

#### Scenario: Delete non-existent resource

- **WHEN** a client sends `DELETE /resources/{random-uuid}`
- **THEN** the response status is `404 Not Found`

### Requirement: List Resources with Filters and Keyset Pagination

The service SHALL accept `GET /resources` with the filter query parameters defined below, return up to `limit` results ordered by `createdAt DESC, id DESC`, and use keyset (not offset) pagination. The response body SHALL be `{"data": Resource[], "nextCursor": string | null}`.

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

- **WHEN** a client sends `GET /resources?limit=5` against a table containing ten resources
- **THEN** the response status is `200 OK`
- **AND** the response contains exactly five resources
- **AND** results are ordered by `createdAt` descending, with ties broken by `id` descending
- **AND** `nextCursor` is a non-null opaque string

#### Scenario: Follow-up page via cursor

- **WHEN** a client sends `GET /resources?limit=5&cursor={nextCursor}` using the cursor from the previous scenario
- **THEN** the response contains the next batch of resources in the same order
- **AND** no resource appears in both pages

#### Scenario: Last page

- **WHEN** a client pages until fewer than `limit` resources remain
- **THEN** the response contains the remaining resources
- **AND** `nextCursor` is `null`

#### Scenario: Filter by type

- **WHEN** a client sends `GET /resources?type=widget`
- **THEN** every resource in `data` has `type == "widget"`

#### Scenario: Filter by multiple statuses

- **WHEN** a client sends `GET /resources?status=active&status=pending`
- **THEN** every resource in `data` has `status` equal to `"active"` or `"pending"`

#### Scenario: Filter by multiple tags (AND semantics)

- **WHEN** a client sends `GET /resources?tag=red&tag=urgent`
- **THEN** every resource in `data` has both `"red"` and `"urgent"` in its `tags` array

#### Scenario: Filter by createdAfter / createdBefore

- **WHEN** a client sends `GET /resources?createdAfter=2026-01-01T00:00:00Z&createdBefore=2026-02-01T00:00:00Z`
- **THEN** every resource in `data` has `createdAt` in `[2026-01-01, 2026-02-01)`

#### Scenario: Invalid filter value

- **WHEN** a client sends `GET /resources?limit=999`
- **THEN** the response status is `400 Bad Request`
- **AND** the error body identifies `limit` as the offending field

#### Scenario: Invalid cursor

- **WHEN** a client sends `GET /resources?cursor=garbage`
- **THEN** the response status is `400 Bad Request`
- **AND** the error code is `VALIDATION`

#### Scenario: Cursor stability across unrelated writes

- **WHEN** a client receives a `nextCursor`, another client creates a new resource, and the first client then requests the next page
- **THEN** the next page does not duplicate any resource from the previous page
- **AND** keyset ordering guarantees are preserved (newer resources appear on earlier pages, not mid-sequence)

### Requirement: Error Response Shape

All error responses SHALL share the shape `{"error": {"code": string, "message": string, "requestId": string, "details"?: unknown}}`, and the HTTP status SHALL match the `code`: `VALIDATION` → 400, `NOT_FOUND` → 404, `CONFLICT` → 409, `INTERNAL_ERROR` → 500.

#### Scenario: Validation error shape

- **WHEN** a request body fails Zod validation
- **THEN** the response body matches the shared error shape
- **AND** `code` is `"VALIDATION"` and `details` is an array of field-level errors

#### Scenario: Not-found error shape

- **WHEN** a request targets an id that does not exist
- **THEN** the response body matches the shared error shape
- **AND** `code` is `"NOT_FOUND"` and `requestId` matches the `X-Request-Id` response header
