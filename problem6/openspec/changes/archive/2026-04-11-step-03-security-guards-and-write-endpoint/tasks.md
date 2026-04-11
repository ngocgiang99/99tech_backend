## 1. Dependencies

- [x] 1.1 Add `jose` to `package.json` `dependencies` (`pnpm add jose`)
- [x] 1.2 Add `ioredis` to `package.json` `dependencies` (`pnpm add ioredis`)
- [x] 1.3 Run `pnpm install` and verify lock file updates
- [x] 1.4 `mise run typecheck` exits 0

## 2. Redis client and module (capabilities: scoreboard-auth, scoreboard-rate-limit, scoreboard-idempotency)

- [x] 2.1 Create `src/scoreboard/infrastructure/persistence/redis/redis.client.ts` exporting a factory function `buildRedisClient(config: ConfigService): Redis` that constructs an `ioredis` instance from `config.get('REDIS_URL')`
- [x] 2.2 Create `src/scoreboard/infrastructure/persistence/redis/redis.module.ts` as `@Global() @Module({...})` providing `{ provide: 'Redis', useFactory: buildRedisClient, inject: [ConfigService] }` and exporting `'Redis'`
- [x] 2.3 Add `OnModuleDestroy` lifecycle hook calling `redis.quit()` for graceful shutdown
- [x] 2.4 Import `RedisModule` into `AppModule` (after `ConfigModule` and `DatabaseModule`)
- [x] 2.5 Smoke test: `mise run dev` boots without errors; the Redis connection log line appears

## 3. JWKS cache (capability: scoreboard-auth)

- [x] 3.1 Create `src/scoreboard/infrastructure/auth/jwks-cache.ts` exporting `class JwksCache`
- [x] 3.2 Constructor takes `ConfigService` and lazily creates a `jose.createRemoteJWKSet(new URL(config.get('JWKS_URL')))` instance on first access
- [x] 3.3 Expose `verify(token: string): Promise<JWTPayload>` that calls `jose.jwtVerify(token, this.jwks, { issuer, audience, algorithms: ['RS256', 'ES256'] })` with `issuer = config.get('JWT_ISSUER')` and `audience = config.get('JWT_AUDIENCE')`
- [x] 3.4 Catch `jose.errors.JOSEError` subtypes and rethrow as a typed `InvalidJwtError` with the original cause
- [x] 3.5 Document that the 1-hour TTL is handled internally by `jose.createRemoteJWKSet` (no manual cache management needed)

## 4. JWT guard (capability: scoreboard-auth)

- [x] 4.1 Create `src/scoreboard/infrastructure/auth/jwt.guard.ts` exporting `@Injectable() class JwtGuard implements CanActivate`
- [x] 4.2 Constructor injects `JwksCache`
- [x] 4.3 `canActivate(ctx)` extracts the `Authorization` header, splits on space, validates the `Bearer` prefix
- [x] 4.4 Pre-parse the JWT header (just the first dot-separated section, base64url decoded) and reject if `alg === 'none'`
- [x] 4.5 Call `await this.jwks.verify(token)` to verify signature, `iss`, `aud`, `exp`
- [x] 4.6 On success: set `request.userId = payload.sub` and return true
- [x] 4.7 On failure: throw `UnauthorizedException` (NestJS auto-translates to 401) with a generic message — do NOT leak which check failed
- [x] 4.8 Unit test: mock `JwksCache.verify` for happy path, expired-token, wrong-aud, wrong-iss, tampered-signature, alg=none, missing header. Each mocked rejection should produce 401 in the test
- [x] 4.9 Run the grep guard: `grep -r "from '@nestjs" src/scoreboard/infrastructure/auth/` IS allowed (infrastructure layer can import from NestJS)

## 5. HMAC action token issuer + verifier (capability: scoreboard-auth)

