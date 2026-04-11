## Context

The scoreboard module's action-token flow writes two distinct Redis keys per token lifecycle:

1. **`action:issued:<aid>`** — written at issuance by `ActionsController.issueActionToken()`, TTL `ACTION_TOKEN_TTL_SECONDS` (5 min).
2. **`idempotency:action:<aid>`** — written at consumption by `ActionTokenGuard.canActivate()`, TTL `ACTION_TOKEN_TTL_SECONDS` (5 min in current config, spec historically referenced 24h).

Only the second key is ever read: `ActionTokenGuard` uses a `SET NX` on `idempotency:action:<aid>` and treats a losing SETNX as "action already consumed" (`403 ACTION_ALREADY_CONSUMED`). The first key is written by the controller and never consulted anywhere in the codebase — I searched all `.ts` files under `src/` and `test/` for `action:issued`, and found only the controller's write site and the spec file that mandates it.

This wasn't the original design intent. An archived earlier version of the auth layer used RS256 JWTs verified via JWKS, and the `action:issued:<aid>` key was the fallback anchor for "did we actually mint this token?" — a meaningful question when any party with a public key can construct a syntactically valid JWT. After the `replace-jwks-with-internal-hs256` change landed, that question became answerable purely from the HMAC signature (only holders of `ACTION_TOKEN_SECRET` can mint a valid signature), and the issuance-side check was silently dropped from the guard. The issuance-side write, however, remained in the controller and the spec — dead code that looks alive.

The concrete symptom that surfaced this: when Redis is down, `POST /v1/actions:issue-token` returns `500 INTERNAL_ERROR` even though the signed token is already in memory by the time Redis is touched. The user never receives a token they could otherwise have used. This is a pure availability loss with no security gain.

## Goals / Non-Goals

**Goals:**
- Remove the dead `action:issued:<aid>` Redis write from `ActionsController`.
- Update the `scoreboard-auth` spec to match code reality (drop the "recorded in Redis" scenario and the clause in the rule statement that mandates it).
- Update the flow diagram 3 to drop the now-removed step.
- Remove any tests that assert the write happened (and keep tests that assert token envelope shape).
- Reduce the blast radius of a Redis outage by one endpoint (`/v1/actions:issue-token` becomes Redis-free).

**Non-Goals:**
- Changing any aspect of the consumption path: `ActionTokenGuard`, `idempotency:action:<aid>`, `uq_score_events_action` are all untouched.
- Changing the HMAC signing, secret handling, or token envelope shape.
- Changing `ACTION_TOKEN_TTL_SECONDS`, the guard's SETNX TTL, or related config.
- Adding issuance-side allowlist semantics (Option B from the exploration) — explicitly deferred as a non-goal. If a future threat model requires defense-in-depth against secret leaks, the right response is rotation (already scoped separately), not re-introducing this write.
- Any change to logging, metrics, or forensic observability. The existing issuance-rate metric (if any) stays unchanged; this change does not introduce new metrics.

## Decisions

### Decision 1 — Remove the write, do not replace it

**Decision**: Delete the `await this.redis.set('action:issued:' + result.actionId, ...)` block from `ActionsController.issueActionToken()` outright. Do not add a Prometheus counter, do not add a log line with the raw actionId, do not add a forensic trail.

**Rationale**: The exploration confirmed three things:
1. HMAC + `ACTION_TOKEN_SECRET` is a complete answer to "did we mint this?" — the signature is mathematically equivalent to proof of issuance.
2. Replay detection lives in the consumption path (`idempotency:action:<aid>` SETNX + `uq_score_events_action` UNIQUE constraint), not the issuance path.
3. A 5-minute TTL makes the key's forensic value near-zero — by the time anyone would query it for "did we issue aid XYZ?", the key has likely expired.

Adding a metric or log line as a replacement would be premature — there's no identified consumer of that signal today. If issuance observability becomes a need, it can be added as a separate focused change that goes through its own cost/benefit analysis.

**Alternatives rejected**:
- *Replace with a metric*: `scoreboard_action_tokens_issued_total{actionType}` — deferred. The existing `metrics.ts` module can absorb this later if observability surfaces a need. Not doing it here keeps the change minimal and focused on the cleanup.
- *Replace with a structured log line*: rejected — the spec explicitly forbids logging raw tokens (the "Raw action token is never logged" scenario stays), and logging the `actionId` alone buys nothing that an OTel span doesn't already give us.
- *Keep the write but add a read path (Option B in exploration)*: rejected — would couple issuance and consumption availability to Redis, add ~1 RTT per consume, break the 5-min TTL boundary (tokens would die even if the JWT exp is still valid), and defend against a threat (leaked `ACTION_TOKEN_SECRET`) that rotation already addresses.

### Decision 2 — Audit and remove orphaned DI parameters

