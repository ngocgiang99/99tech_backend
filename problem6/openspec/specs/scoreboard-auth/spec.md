# scoreboard-auth

## Purpose

JWT verification (JWKS-based) and HMAC action-token issuer/verifier for the scoreboard module. Owns the auth guards (`JwtGuard`, `ActionTokenGuard`), the JWKS cache, the action-token signer/verifier classes, and the `actions:issue-token` endpoint. Establishes the contract that every protected endpoint runs `JwtGuard` first.

## Requirements

### Requirement: JWKS cache fetches and stores public keys for 1 hour

The `JwksCache` service SHALL fetch JWT verification keys from `JWKS_URL` (configured via `ConfigService`) and cache them in-memory for 1 hour. On cache miss or TTL expiry, the cache SHALL re-fetch transparently.

#### Scenario: First verify call fetches the JWKS
- **GIVEN** a freshly booted `JwksCache` with no cached keys
- **WHEN** `jwksCache.verify(token)` is called for the first time
- **THEN** the cache fetches `GET <JWKS_URL>` and parses the response
- **AND** the parsed JWK is stored in the in-memory cache keyed by the token's `kid` header

#### Scenario: Subsequent verify calls hit the cache
- **GIVEN** a `JwksCache` with a cached JWK for a given `kid`
- **WHEN** another `jwksCache.verify(token)` is called within 1 hour with the same `kid`
- **THEN** no HTTP request is made to `JWKS_URL`
- **AND** verification proceeds against the cached key

#### Scenario: Cache refreshes after TTL expires
- **GIVEN** a `JwksCache` whose entry was inserted more than 1 hour ago
- **WHEN** the next `jwksCache.verify(token)` is called
- **THEN** the cache re-fetches `<JWKS_URL>` and replaces the stored entry

### Requirement: JwtGuard enforces all required JWT claims

`JwtGuard.canActivate(context)` SHALL verify the bearer token has a valid signature, `iss === JWT_ISSUER`, `aud === JWT_AUDIENCE`, `exp > now`, and an algorithm in `[RS256, ES256]`. On any failure, the guard SHALL throw or return false to produce a `401 UNAUTHENTICATED` response. On success, the guard SHALL set `request.userId = payload.sub`.

#### Scenario: Valid token allows the request and sets userId
- **GIVEN** a request with `Authorization: Bearer <valid-RS256-jwt>` whose `iss`, `aud`, `exp` all match the configuration
- **WHEN** `JwtGuard` runs
- **THEN** the guard returns true
- **AND** `request.userId` equals the JWT `sub` claim

#### Scenario: Missing Authorization header is rejected
- **GIVEN** a request with no `Authorization` header
- **WHEN** `JwtGuard` runs
- **THEN** the response is `401 UNAUTHENTICATED`
- **AND** no downstream guard runs

#### Scenario: Token with wrong audience is rejected
- **GIVEN** a syntactically valid JWT whose `aud` claim is `"other-service"` (not `scoreboard`)
- **WHEN** `JwtGuard` runs
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: Expired token is rejected
- **GIVEN** a valid JWT whose `exp` is in the past
- **WHEN** `JwtGuard` runs
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: Token with alg=none is rejected at parse time
- **GIVEN** a token whose header declares `alg: "none"`
- **WHEN** `JwtGuard` runs
- **THEN** the guard rejects BEFORE any signature verification (the parse step rejects unsigned tokens)
- **AND** the response is `401 UNAUTHENTICATED`

#### Scenario: Tampered signature is rejected
- **GIVEN** a JWT whose payload has been mutated after signing
- **WHEN** `JwtGuard` runs
- **THEN** signature verification fails
- **AND** the response is `401 UNAUTHENTICATED`

### Requirement: Action token issuer endpoint mints HMAC-bound capability tokens

`POST /v1/actions:issue-token` SHALL be JWT-protected. On a valid request with body `{ actionType: string }`, the endpoint SHALL: (1) generate a fresh `actionId` (UUID v4), (2) mint an HS256 JWT with claims `{ sub, aid, atp, mxd, iat, exp }` signed with `ACTION_TOKEN_SECRET`, (3) record `SET NX EX <ACTION_TOKEN_TTL_SECONDS> action:issued:<aid>` in Redis, and (4) return `{ actionId, actionToken, expiresAt, maxDelta }`.

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

#### Scenario: Issued token is recorded in Redis
- **GIVEN** a successful issuance
- **WHEN** Redis is inspected
- **THEN** the key `action:issued:<actionId>` exists with TTL `<ACTION_TOKEN_TTL_SECONDS>`
- **AND** the value is the issuance metadata (or any non-empty marker)

#### Scenario: Raw action token is never logged
- **GIVEN** a successful issuance
- **WHEN** the application logs are inspected (during the request or after)
- **THEN** the raw `actionToken` JWT string does NOT appear in any log line
- **AND** if logging is needed, only the `actionId` (which is safe to log) is referenced

### Requirement: ActionTokenGuard verifies all six bindings and consumes the token

`ActionTokenGuard.canActivate()` SHALL run after `JwtGuard` and SHALL verify the action token by checking: (1) `alg === HS256`, (2) HMAC signature using `ACTION_TOKEN_SECRET`, (3) `exp > now`, (4) `sub === request.userId` (set by `JwtGuard`), (5) `aid === request.body.actionId`, (6) `mxd >= request.body.delta`. On success, it SHALL atomically `SET NX` on `idempotency:action:<aid>` and proceed. On any failure, it SHALL produce `403 INVALID_ACTION_TOKEN`. On SETNX loss (token already consumed), it SHALL produce `403 ACTION_ALREADY_CONSUMED`.

#### Scenario: Valid action token allows the request through
- **GIVEN** a request whose action token passes all six checks AND whose `aid` is not present in Redis
- **WHEN** `ActionTokenGuard` runs
- **THEN** the guard's `SET NX idempotency:action:<aid>` succeeds
- **AND** the request proceeds to `RateLimitGuard`

#### Scenario: Wrong sub binding is rejected
- **GIVEN** a request where `JwtGuard` set `request.userId = u1` but the action token's `sub` is `u2`
- **WHEN** `ActionTokenGuard` runs
- **THEN** the response is `403 INVALID_ACTION_TOKEN`

#### Scenario: aid mismatch with body actionId is rejected
- **GIVEN** a request whose body says `actionId = a1` but the action token's `aid` is `a2`
- **WHEN** `ActionTokenGuard` runs
- **THEN** the response is `403 INVALID_ACTION_TOKEN`

#### Scenario: delta exceeding mxd is rejected
- **GIVEN** an action token with `mxd = 10` and a body with `delta = 100`
- **WHEN** `ActionTokenGuard` runs
- **THEN** the response is `403 INVALID_ACTION_TOKEN`

#### Scenario: Tampered HMAC signature is rejected
- **GIVEN** an action token whose payload has been mutated after signing
- **WHEN** `ActionTokenGuard` runs
- **THEN** the HMAC verification fails
- **AND** the response is `403 INVALID_ACTION_TOKEN`

#### Scenario: Already-consumed token is rejected with cached prior outcome
- **GIVEN** a syntactically valid token whose `aid` already has a SETNX entry in Redis
- **WHEN** `ActionTokenGuard` runs and the SETNX loses
- **THEN** the response is `403 ACTION_ALREADY_CONSUMED`
- **AND** if the SETNX value contains the cached prior outcome, the response includes that outcome (otherwise a generic 403 error envelope)
