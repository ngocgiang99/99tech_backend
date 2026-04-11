## Context

problem6's `JwtGuard` currently delegates to `JwksCache`, which fetches RSA public keys from an external `JWKS_URL` (intended to be an OIDC identity provider's `.well-known/jwks.json`). This was the right design **if** problem6 sat behind an external IdP — Auth0, Cognito, Keycloak, or a custom OIDC service. In our actual deployment we have **none of those**: `JWKS_URL=https://id.example.com/.well-known/jwks.json` is a placeholder, every smoke test or integration test that needs a valid JWT has to spin up a fake JWKS HTTP server (`scripts/smoke-bootstrap.mjs`), and the `JwksCache` adapter (~80 LOC) is dead weight.

The user has explicitly decided that **problem6 today is a self-contained auth boundary** AND **there is no production release to honor**. Until a real Kong / API gateway / IdP appears in front of it, the simplest and most defensible posture is: problem6 mints its own JWTs (or accepts JWTs minted by a sibling service in the same trust boundary) and verifies them with a shared HS256 secret.

The change is intentionally a **refactor**, not a feature. No behavioral change to any controller, no new endpoints, no DB migration. Only:
1. The verify primitive in `JwtGuard` swaps from `JwksCache.verify(token)` (RS256) to `jose.jwtVerify(token, secret, { algorithms: ['HS256'] })`
2. The env contract swaps three vars (`JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`) for one (`INTERNAL_JWT_SECRET`)
3. Tests, smoke script, and inventory tables update accordingly

The risk is mostly migration friction: any existing test fixture or helper that constructs an RS256 JWT must be updated. There are no users, no live tokens, and no rotation contract to honor.

## Goals / Non-Goals

**Goals:**
- `JwtGuard` verifies inbound `Authorization: Bearer <jwt>` directly with HS256 against `INTERNAL_JWT_SECRET`. No HTTP fetch, no key cache, no external dependency, no fallback secret.
- `EnvSchema` is updated: three env vars removed, one added, fail-fast on missing required `INTERNAL_JWT_SECRET`.
- All existing tests pass with the new fixture pattern (sign with secret, no JWKS mock).
- The smoke script flow no longer needs a fake JWKS HTTP server. The JWT for smoke checks is signed inline with the secret (one-liner in README or auth doc).
- Net code change is a reduction (~200 LOC removed, ~50 added).
- The change is forward-compatible: if we adopt an external IdP later, we re-introduce a separate `JwksGuard` alongside the current internal `JwtGuard`, route public-facing endpoints through the JWKS guard, and route internal-only endpoints through the HS256 guard. We do NOT have to undo this change.
- The change is also forward-compatible to dual-secret rotation: a future change can add `INTERNAL_JWT_SECRET_PREV` by mirroring `HmacActionTokenVerifier` (~5 LOC of fallback logic + a runbook). We do not pre-build this.

