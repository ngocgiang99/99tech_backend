# api-versioning

## Purpose

Defines the URL-prefix versioning strategy for the Resources API. All feature-module routes are mounted under `/api/v1`, while infrastructure routes (`/healthz`, `/metrics`) remain at the root path.

## Requirements

### Requirement: URL-prefix API versioning
The system SHALL mount all feature-module routers under the `/api/v1` URL prefix. Infrastructure routes (`/healthz`, `/metrics`) SHALL remain at the root path without any version prefix.

#### Scenario: Resources API responds at versioned path
- **WHEN** a client sends `GET /api/v1/resources`
- **THEN** the system SHALL return `200` with the resource list

#### Scenario: Resources detail responds at versioned path
- **WHEN** a client sends `GET /api/v1/resources/{id}` with a valid resource ID
- **THEN** the system SHALL return `200` with the resource detail

#### Scenario: Create resource returns versioned Location header
- **WHEN** a client sends `POST /api/v1/resources` with a valid body
- **THEN** the system SHALL return `201` with a `Location` header value of `/api/v1/resources/{id}`

#### Scenario: Health route stays at root
- **WHEN** a client sends `GET /healthz`
- **THEN** the system SHALL return `200` (unchanged from current behavior)

#### Scenario: Metrics route stays at root
- **WHEN** a client sends `GET /metrics`
- **THEN** the system SHALL return `200` with Prometheus metrics (unchanged from current behavior)

#### Scenario: Old unversioned path returns 404
- **WHEN** a client sends `GET /resources`
- **THEN** the system SHALL return `404` (no backwards-compatible redirect)

### Requirement: Version router composability
A dedicated Express Router for `v1` SHALL be created in the HTTP wiring layer (`src/http/app.ts`). Future feature modules SHALL be mountable on this router with a single `v1.use(...)` call.

#### Scenario: Adding a future module
- **WHEN** a new feature module (e.g., users) is added
- **THEN** it SHALL be mountable via `v1.use('/users', usersModule.router)` without changing the versioning infrastructure
