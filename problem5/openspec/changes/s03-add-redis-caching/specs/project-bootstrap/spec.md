## MODIFIED Requirements

### Requirement: Health Endpoint

The service SHALL expose `GET /healthz` which reports liveness and readiness and SHALL return an appropriate HTTP status code for each state. Readiness SHALL include a `db` check that runs a lightweight query (`SELECT 1`) against the Postgres pool and a `cache` check that issues `PING` against the Redis client. Each check reports `"up"` on success or `"down"` with an error reason on failure.

#### Scenario: Service is live and ready

- **WHEN** a client issues `GET /healthz` while all upstream dependencies are reachable
- **THEN** the response status is `200 OK`
- **AND** the JSON body contains `{"status": "ok", "checks": {...}}`
- **AND** every entry in `checks` has status `"up"`
- **AND** `checks.db` and `checks.cache` are both present and report `"up"`

#### Scenario: Service is live but not ready

- **WHEN** a client issues `GET /healthz` while at least one upstream dependency is unreachable
- **THEN** the response status is `503 Service Unavailable`
- **AND** the JSON body contains `{"status": "degraded", "checks": {...}}`
- **AND** the unreachable dependency's entry has status `"down"` with an error reason

#### Scenario: Liveness-only probe during bootstrap

- **WHEN** a client issues `GET /healthz?probe=liveness` before readiness checks are wired up
- **THEN** the response status is `200 OK`
- **AND** the body reports only liveness

#### Scenario: Database is unreachable

- **WHEN** Postgres is stopped while the service is running
- **THEN** `GET /healthz` returns `503 Service Unavailable`
- **AND** `checks.db` is `{"status": "down", "error": "..."}`
- **AND** `GET /healthz?probe=liveness` still returns `200 OK`

#### Scenario: Redis is unreachable

- **WHEN** Redis is stopped while the service is running
- **THEN** `GET /healthz` returns `503 Service Unavailable`
- **AND** `checks.cache` is `{"status": "down", "error": "..."}`
- **AND** `GET /healthz?probe=liveness` still returns `200 OK`
- **AND** resource GET requests continue to succeed (served from Postgres) with `X-Cache: MISS`