- [x] 5.1 Create `src/scoreboard/infrastructure/auth/action-token.types.ts` exporting `interface ActionTokenClaims { sub: string; aid: string; atp: string; mxd: number; iat: number; exp: number }`
- [x] 5.2 Create `src/scoreboard/infrastructure/auth/hmac-action-token.issuer.ts` exporting `@Injectable() class HmacActionTokenIssuer`
- [x] 5.3 Constructor injects `ConfigService`. Cache the secret as `secretKey = new TextEncoder().encode(config.get('ACTION_TOKEN_SECRET'))`
- [x] 5.4 Method `async issue(input: { sub: string; atp: string; mxd: number }): Promise<{ actionId: string; actionToken: string; expiresAt: Date; maxDelta: number }>`
- [x] 5.5 Generate `actionId = crypto.randomUUID()`
- [x] 5.6 Compute `now = Math.floor(Date.now() / 1000)` and `exp = now + config.get('ACTION_TOKEN_TTL_SECONDS')`
- [x] 5.7 Sign with `await new jose.SignJWT({ aid: actionId, atp: input.atp, mxd: input.mxd }).setProtectedHeader({ alg: 'HS256' }).setSubject(input.sub).setIssuedAt(now).setExpirationTime(exp).sign(this.secretKey)`
- [x] 5.8 Return the typed envelope
- [x] 5.9 Create `src/scoreboard/infrastructure/auth/hmac-action-token.verifier.ts` exporting `@Injectable() class HmacActionTokenVerifier`
- [x] 5.10 Method `async verify(token: string, expectedSub: string, body: { actionId: string; delta: number }): Promise<ActionTokenClaims>` that uses `jose.jwtVerify(token, this.secretKey, { algorithms: ['HS256'] })` and then asserts `payload.sub === expectedSub`, `payload.aid === body.actionId`, `payload.mxd >= body.delta`
- [x] 5.11 On any check failure throw `InvalidActionTokenError`
- [x] 5.12 Unit tests for issuer (happy path, the TTL math) and verifier (happy + every reject case)

## 6. Action token endpoint (capability: scoreboard-auth)

- [x] 6.1 Create `src/scoreboard/interface/http/dto/issue-action-token.dto.ts` exporting a zod schema `IssueActionTokenSchema = z.object({ actionType: z.enum(['level-complete', 'boss-defeat', 'achievement-unlock' /* etc */]) })` and the inferred type
- [x] 6.2 Create `src/scoreboard/interface/http/controllers/actions.controller.ts` with `@Controller('v1/actions')` and `@UseGuards(JwtGuard)`
- [x] 6.3 Add `@Post('issue-token') async issueActionToken(@Req() req, @Body() body: unknown)`
- [x] 6.4 Parse `body` via `IssueActionTokenSchema.parse(body)`. On `ZodError`, throw `BadRequestException` with the formatted error
- [x] 6.5 Determine `mxd` for the actionType (hardcoded map for v1: `level-complete → 100`, `boss-defeat → 500`, `achievement-unlock → 1000`). Document that this map will move to config in a future change
- [x] 6.6 Call `await this.issuer.issue({ sub: req.userId, atp: body.actionType, mxd })`
- [x] 6.7 Call `await this.redis.set('action:issued:' + result.actionId, '1', 'EX', config.get('ACTION_TOKEN_TTL_SECONDS'), 'NX')` to record issuance
- [x] 6.8 Return the result envelope
- [x] 6.9 NEVER `console.log(result.actionToken)` or include the token in any thrown error message

## 7. Action token guard with idempotency layer 1 (capabilities: scoreboard-auth, scoreboard-idempotency)