**Decision**: After removing the Redis SET call, audit `ActionsController`'s constructor for DI parameters that become unused. Specifically: `@Inject('Redis') private readonly redis: Redis` and `private readonly config: ConfigService`. Remove whichever become unreferenced.

**Rationale**: Leaving unused constructor parameters is a lint signal that ages badly — a future reader will assume there's a valid reason Redis is injected and try to use it, re-introducing the coupling. Removing them makes the "no Redis at issuance" intent textually obvious.

**Audit approach**: After editing the controller, grep the remaining controller body for `this.redis` and `this.config`. If no matches remain, remove the corresponding constructor parameter. Re-run `pnpm typecheck` to confirm nothing else in the file references them.

**Caveat**: `ConfigService` might still be used for other reads that aren't visible from the current snippet (e.g. `ACTION_TYPE_MAX_DELTA` might move to config later). The audit should check actual usage at edit time, not assume either way.

### Decision 3 — Spec delta uses MODIFIED + removed scenario, not REMOVED

**Decision**: Express the spec change as a `## MODIFIED Requirements` block containing the full updated requirement with the "recorded in Redis" scenario omitted, plus an updated rule statement. Do NOT use `## REMOVED Requirements` for this change.

**Rationale**: The requirement "Action token issuer endpoint mints HMAC-bound capability tokens" is not being deprecated — it still exists, it still governs the endpoint. What changes is *one clause in the rule statement* and *one scenario from the scenario list*. `MODIFIED` is the right delta operation for "change the content of an existing requirement"; `REMOVED` is for deleting the requirement entirely. The OpenSpec semantics require `MODIFIED` to include the full updated content (not a diff), so the delta file will copy the entire current requirement text from `openspec/specs/scoreboard-auth/spec.md`, remove the specific clause and scenario, and paste the result.

**Alternatives rejected**:
- *Use two separate deltas (MODIFIED for rule + REMOVED for scenario)*: rejected — scenarios aren't first-class deltaable entities in OpenSpec's schema; they live inside requirements. The only way to remove a scenario is to MODIFY the parent requirement.
- *Rewrite the scenario to describe the absence of a Redis write*: rejected as redundant — the spec doesn't need a scenario for "we do NOT write to Redis"; the absence of a scenario is the spec.

### Decision 4 — Flow diagram edit is part of the same change

**Decision**: Update `problem6/docs/flow-diagram.md` diagram 3 in the same change that removes the code and the spec. Do not defer the diagram edit to a separate docs-only change.

**Rationale**: The diagram is the thing that surfaced the question in the first place. Leaving it stale for any window — even one merge cycle — recreates the confusion this change is resolving. The diagram edit is mechanical (one line) and should ship with the code/spec it documents. The preceding session already fixed diagram 3's Mermaid syntax; this change makes a one-line content update on top.

## Risks / Trade-offs

- **[Loss of future forensic hook]** → Mitigation: the key was never read and had a 5-minute TTL; its forensic value was near-zero. If we later need issuance-side observability, add a dedicated metric in a focused change — don't resurrect a write-only Redis key.
- **[Spec drift vs. reality during deploy window]** → Mitigation: the spec change and the code change land together in a single change archive. There is no window where the spec says one thing and the code does another.
- **[Test brittleness]** → Some existing unit tests in `test/unit/interface/http/actions.controller.test.ts` may assert the Redis SET was called. Those tests will need to be deleted or rewritten. Mitigation: the task list enumerates this as an explicit step (grep for the key or the controller's `redis.set` call and delete the assertions); typechecking + the remaining "200 envelope shape" assertions are enough to prove the endpoint still works.
- **[If ConfigService injection stays]** → Mitigation: Decision 2's audit catches this. If the audit finds `ConfigService` is still referenced elsewhere in the controller, leave it; if not, remove it. Either outcome is correct.
- **[Aggregate test suite impact]** → Any integration test that boots the full controller stack against a real Redis must still work — nothing in the consumption path changes. The only tests that should need updates are the unit tests that directly assert the issuance-side write.

## Migration Plan

This is a non-breaking code change with no data migration:

1. Land the change in a single commit (code + tests + spec delta + flow-diagram edit).
2. Run `mise run typecheck` and `mise run lint` to confirm no orphaned references.
3. Run `mise run test` (unit) and verify all `ActionsController` tests pass.
4. Run `mise run test:integration` if an integration test touches the issuance path.
5. Deploy normally — no env var changes, no DB migration, no config change.

**Rollback**: revert the commit. No data to roll forward/back. Any tokens issued during the rollback window remain valid (their validity is HMAC-based, independent of any Redis state).

## Open Questions

None. The exploration that preceded this change resolved all the threat-model and design questions:
- Is HMAC sufficient for authenticity? Yes.
- Does the write provide any security value? No.
- Is there a use case for keeping it as a breadcrumb? No, none identified.
- Should rotation tooling absorb the defense-in-depth role? Yes, via `ACTION_TOKEN_SECRET_PREV` (already scoped in step-04 GAP-05).
