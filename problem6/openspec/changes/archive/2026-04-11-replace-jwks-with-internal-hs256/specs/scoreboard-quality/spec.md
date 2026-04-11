## REMOVED Requirements

### Requirement: JwksCache unit test exists

**Reason**: `JwksCache` itself is removed in this change (see `scoreboard-auth` delta). The unit test `test/unit/auth/jwks-cache.test.ts` is therefore deleted and is no longer part of the unit-test inventory. Coverage thresholds remain unchanged because the file being removed is also removed from `collectCoverageFrom` (no orphaned uncovered code).

**Migration**: Delete `test/unit/auth/jwks-cache.test.ts`. No replacement needed — the new HS256 verification logic is exercised by `test/unit/auth/jwt.guard.test.ts`, which is rewritten in the same change to sign tokens directly with `INTERNAL_JWT_SECRET` instead of mocking the JWKS cache.

## ADDED Requirements

### Requirement: JwtGuard unit tests cover HS256 verification

The unit test suite SHALL include `test/unit/auth/jwt.guard.test.ts` covering: valid HS256 token sets userId, expired token rejected, missing Authorization header rejected, alg=none rejected, alg=RS256 rejected (algorithm allowlist), tampered signature rejected, wrong-secret rejected, iss/aud claims ignored. Tests sign tokens directly with `jose.SignJWT(...).sign(new TextEncoder().encode(secret))` — no JWKS HTTP server, no RSA keypair generation.

#### Scenario: Test file exists with the documented coverage
- **WHEN** `test/unit/auth/jwt.guard.test.ts` is read
- **THEN** the file contains test cases for each of the 8 scenarios listed above
- **AND** every test signs its JWT inline with `jose.SignJWT` and an HS256 secret
- **AND** no test imports or references `JwksCache` (which has been deleted)

#### Scenario: Tests run as part of the unit test suite
- **WHEN** `mise run test` is run
- **THEN** `jwt.guard.test.ts` is executed
- **AND** all 8 test cases pass
- **AND** the file's line coverage is 100%
