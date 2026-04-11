## MODIFIED Requirements

### Requirement: Action token issuer endpoint mints HMAC-bound capability tokens

`POST /v1/actions:issue-token` SHALL be JWT-protected. On a valid request with body `{ actionType: string }`, the endpoint SHALL: (1) generate a fresh `actionId` (UUID v4), (2) mint an HS256 JWT with claims `{ sub, aid, atp, mxd, iat, exp }` signed with `ACTION_TOKEN_SECRET`, and (3) return `{ actionId, actionToken, expiresAt, maxDelta }`. The endpoint SHALL NOT write any per-issuance state to Redis, Postgres, or any other store; token authenticity is proven entirely by the HMAC signature at consumption time, and replay detection is the responsibility of the consumption path (`ActionTokenGuard` via `idempotency:action:<aid>` SETNX + the `uq_score_events_action` UNIQUE constraint).

#### Scenario: Successful issuance returns a typed envelope
- **GIVEN** a JWT-authenticated request with body `{ actionType: "level-complete" }`
- **WHEN** the handler runs
- **THEN** the response is `200` with body `{ actionId, actionToken, expiresAt, maxDelta }`
- **AND** `actionId` is a fresh UUID v4
- **AND** `actionToken` is an HS256 JWT whose claims match `{ sub: request.userId, aid: actionId, atp: "level-complete", mxd: <max delta>, iat, exp }`
- **AND** `expiresAt` equals `iat + ACTION_TOKEN_TTL_SECONDS` in ISO-8601 format

#### Scenario: Unknown actionType is rejected
- **GIVEN** a request with body `{ actionType: "not-a-real-type" }`
- **WHEN** the handler runs
- **THEN** the response is `400 INVALID_REQUEST`
- **AND** the response body's `error.message` names the offending field

#### Scenario: Issuance does NOT write to Redis
- **GIVEN** a Redis instance with a clean keyspace and a successful issuance of `actionId = A1`
- **WHEN** Redis is inspected after the `200` response
- **THEN** no key matching `action:issued:*` exists
- **AND** no key matching `idempotency:action:*` exists (that key is only written by `ActionTokenGuard` during consumption)

#### Scenario: Issuance succeeds when Redis is unreachable
- **GIVEN** Redis is down (connection refused, timeout, or any transport error)
- **AND** a JWT-authenticated request with body `{ actionType: "level-complete" }`
- **WHEN** the handler runs
- **THEN** the response is `200` with a valid token envelope
- **AND** no Redis call is attempted during the issuance path
- **AND** the minted token is consumable later (once Redis is restored) because its authenticity is proven by the HMAC signature, not by any Redis state

#### Scenario: Raw action token is never logged
- **GIVEN** a successful issuance
- **WHEN** the application logs are inspected (during the request or after)
- **THEN** the raw `actionToken` JWT string does NOT appear in any log line
- **AND** if logging is needed, only the `actionId` (which is safe to log) is referenced