**Non-Goals:**
- Adopting an external IdP. Out of scope.
- Dual-secret rotation (`INTERNAL_JWT_SECRET_PREV`). Explicitly de-scoped — no production users, no rotation cadence. Will be added before any production release.
- Token introspection / revocation lists / refresh tokens. Out of scope.
- Asymmetric internal signing (ES256 with an internal keypair). Overkill.
- Removing the `jose` dependency. Still used for HS256 sign/verify and HMAC action tokens.
- Changing the action-token mechanism. `ACTION_TOKEN_SECRET` and `HmacActionTokenVerifier` are completely independent and untouched by this change. (Note: `ACTION_TOKEN_SECRET_PREV` from step-04 stays in place — the action-token rotation runbook predates the user's "no rotation tooling needed" decision and is already shipped.)
- Changing the JWT claim shape. Inbound JWTs still have `sub` (used as `userId`), `iat`, `exp`. We drop `iss` and `aud` claim **checks** because they were meaningful only when an external IdP issued the token; the claims themselves can still be present in the token, the guard just won't validate them.
- Migrating the existing `.env` automatically. The developer must manually replace `JWKS_URL`/`JWT_ISSUER`/`JWT_AUDIENCE` with `INTERNAL_JWT_SECRET=<32+ random bytes>`. This is documented in `.env.example` and the change archive notes.

## Decisions

### Decision 1: No dual-secret rotation in this change

**What**: `JwtGuard` verifies against exactly one secret (`INTERNAL_JWT_SECRET`). There is no `INTERNAL_JWT_SECRET_PREV`, no fallback logic, no rotation runbook. Rotating the secret in dev means editing `.env` and restarting the server — any in-flight tokens become invalid immediately.

**Why**:
- No production release exists. There are no live users to inconvenience by a flag-day rotation.
- Dropping the dual-secret pattern saves ~25 LOC of verifier logic, ~30 LOC of test scenarios, and the entire `internal-jwt-rotation.md` runbook (~60 LOC of prose). Smaller change, fewer moving parts.
- The forward-compat path is cheap: when production lands, a follow-up change adds `INTERNAL_JWT_SECRET_PREV` by mirroring the existing `HmacActionTokenVerifier.verify()` method (which already implements the dual-secret pattern for action tokens). Total cost ~5 LOC of fallback logic plus a runbook copy-edited from `action-token-rotation.md`. No reason to pre-build it.

**Alternatives considered**:
- **Implement `_PREV` now**. Rejected by the user — YAGNI applies. Pre-building rotation tooling for a non-production system is wasted effort.
- **Single secret but with a TODO comment**. Rejected — TODOs without an owner rot. Better to track this in the change archive notes (this design.md) and let the next person discover it via grep when production becomes a real concern.

### Decision 2: Verification strictness — drop `iss` / `aud` claim checks entirely

**What**: The current `JwtGuard` checks `iss === JWT_ISSUER` and `aud === JWT_AUDIENCE`. The new `JwtGuard` does NOT check these claims at all (the env vars are removed).

**Why**:
- These claims are meaningful only if you have multiple distinct issuers or audiences and need to disambiguate. In a self-contained auth boundary with one signer (problem6 itself or a sibling service sharing the secret), the secret IS the audience binding — knowing the secret is sufficient proof that the token was minted by an authorized issuer.
- Keeping vestigial checks against placeholder values (`https://id.example.com/`) provides no security benefit and adds confusion.
- If we adopt an external IdP later, we re-add a separate guard layer with `iss`/`aud` enforcement. Mixing the two now would be premature.

**Alternatives considered**:
- **Keep `iss`/`aud` checks against new internal-issuer/audience constants**. Rejected — it's bookkeeping with no security value. The HMAC over the payload is the only thing that matters.
- **Make `iss`/`aud` enforcement opt-in via a config flag**. Rejected — feature flags for security checks are an anti-pattern.

### Decision 3: Algorithm allowlist — HS256 only, reject everything else

**What**: `JwtGuard` calls `jose.jwtVerify(token, secret, { algorithms: ['HS256'] })`. Tokens with any other `alg` header (including `none`, `RS256`, `HS384`, `HS512`) are rejected immediately.

**Why**:
- `alg: none` is the classic JWT downgrade attack. `jose` rejects it by default but the explicit allowlist is belt-and-suspenders.
- Hardcoding `HS256` prevents an attacker from supplying an `alg: RS256` token where the public key is the HMAC secret (the historical "RS256 confusion" vulnerability in older JWT libraries). `jose` handles this safely but the allowlist makes the intent explicit.
- A single algorithm matches our single-secret single-issuer posture. If we later want stronger HMAC, we change `'HS256'` → `'HS384'` and increase the secret length requirement; trivial migration.

### Decision 4: Smoke flow becomes a one-liner

**What**: `scripts/smoke-bootstrap.mjs` (which spins up a JWKS HTTP server and generates an RSA keypair) is **deleted**. The `/tmp/smoke-step05.json` flow we built last session is replaced by a tiny inline pattern: `node -e 'import("jose").then(async j => { console.log(await new j.SignJWT({sub:"00000000-0000-0000-0000-000000000005"}).setProtectedHeader({alg:"HS256"}).setExpirationTime("5m").setIssuedAt().sign(new TextEncoder().encode(process.env.INTERNAL_JWT_SECRET))) })'`.

**Why**:
- The whole reason `smoke-bootstrap.mjs` existed was to publish a fake JWKS endpoint for the running app to fetch. With HS256, the app doesn't fetch anything; it just verifies with the secret. Smoke caller signs with the same secret. No HTTP server needed.
- Removing the script removes a moving part and ~50 LOC of test infrastructure.
- The one-liner can live as a code block in README or in a small `scripts/sign-dev-jwt.mjs` helper if developers find the inline form unwieldy. The change leans toward the README snippet to avoid replacing one script with another.

**Alternatives considered**:
- **Keep `smoke-bootstrap.mjs` and have it just sign an HS256 token, no HTTP server**. Rejected — at that point it's a one-liner and the script is overkill.

### Decision 5: README §13.3 env-var inventory updates in the same change

**What**: The `scoreboard-config` spec has a "Schema covers every variable from README §13.3" requirement that explicitly lists `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` by name. This change MUST update both the spec scenario AND the README §13.3 table to reflect the new env-var inventory.

**Why**: Otherwise the spec scenario fails its grep check on the next test run.

## Risks / Trade-offs

- **[Risk]** A developer with a stale local `.env` (still containing `JWKS_URL` but no `INTERNAL_JWT_SECRET`) will get a fail-fast error on app boot. → **Mitigation**: the `.env.example` change is clear, the boot error message names the missing key. Fail-fast is correct behavior.

- **[Risk]** Any external system that was producing RS256-signed JWTs intended for problem6 will silently start failing with 401. → **Mitigation**: we don't have any such system today (the placeholder `id.example.com` has never worked).

- **[Risk]** The `INTERNAL_JWT_SECRET` is now a high-value target — anyone holding it can mint arbitrary user tokens. → **Mitigation**: this is the same risk profile as `ACTION_TOKEN_SECRET`, which already exists. Standard secret-management practices apply: keep it out of version control, use a secret manager in production. Production rotation tooling is deferred per Decision 1.

- **[Risk]** Removing `iss`/`aud` checks means a leaked `INTERNAL_JWT_SECRET` from one environment could be used to mint valid tokens for another environment that shares the secret name but is logically distinct (e.g., staging secret accidentally reused in production). → **Mitigation**: this is a deployment-hygiene problem, not a code problem. When production lands, the deployment runbook MUST emphasize that `INTERNAL_JWT_SECRET` SHALL be unique per environment.

- **[Risk]** The smoke flow we built last session (with `/tmp/smoke-step05.json` + `scripts/smoke-bootstrap.mjs` running in the background) breaks the moment this change lands. → **Mitigation**: this change includes deleting both pieces and replacing them with the new inline pattern. The post-change README/snippet covers any future smoke run.

- **[Risk]** When production lands, retrofitting `INTERNAL_JWT_SECRET_PREV` is non-zero work (~5 LOC + a runbook). If forgotten, the first production rotation will be a flag-day event. → **Mitigation**: add a single TODO breadcrumb in `JwtGuard` (`// TODO: add INTERNAL_JWT_SECRET_PREV before production release — see archived change replace-jwks-with-internal-hs256 design.md Decision 1`). Tracked in tasks.md.

- **[Trade-off]** We give up the ability to verify tokens issued by an external IdP. **Accepted** — we don't have one, and re-adding that capability is straightforward (parallel guard).

- **[Trade-off]** We give up `iss`/`aud` enforcement. **Accepted** — they were vestigial against placeholder values.

- **[Trade-off]** We give up zero-downtime secret rotation. **Accepted** — no users to inconvenience yet. Deferred to a future change before production.

## Migration Plan

This is a developer-facing migration, not a production migration. Steps:

1. Land this change. Tests pass against the new `INTERNAL_JWT_SECRET` env var.
2. Each developer updates their local `.env`:
   - Remove `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`
   - Add `INTERNAL_JWT_SECRET=<openssl rand -hex 32>`
3. Restart the local dev server. Boot succeeds.
4. The smoke flow from last session (`smoke-step05.json`) stops working because the JWKS server is gone. Use the new one-liner JWT-sign pattern (documented in README or as a code-block in the change archive notes) for any future smoke checks.
5. There is no rollback plan beyond `git revert` — the change has no persistent state effects (no DB migration, no Redis state).

## Open Questions

- **Q1**: Do we need to add `INTERNAL_JWT_SECRET` to the Pino redaction config? **Default**: yes — append it to `pino-logger.factory.ts` redact list alongside `ACTION_TOKEN_SECRET` so it can never accidentally appear in logs. This is a one-line change but easy to miss; included in tasks.md.
- **Q2**: Does any integration test currently rely on the `iss` or `aud` mismatch scenarios for `JwtGuard`? Need to grep — if yes, those tests must be deleted (no longer relevant) or rewritten as "expired token" / "tampered signature" tests. Included in tasks.md.
- **Q3**: Should the smoke one-liner be inlined in README or live as a tiny `scripts/sign-dev-jwt.mjs` helper? **Default**: README snippet only (avoid replacing one script with another). Developer can copy it into a personal alias if they use it often.
