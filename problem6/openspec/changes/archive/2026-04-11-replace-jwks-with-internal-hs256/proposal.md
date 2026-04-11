## Why

problem6 currently verifies inbound JWTs by fetching public keys from a JWKS endpoint (`JWKS_URL`), which assumes an external identity provider (Auth0/Cognito/Keycloak) sits in front of the API. In our actual deployment topology there is **no Kong / API gateway / external IdP** in front of problem6, and we have no production release. The placeholder `https://id.example.com/.well-known/jwks.json` in `.env` is unreachable, so every smoke test or curl call requires booting a fake JWKS server. The JWKS layer adds runtime cost (HTTP fetch + cache + clock-skew handling), test infrastructure overhead (`scripts/smoke-bootstrap.mjs` exists solely to publish a fake JWK set), and a 100+ LOC `JwksCache` adapter that we don't actually need until we adopt an external IdP. Replacing it with a direct HS256 shared secret is materially simpler, eliminates the fake-JWKS scaffolding, and matches our real trust boundary today: problem6 mints and verifies its own auth tokens.

## What Changes

- **BREAKING (config)**: Remove `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` from `EnvSchema`. Add `INTERNAL_JWT_SECRET: z.string().min(32)` (required). Update `.env.example` and `.env`.
- **BREAKING (auth)**: `JwtGuard` no longer verifies via `JwksCache` / RS256 / external public keys. It verifies the inbound `Authorization: Bearer <jwt>` directly with HS256 against `INTERNAL_JWT_SECRET`. The guard still enforces `exp > now`, still rejects `alg: none` (and any non-HS256 algorithm), still sets `request.userId = payload.sub`. The `iss` and `aud` claim checks are removed (they were meaningful only when an external IdP was the issuer).
- **REMOVED**: `src/scoreboard/infrastructure/auth/jwks-cache.ts`, `test/unit/auth/jwks-cache.test.ts`, all `jose.createRemoteJWKSet` usage, all `JwksCache` DI registrations in `ScoreboardModule`.
- **REMOVED**: `scripts/smoke-bootstrap.mjs` (no fake JWKS HTTP server needed; the smoke flow just signs an HS256 JWT with the `INTERNAL_JWT_SECRET` directly via a one-liner).
- **NO ROTATION TOOLING**: We are deliberately NOT implementing dual-secret rotation (`INTERNAL_JWT_SECRET_PREV`) for this change. The user has explicitly de-scoped it: there is no production release, no live users, no rotation cadence to honor. If/when problem6 ships, a follow-up change can add rotation by mirroring the existing `ACTION_TOKEN_SECRET_PREV` pattern from step-04 GAP-05 — that takes ~5 LOC of fallback logic plus a runbook. For now, "rotation" means "edit `.env`, restart, accept that any in-flight tokens are invalidated" — perfectly acceptable in dev.
- **MODIFIED**: `JwtGuard` unit tests are rewritten to sign tokens with the secret instead of mocking `JwksCache`. `test/unit/auth/jwt.guard.test.ts` becomes simpler (no remote-JWKS mock, no dual-secret fallback paths).
- **MODIFIED**: `dependencies` — `jose` is still used for `jwtVerify` + `SignJWT` so the package stays. Nothing to remove from `package.json`.
- **DOCUMENTED**: A short note in `README.md` (or wherever the auth contract is documented) explaining that problem6 today is a self-contained auth boundary (mints + verifies its own JWTs), and that adopting an external IdP later is a forward-compatible change (re-introduce `JwksCache` as a separate guard, don't touch the HS256 path).

## Capabilities

### New Capabilities

(none — this is a refactor of existing capabilities)

### Modified Capabilities

- `scoreboard-auth`: The "JWKS cache fetches and stores public keys for 1 hour" requirement is REMOVED entirely. The "JwtGuard enforces all required JWT claims" requirement is MODIFIED — it no longer mentions JWKS, RS256, `iss`, or `aud`; it now specifies HS256 verification against `INTERNAL_JWT_SECRET`.
- `scoreboard-config`: Three env-var requirements are REMOVED (`JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`). One requirement is ADDED: "INTERNAL_JWT_SECRET required (≥32 chars)". The "Schema covers every variable from README §13.3" requirement is MODIFIED to reflect the new env-var inventory.
- `scoreboard-quality`: The mention of `jwks-cache.test.ts` (if any) in the testing requirements is REMOVED. The Testcontainers integration suite is unchanged.

## Impact

**Removed code (~250 LOC):**
- `src/scoreboard/infrastructure/auth/jwks-cache.ts` (~80 LOC)
- `test/unit/auth/jwks-cache.test.ts` (~80 LOC)
- `scripts/smoke-bootstrap.mjs` (~50 LOC)
- JWKS-related env loading in `src/config/schema.ts` (~10 LOC)
- DI registration for `JwksCache` in `ScoreboardModule` (~5 LOC)
- JWKS sections of `JwtGuard` and its tests (~25 LOC)

**Added code (~50 LOC):**
- HS256 verify in `JwtGuard` (~10 LOC; just `jose.jwtVerify(token, secret, { algorithms: ['HS256'] })` plus the existing claim handling)
- New env var in `src/config/schema.ts` (~3 LOC)
- New `JwtGuard` unit tests covering primary verify, alg=none rejection, alg=RS256 rejection, expired token, tampered signature, missing header (~35 LOC)

**Net reduction: ~200 LOC** plus the elimination of one moving part (HTTP fetch + cache).

**Modified files:**
- `src/scoreboard/infrastructure/auth/jwt.guard.ts` — rewrite verify path
- `src/scoreboard/scoreboard.module.ts` — remove `JwksCache` provider
- `src/config/schema.ts` — env var swap
- `.env`, `.env.example` — env var swap (developer impact: must set `INTERNAL_JWT_SECRET` locally)
- `test/unit/auth/jwt.guard.test.ts` — rewrite to sign with secret
- `test/integration/**/*.test.ts` — any test that constructs a fake JWT for the guard now uses HS256 instead of RS256 (find via grep)
- `scripts/smoke-bootstrap.mjs` (delete) and any leftover `/tmp/smoke-step05.json` flow — replaced with a one-liner documented in the README or the auth runbook
- `README.md` §13.3 — env-var inventory table updated

**Out of scope** (deferred to future changes if needed):
- Adopting an external IdP (JWKS would come back as a SECOND guard layer alongside the internal HS256 guard, not as a replacement).
- Token introspection / revocation list.
- Dual-secret rotation (`INTERNAL_JWT_SECRET_PREV`). Will be added in a follow-up before any production release; the pattern is already proven by `HmacActionTokenVerifier` so it's a ~5-LOC change when needed.
- Asymmetric internal signing (ES256 with an internal keypair) — overkill until there's a real reason.
- Removing the `jose` dependency — we still use it for HS256 sign + verify, and for HMAC action tokens.