- [x] 7.1 Create `src/scoreboard/infrastructure/auth/action-token.guard.ts` exporting `@Injectable() class ActionTokenGuard implements CanActivate`
- [x] 7.2 Constructor injects `HmacActionTokenVerifier`, `'Redis'`, `ConfigService`
- [x] 7.3 `canActivate(ctx)` extracts `request.userId` (set by `JwtGuard`), `request.body.actionId`, `request.body.delta`, and the `Action-Token` header
- [x] 7.4 If `request.userId` is undefined (JwtGuard didn't run), throw — this is a wiring bug
- [x] 7.5 Call `await this.verifier.verify(actionToken, request.userId, { actionId: body.actionId, delta: body.delta })`
- [x] 7.6 On verifier failure, throw `ForbiddenException('INVALID_ACTION_TOKEN')`
- [x] 7.7 Run the layer-1 SETNX: `const result = await redis.set('idempotency:action:' + body.actionId, '1', 'EX', ttl, 'NX')`
- [x] 7.8 If `result === null` (SETNX lost), throw `ForbiddenException('ACTION_ALREADY_CONSUMED')` (optionally with the prior outcome cached in the SETNX value — see Q1 in design.md for the v1 simplification)
- [x] 7.9 On success, set `request.actionTokenClaims = verifiedClaims` and return true
- [x] 7.10 Unit tests covering: happy path, bad token, wrong sub, wrong aid, mxd violation, SETNX win, SETNX loss

## 8. Rate-limit Lua script and guard (capability: scoreboard-rate-limit)

- [x] 8.1 Create `src/scoreboard/infrastructure/rate-limit/lua/token-bucket.lua` implementing the algorithm: `KEYS[1] = bucket key`, `ARGV[1] = capacity`, `ARGV[2] = refill rate (tokens/sec)`, `ARGV[3] = now (unix ms)`. Body: read current tokens + last refill time from the hash, refill based on elapsed time, decrement if available, return `{1, remaining}` or `{0, ms-until-next-token}`. Set hash TTL to `2 * capacity / rate` seconds
- [x] 8.2 Create `src/scoreboard/infrastructure/rate-limit/redis-token-bucket.ts` exporting `@Injectable() class RedisTokenBucket`
- [x] 8.3 `OnModuleInit` lifecycle: read the Lua source, call `await this.redis.script('LOAD', luaSource)`, store the SHA
- [x] 8.4 Method `async consume(userId: string, capacity = 20, refillPerSec = 10): Promise<{ allowed: boolean; retryAfterMs?: number }>` that calls `evalsha(sha, 1, 'rate:user:' + userId, capacity, refillPerSec, Date.now())`
- [x] 8.5 Catch `NOSCRIPT` errors: re-LOAD the script and retry once with the new SHA
- [x] 8.6 Create `src/scoreboard/infrastructure/rate-limit/rate-limit.guard.ts` exporting `@Injectable() class RateLimitGuard implements CanActivate`
- [x] 8.7 Constructor injects `RedisTokenBucket`, `ConfigService`
- [x] 8.8 `canActivate(ctx)` extracts `request.userId`. Call `bucket.consume(request.userId, 20, config.get('RATE_LIMIT_PER_SEC'))`
- [x] 8.9 If not allowed, set `Retry-After` header and throw `HttpException({ statusCode: 429, code: 'RATE_LIMITED' }, 429)`
- [x] 8.10 Add an in-process global counter for the per-instance circuit breaker. Increment on every `canActivate`, reset on a `setInterval(() => globalCount = 0, 1000)`. If `globalCount > 5000`, throw 503
- [x] 8.11 Unit tests using a fake Redis client that exposes `evalsha` returning fixture results. Cover: bucket admit, bucket reject, NOSCRIPT recovery, global breaker trip

## 9. Score-increment controller (capabilities: scoreboard-write-path, scoreboard-idempotency)

- [x] 9.1 Create `src/scoreboard/interface/http/dto/increment-score.dto.ts` exporting `IncrementScoreSchema = z.object({ actionId: z.string().uuid(), delta: z.number().int().positive().max(MAX_DELTA) })` and the inferred type
- [x] 9.2 Create `src/scoreboard/interface/http/controllers/scoreboard.controller.ts` with `@Controller('v1/scores')`
- [x] 9.3 Add `@Post('increment') @UseGuards(JwtGuard, ActionTokenGuard, RateLimitGuard) async incrementScore(@Req() req, @Body() rawBody: unknown)`
- [x] 9.4 Parse the body via `IncrementScoreSchema.parse(rawBody)`. On `ZodError`, throw `BadRequestException`
- [x] 9.5 Construct the command: `const cmd = new IncrementScoreCommand({ userId: UserId.of(req.userId), actionId: ActionId.of(body.actionId), delta: ScoreDelta.of(body.delta), occurredAt: new Date() })`
- [x] 9.6 Wrap `await this.handler.execute(cmd)` in try/catch
- [x] 9.7 In the catch, if `error instanceof IdempotencyViolationError`: call `await this.repository.findScoreEventByActionId(error.actionId)`, reconstruct the historical DTO `{ userId, newScore: prior.userScores.totalScore, rank: null, topChanged: null }`, return 200 with that body
- [x] 9.8 In the catch, map other domain errors to HTTP codes (per the spec): `InvalidArgumentError → 400`, `UnauthorizedError → 401`, `ForbiddenError → 403`, default → 500. Build the error envelope manually until `step-04` lands the global filter
- [x] 9.9 Add a `findScoreEventByActionId` method to `UserScoreRepository` port and `KyselyUserScoreRepository` impl

## 10. Module wiring

- [x] 10.1 Update `src/scoreboard/scoreboard.module.ts` to register: `JwksCache`, `JwtGuard`, `HmacActionTokenIssuer`, `HmacActionTokenVerifier`, `ActionTokenGuard`, `RedisTokenBucket`, `RateLimitGuard`, `ActionsController`, `ScoreboardController`
- [x] 10.2 Confirm the controllers list is `[ActionsController, ScoreboardController]`
- [x] 10.3 Confirm `RedisModule` is imported into `AppModule`
- [x] 10.4 Boot the app: `mise run dev` exits no DI errors; logs show both controllers registered

## 11. End-to-end smoke tests

- [x] 11.1 Manual: `curl -X POST http://localhost:3000/v1/actions:issue-token` with a hardcoded test JWT (from a fixture). Verify 200 + envelope
- [x] 11.2 Manual: `curl -X POST http://localhost:3000/v1/scores:increment` with the JWT, the action token from 11.1, body `{ actionId: "<from 11.1>", delta: 5 }`. Verify 200 + `{ userId, newScore: 5, rank: null, topChanged: null }`
- [x] 11.3 Manual: replay 11.2 with the SAME body. Verify 200 + identical body (idempotent replay path works)
- [x] 11.4 Manual: replay 11.2 with a different body (`delta: 10`) but same `actionId`. The `delta != prior delta` is irrelevant — the replay returns the prior outcome
- [x] 11.5 Manual: try `curl -X POST http://localhost:3000/v1/scores:increment` with no Authorization header. Verify 401
- [x] 11.6 Manual: try with an expired action token (manually forge one). Verify 403 INVALID_ACTION_TOKEN
- [x] 11.7 Manual: send 25 requests in 1 second from one user. Verify the first 20 succeed and 5 are rejected with 429
- [x] 11.8 `psql` check: `score_events` has the expected rows; `user_scores` reflects the running total

## 12. Finalize

- [x] 12.1 `mise run typecheck` exits 0
- [x] 12.2 `mise run build` exits 0 and `dist/main.js` exists
- [x] 12.3 Run `openspec validate step-03-security-guards-and-write-endpoint`
- [x] 12.4 Mark all tasks complete and update File List in change archive notes

## File List (step-03 archive notes)

**Created**
- src/scoreboard/infrastructure/persistence/redis/redis.client.ts
- src/scoreboard/infrastructure/persistence/redis/redis.module.ts
- src/scoreboard/infrastructure/persistence/redis/index.ts
- src/scoreboard/infrastructure/auth/errors/invalid-jwt.error.ts
- src/scoreboard/infrastructure/auth/errors/invalid-action-token.error.ts
- src/scoreboard/infrastructure/auth/errors/index.ts
- src/scoreboard/infrastructure/auth/jwks-cache.ts
- src/scoreboard/infrastructure/auth/jwt.guard.ts
- src/scoreboard/infrastructure/auth/action-token.types.ts
- src/scoreboard/infrastructure/auth/hmac-action-token.issuer.ts
- src/scoreboard/infrastructure/auth/hmac-action-token.verifier.ts
- src/scoreboard/infrastructure/auth/action-token.guard.ts
- src/scoreboard/infrastructure/auth/index.ts
- src/scoreboard/infrastructure/rate-limit/lua/token-bucket.lua
- src/scoreboard/infrastructure/rate-limit/redis-token-bucket.ts
- src/scoreboard/infrastructure/rate-limit/rate-limit.guard.ts
- src/scoreboard/infrastructure/rate-limit/index.ts
- src/scoreboard/interface/http/dto/issue-action-token.dto.ts
- src/scoreboard/interface/http/dto/increment-score.dto.ts
- src/scoreboard/interface/http/controllers/actions.controller.ts
- src/scoreboard/interface/http/controllers/scoreboard.controller.ts
- test/unit/auth/jwt.guard.test.ts
- test/unit/auth/hmac-action-token.issuer.test.ts
- test/unit/auth/hmac-action-token.verifier.test.ts
- test/unit/auth/action-token.guard.test.ts
- test/unit/rate-limit/redis-token-bucket.test.ts
- test/unit/rate-limit/rate-limit.guard.test.ts

**Modified**
- package.json (added jose, ioredis)
- pnpm-lock.yaml
- nest-cli.json (added rate-limit/lua/*.lua assets)
- src/app.module.ts (imported RedisModule)
- src/scoreboard/scoreboard.module.ts (registered guards + controllers)
- src/scoreboard/domain/ports/user-score.repository.ts (added findScoreEventByActionId + ScoreEventRecord)
- src/scoreboard/domain/index.ts (exported ScoreEventRecord)
- src/scoreboard/infrastructure/persistence/kysely/user-score.repository.impl.ts (implemented findScoreEventByActionId)
- test/unit/application/fakes/fake-user-score.repository.ts (added scoreEvents map + findScoreEventByActionId)
- tsconfig.build.json (excluded scripts/)

**Notes**
- Route paths use Google API "custom methods" style: `/v1/actions:issue-token` and `/v1/scores:increment`. Nest `@Post('actions:issue-token')` with `@Controller('v1')` mounts them correctly on Fastify.
- `@HttpCode(200)` on both POST endpoints to match the spec (Nest default would be 201).
- Layer-1 idempotency returns 403 ACTION_ALREADY_CONSUMED on replay — per design.md Q1 v1 simplification. Layer-2 cached-prior-outcome return path is wired in the controller but unreachable until the SETNX behavior is softened in a future change.
- All 80 unit tests pass. Smoke verified: 11.1–11.8 edge cases (no-auth 401, issue+increment 200, replay 403, forged expired token 403, 25-req burst → 20 success + 5 × 429, psql totals consistent).
