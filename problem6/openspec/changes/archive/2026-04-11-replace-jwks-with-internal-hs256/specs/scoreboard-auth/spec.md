## REMOVED Requirements

### Requirement: JWKS cache fetches and stores public keys for 1 hour

**Reason**: problem6 no longer fetches JWT verification keys from an external JWKS endpoint. The `JwksCache` adapter and the `JWKS_URL` env var are removed because there is no Kong / API gateway / external IdP in front of problem6, and there is no production release. JWT verification is now performed directly with a shared HS256 secret (`INTERNAL_JWT_SECRET`).

**Migration**: Delete `src/scoreboard/infrastructure/auth/jwks-cache.ts` and `test/unit/auth/jwks-cache.test.ts`. Remove the `JwksCache` provider from `ScoreboardModule`. Any test fixture that previously relied on a fake JWKS HTTP server (e.g. `scripts/smoke-bootstrap.mjs`) is replaced by direct HS256 signing with `INTERNAL_JWT_SECRET`. If/when an external IdP is adopted later, re-introduce a separate `JwksGuard` as an additional guard layer alongside the internal HS256 `JwtGuard` — do not modify the HS256 path.

## MODIFIED Requirements

### Requirement: JwtGuard enforces all required JWT claims

`JwtGuard.canActivate(context)` SHALL verify the bearer token has a valid HS256 signature against `INTERNAL_JWT_SECRET`, `exp > now`, and an algorithm exactly equal to `HS256`. On any failure, the guard SHALL throw or return false to produce a `401 UNAUTHENTICATED` response. On success, the guard SHALL set `request.userId = payload.sub`. The guard SHALL NOT check `iss` or `aud` claims (those checks were meaningful only when an external IdP was the issuer; in a self-contained auth boundary the HMAC signature is the sole authenticity proof).

#### Scenario: Valid HS256 token allows the request and sets userId
- **GIVEN** a request with `Authorization: Bearer <valid-HS256-jwt-signed-with-INTERNAL_JWT_SECRET>` whose `exp` is in the future
- **WHEN** `JwtGuard` runs
- **THEN** the guard returns true
- **AND** `request.userId` equals the JWT `sub` claim

#### Scenario: Missing Authorization header is rejected
- **GIVEN** a request with no `Authorization` header
- **WHEN** `JwtGuard` runs
- **THEN** the response is `401 UNAUTHENTICATED`
- **AND** no downstream guard runs

#### Scenario: Token signed with a different secret is rejected
- **GIVEN** a syntactically valid HS256 JWT signed with the wrong secret
- **WHEN** `JwtGuard` runs
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: Expired token is rejected
- **GIVEN** a valid HS256 JWT whose `exp` is in the past
- **WHEN** `JwtGuard` runs
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: Token with alg=none is rejected
- **GIVEN** a token whose header declares `alg: "none"`
- **WHEN** `JwtGuard` runs
- **THEN** the guard rejects with `401 UNAUTHENTICATED`
- **AND** signature verification is never attempted

#### Scenario: Token with alg=RS256 is rejected (algorithm allowlist)
- **GIVEN** a token whose header declares `alg: "RS256"` (e.g. an attacker attempting algorithm confusion)
- **WHEN** `JwtGuard` runs
- **THEN** the guard rejects with `401 UNAUTHENTICATED`
- **AND** the rejection happens because `HS256` is the only allowed algorithm in the verify call

#### Scenario: Tampered signature is rejected
- **GIVEN** an HS256 JWT whose payload has been mutated after signing
- **WHEN** `JwtGuard` runs
- **THEN** signature verification fails
- **AND** the response is `401 UNAUTHENTICATED`

#### Scenario: iss and aud claims are ignored
- **GIVEN** a valid HS256 JWT with `iss = "anything"` and `aud = "anything"` (or no `iss`/`aud` claims at all)
- **WHEN** `JwtGuard` runs
- **THEN** the guard does NOT check `iss` or `aud`
- **AND** the guard returns true (assuming all other checks pass)
