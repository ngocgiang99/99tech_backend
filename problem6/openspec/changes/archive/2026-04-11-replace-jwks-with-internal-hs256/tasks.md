## 1. Config schema update

- [x] 1.1 Edit `src/config/schema.ts`: remove `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` fields from `EnvSchema`
- [x] 1.2 Add `INTERNAL_JWT_SECRET: z.string().min(32)` to `EnvSchema` in the Auth section (alongside `ACTION_TOKEN_SECRET`)
- [x] 1.3 Edit `.env.example`: remove the three JWKS-related entries, add `INTERNAL_JWT_SECRET=<openssl rand -hex 32>` with a comment explaining how to generate it
- [x] 1.4 Edit `.env`: remove the three JWKS-related entries, add a real `INTERNAL_JWT_SECRET` value (use `openssl rand -hex 32` — don't commit a placeholder)
- [x] 1.5 Update `test/unit/config/config.service.test.ts` `makeConfig()` helper: remove the three old keys, add `INTERNAL_JWT_SECRET: 'a'.repeat(32)` (or similar 32+ char fixture)
- [x] 1.6 Update `README.md` §13.3 env-var inventory table: remove the three rows, add the new `INTERNAL_JWT_SECRET` row with description "32+ random bytes used to HS256-sign and verify internal JWTs"
- [x] 1.7 Run `mise run typecheck` — must exit 0 (the type of `Config` from zod inference will have changed; may surface a few callsite errors that are fixed in section 2)

## 2. JwtGuard rewrite (HS256 verify)

- [x] 2.1 Edit `src/scoreboard/infrastructure/auth/jwt.guard.ts`: remove the `JwksCache` injection, remove the `jwksCache.verify()` call
- [x] 2.2 Inject `ConfigService` into `JwtGuard` (if not already injected) and read `config.get('INTERNAL_JWT_SECRET')` once in the constructor; store as `private readonly secret: Uint8Array = new TextEncoder().encode(config.get('INTERNAL_JWT_SECRET'))`
- [x] 2.3 In `canActivate`, after extracting the bearer token, call `await jose.jwtVerify(token, this.secret, { algorithms: ['HS256'] })` and pull `payload.sub` for `request.userId`. Wrap in try/catch — any thrown JOSE error → throw `UnauthorizedException` (or whatever the existing 401 code path is)
- [x] 2.4 Remove all references to `iss` and `aud` from the guard (no `issuer` or `audience` options passed to `jwtVerify`)
- [x] 2.5 Add a TODO breadcrumb comment: `// TODO: add INTERNAL_JWT_SECRET_PREV before production release — see archived change replace-jwks-with-internal-hs256 design.md Decision 1` (per Decision 1 risk mitigation)
- [x] 2.6 Verify the guard still wraps verification in the existing OTel `jwt.verify` span (added in step-04). The span name and attributes do not change.

## 3. Delete JwksCache and its registration

- [x] 3.1 Delete `src/scoreboard/infrastructure/auth/jwks-cache.ts`
- [x] 3.2 Delete `test/unit/auth/jwks-cache.test.ts`
- [x] 3.3 Edit `src/scoreboard/scoreboard.module.ts`: remove `JwksCache` from the providers array, remove the import. Verify `JwtGuard`'s constructor signature is satisfied without it.
- [x] 3.4 Grep for any other references to `JwksCache` across `src/`, `test/`, and `scripts/`. Remove every match. Common spots: barrel re-exports, module index files, mock helpers.
- [x] 3.5 Run `mise run typecheck` — must exit 0

## 4. JwtGuard unit tests rewrite

- [x] 4.1 Read the existing `test/unit/auth/jwt.guard.test.ts` to understand the current setup pattern (mock `JwksCache`, inject into guard, etc.)
- [x] 4.2 Replace the test helper that builds a guard instance: instead of injecting a mock `JwksCache`, build a `ConfigService` mock that returns a 32-char `INTERNAL_JWT_SECRET` and inject it into the guard
- [x] 4.3 Replace any "build a fake RS256 JWT" helper with "build an HS256 JWT signed with the same secret the guard uses" (`new jose.SignJWT({sub: userId}).setProtectedHeader({alg:'HS256'}).setExpirationTime('5m').setIssuedAt().sign(secretBytes)`)
- [x] 4.4 Test: valid HS256 token → guard returns true, sets `request.userId === payload.sub`
- [x] 4.5 Test: missing `Authorization` header → 401
- [x] 4.6 Test: bearer token signed with wrong secret → 401
- [x] 4.7 Test: token with `exp` in the past → 401
- [x] 4.8 Test: token with `alg: 'none'` → 401 (sign manually or hand-craft the token, since `jose.SignJWT` won't produce `alg:none`)
- [x] 4.9 Test: token with `alg: 'RS256'` (signed with an RSA key) → 401 (algorithm allowlist rejects it). Use `jose.generateKeyPair('RS256')` + `SignJWT` to produce the test token
- [x] 4.10 Test: tampered signature → 401 (sign a token, then mutate the last char of the signature segment)
- [x] 4.11 Test: token with `iss = 'random'` and `aud = 'random'` → still passes (claims are ignored)
- [x] 4.12 Run `npx jest test/unit/auth/jwt.guard.test.ts` — all 8+ tests pass
- [x] 4.13 Verify file coverage is 100% via `npx jest --coverage --collectCoverageFrom='src/scoreboard/infrastructure/auth/jwt.guard.ts' test/unit/auth/jwt.guard.test.ts`

## 5. Pino redaction config update

- [x] 5.1 Edit `src/shared/logger/pino-logger.factory.ts`: append `'*.INTERNAL_JWT_SECRET'` to the `redact.paths` array, alongside the existing `'*.ACTION_TOKEN_SECRET'` entry
- [x] 5.2 Add a unit test in `test/unit/shared/pino-logger.factory.test.ts` (or wherever the existing redaction tests live): when an object containing `INTERNAL_JWT_SECRET` is logged, the value is replaced with `[REDACTED]` (or omitted)

## 6. Integration test fixture migration

- [x] 6.1 Grep `test/integration/` for any reference to `JwksCache`, `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `RS256`, or `jose.generateKeyPair('RS256')`. Replace each with the HS256 sign pattern using the test fixture's `INTERNAL_JWT_SECRET`.
- [x] 6.2 If any integration test currently constructs a fake JWT for the guard, update it to sign with HS256 and the test fixture secret.
- [x] 6.3 Specifically check `test/integration/leaderboard/leaderboard-controller.test.ts` (the JWT-gated endpoint test) — its JWT fixture must move to HS256.
- [x] 6.4 Run `mise run test:integration` — all tests must pass

## 7. Smoke flow cleanup

- [x] 7.1 Delete `problem6/scripts/smoke-bootstrap.mjs` (the fake JWKS HTTP server helper)
- [x] 7.2 Delete `/tmp/smoke-step05.json` if it still exists from the previous session, AND kill any background process still running it (`pkill -f 'dist/src/main.js'; pkill -f smoke-bootstrap.mjs`)
- [x] 7.3 Update `problem6/scripts/smoke-step04.ts` (or wherever the old smoke script lives): replace its JWKS server + RSA keypair + RS256 sign block with a single HS256 sign call against `INTERNAL_JWT_SECRET`. Test: `pnpm tsx scripts/smoke-step04.ts` still passes.
- [x] 7.4 Add a code-block snippet to `problem6/README.md` (in a section like "Local development → signing a dev JWT") showing the one-liner: `node -e 'import("jose").then(async j => { console.log(await new j.SignJWT({sub:"00000000-0000-0000-0000-000000000005"}).setProtectedHeader({alg:"HS256"}).setExpirationTime("5m").setIssuedAt().sign(new TextEncoder().encode(process.env.INTERNAL_JWT_SECRET))) })'`

## 8. Module + DI cleanup

- [x] 8.1 Re-read `src/scoreboard/scoreboard.module.ts` after section 3 to confirm `JwksCache` is fully gone, no orphan imports
- [x] 8.2 Verify `JwtGuard` can be instantiated by the DI container by booting the app: `mise run build && node dist/src/main.js` should reach "Application is running" without DI errors. Kill it after.

## 9. Full gate stack

- [x] 9.1 `mise run typecheck` exits 0
- [x] 9.2 `mise run lint` exits 0 (boundaries plugin still happy)
- [x] 9.3 `mise run build` exits 0
- [x] 9.4 `mise run test` exits 0 (all unit tests pass — including the rewritten `jwt.guard.test.ts`, the redaction test, and any controller tests touching JWT)
- [x] 9.5 `mise run test:coverage` exits 0 with the existing thresholds (global ≥80%, domain 100%). Coverage may shift slightly because `jwks-cache.ts` is gone — verify `collectCoverageFrom` doesn't reference the deleted file
- [x] 9.6 `mise run test:integration` exits 0 (Testcontainers Postgres + Redis, all leaderboard + persistence tests, all auth tests)
- [x] 9.7 `openspec validate replace-jwks-with-internal-hs256` exits 0

## 10. Manual smoke verification

- [x] 10.1 Boot the app: `mise run build && PORT=13003 INTERNAL_JWT_SECRET=$(openssl rand -hex 32) node dist/src/main.js` (in background or another terminal)
- [x] 10.2 Sign a dev JWT using the README one-liner with the same `INTERNAL_JWT_SECRET`
- [x] 10.3 `curl -H "Authorization: Bearer <jwt>" http://localhost:13003/v1/leaderboard/top?limit=5` → 200 with the leaderboard response
- [x] 10.4 `curl http://localhost:13003/v1/leaderboard/top?limit=5` (no JWT) → 401
- [x] 10.5 `curl -H "Authorization: Bearer wrong-token" http://localhost:13003/v1/leaderboard/top?limit=5` → 401
- [x] 10.6 Kill the app

## 11. Finalize

- [x] 11.1 Run `openspec validate replace-jwks-with-internal-hs256` once more
- [x] 11.2 Mark all tasks complete in this file
- [x] 11.3 Confirm the design.md TODO breadcrumb is in place (`// TODO: add INTERNAL_JWT_SECRET_PREV before production release`) — this is the documented forward-compat path
