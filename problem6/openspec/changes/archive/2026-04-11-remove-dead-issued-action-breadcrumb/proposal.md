## Why

`ActionsController.issueActionToken()` writes `action:issued:<actionId>` to Redis after minting a token, but no code path in the entire repo ever reads that key. The scoreboard-auth spec mandates this write (Scenario: "Issued token is recorded in Redis"), yet action-token consumption relies exclusively on HMAC signature verification + `idempotency:action:<aid>` SETNX + the `uq_score_events_action` Postgres UNIQUE constraint — none of which touch `action:issued:<aid>`. The write is a residual breadcrumb from an earlier design where the consumption guard cross-checked "did we mint this?" before the HS256 migration made HMAC self-authenticating. Keeping the write costs one Redis RTT per issuance, couples the issuance endpoint's availability to Redis (an outage → 500 INTERNAL_ERROR even though the signed token is already in memory), and misleads readers of the spec into thinking there's a meaningful issuance-side replay defense. Removing it simplifies the endpoint to pure HMAC signing, removes the Redis dependency from the issuance path, and brings the spec into alignment with the actual security model.

## What Changes

- **REMOVED (code)**: The `await this.redis.set('action:issued:' + result.actionId, '1', 'EX', ttl, 'NX')` block in `src/scoreboard/interface/http/controllers/actions.controller.ts`. After this change, the controller returns the signed token without touching Redis.
- **REMOVED (DI)**: If the `Redis` injection in `ActionsController` becomes unused after removing the write, the `@Inject('Redis')` parameter SHALL be removed from the constructor. The same applies to the `ConfigService` injection if it's only read for `ACTION_TOKEN_TTL_SECONDS` at the removed write site — audit and remove if orphaned.
- **REMOVED (tests)**: `test/unit/interface/http/actions.controller.test.ts` scenarios that assert the Redis write happened, the key name, or the TTL value. Tests that assert the minted-token envelope shape remain.
- **MODIFIED (spec)**: `openspec/specs/scoreboard-auth/spec.md` — the requirement "Action token issuer endpoint mints HMAC-bound capability tokens" is MODIFIED to drop the `(3) record SET NX ... action:issued:<aid> in Redis` clause from its rule statement. The scenario "Issued token is recorded in Redis" is REMOVED. The scenario "Raw action token is never logged" is retained unchanged.
- **MODIFIED (docs)**: `problem6/docs/flow-diagram.md` diagram 3 — the `API->>R: SET NX EX 300 action:issued:<actionId>` step is removed from the sequence. The Redis participant is kept only if another step in the diagram uses it; otherwise the participant is removed.
- **NOT CHANGED**: HMAC signature verification, `idempotency:action:<aid>` SETNX at consumption, `uq_score_events_action` Postgres UNIQUE constraint, `ActionTokenGuard` fully unchanged. The three-layer idempotency/replay defense (HMAC + Redis SETNX at consumption + Postgres UNIQUE) is preserved end-to-end.
- **NOT A BREAKING CHANGE** for API clients: the HTTP contract is unchanged; the response body still returns `{ actionId, actionToken, expiresAt, maxDelta }`. Only the server-side side effect is removed.

## Capabilities

### New Capabilities

(none — this is a pure cleanup/refactor of existing capabilities)

### Modified Capabilities

- `scoreboard-auth`: The "Action token issuer endpoint mints HMAC-bound capability tokens" requirement's rule statement drops the Redis-write clause; the "Issued token is recorded in Redis" scenario is removed.

## Impact

**Removed code (~10 LOC):**
- `src/scoreboard/interface/http/controllers/actions.controller.ts`: 7 lines for the Redis SET call + the `ttl` variable assignment
- `src/scoreboard/interface/http/controllers/actions.controller.ts`: potentially the `redis` and `config` constructor parameters if they become unused (audit-dependent)
- `test/unit/interface/http/actions.controller.test.ts`: ~15 lines of Redis assertion setup + scenario

**Modified files:**
- `src/scoreboard/interface/http/controllers/actions.controller.ts` — remove write block, audit unused DI params
- `test/unit/interface/http/actions.controller.test.ts` — remove Redis assertions, keep token-envelope assertions
- `openspec/specs/scoreboard-auth/spec.md` — modify rule statement + remove scenario (via the delta in this change)
- `problem6/docs/flow-diagram.md` — remove step from diagram 3

**Operational consequences:**
- `POST /v1/actions:issue-token` no longer requires Redis at runtime — the endpoint survives Redis outages cleanly (reducing blast radius of a Redis outage by one endpoint).
- One fewer Redis RTT per issuance (~0.5-1ms saving at local latency; not a perf driver, but free).
- No security property changes. Replay defense remains: HMAC signature self-authenticates the token, `idempotency:action:<aid>` SETNX at consumption detects replays in the fast path, `uq_score_events_action` UNIQUE constraint is the authoritative backstop.

**Out of scope:**
- Any change to `ActionTokenGuard` or the consumption path.
- Any change to the `idempotency:action:<aid>` key or its TTL.
- Any change to the `uq_score_events_action` constraint.
- Re-introducing an issuance-side allowlist (Option B from the exploration) — explicitly deferred. If a future threat model requires defense-in-depth against `ACTION_TOKEN_SECRET` leaks, the right response is to accelerate rotation tooling (already scoped as step-04 GAP-05 for `ACTION_TOKEN_SECRET_PREV`), not to re-introduce this write.
