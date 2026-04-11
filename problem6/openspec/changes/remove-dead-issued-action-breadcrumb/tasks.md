## 1. Code removal — `ActionsController`

- [ ] 1.1 Open `src/scoreboard/interface/http/controllers/actions.controller.ts` and locate the `issueActionToken()` method
- [ ] 1.2 Delete the block that reads `const ttl = this.config.get('ACTION_TOKEN_TTL_SECONDS');` followed by the `await this.redis.set('action:issued:' + result.actionId, '1', 'EX', ttl, 'NX');` call (both lines plus the surrounding comment if any)
- [ ] 1.3 Grep the remaining method body for `this.redis` — if zero references remain in the entire file, remove the `@Inject('Redis') private readonly redis: Redis,` parameter from the constructor and the `import type { Redis } from 'ioredis';` at the top
- [ ] 1.4 Grep the remaining file for `this.config` — if the only usage was the removed `ttl` lookup, remove the `private readonly config: ConfigService,` parameter from the constructor and the `import { ConfigService } from '../../../../config';` at the top. If `ConfigService` is still used elsewhere in the file (e.g. for `ACTION_TYPE_MAX_DELTA` or similar), leave it alone.
- [ ] 1.5 Run `mise run typecheck` from `problem6/` — confirm zero TypeScript errors
- [ ] 1.6 Run `mise run lint` — confirm no unused-import or unused-parameter warnings on the edited file

## 2. Test updates — `actions.controller.test.ts`

- [ ] 2.1 Open `test/unit/interface/http/actions.controller.test.ts`
- [ ] 2.2 Grep the file for `action:issued` and `redis.set` (or the mock name, e.g. `redisMock.set`) — locate every assertion that depends on the removed write
- [ ] 2.3 Delete any `it(...)` / `describe(...)` block whose sole purpose is asserting the Redis write (key name, TTL, NX flag, value). Do NOT delete tests that assert the envelope shape, JWT claims, or `ACTION_TYPE_MAX_DELTA` lookup
- [ ] 2.4 If the test file constructs a `redisMock` purely for the removed write, remove the mock setup. If the mock is still needed for other tests, leave it and ensure the removed-assertion tests no longer reference it
- [ ] 2.5 Add one new test: "issuance does not touch Redis" — construct the controller with a `redisMock` whose `set` method is a `vi.fn()` (or `jest.fn()`), invoke `issueActionToken()`, assert the mock was called `0` times. If DI for Redis has been removed from the controller (per Task 1.3), this test is not needed — the absence of the constructor parameter is sufficient proof
- [ ] 2.6 Add one new test: "issuance succeeds when Redis throws" — only if the Redis DI is still present (i.e. Task 1.3 did not remove it). Wire a `redisMock.set` that throws, invoke `issueActionToken()`, assert the response envelope is returned successfully. If Redis DI was removed, skip — the test is vacuously true
- [ ] 2.7 Run `mise run test` — confirm all `ActionsController` tests pass

## 3. Integration test audit (non-blocking)

- [ ] 3.1 Grep `test/integration/` for `action:issued` — if any integration test asserts the key exists in Redis after issuance, remove that assertion (the rest of the test is almost certainly about the happy-path envelope and stays valid)
- [ ] 3.2 Run `mise run test:integration` — confirm zero regressions in the auth suite

## 4. Flow diagram update

- [ ] 4.1 Open `problem6/docs/flow-diagram.md` section "3. Sequence — Issue Action Token"
- [ ] 4.2 Delete the line `API->>R: SET NX EX 300 action:issued:<actionId>` from the mermaid block
- [ ] 4.3 If no other line in diagram 3 references the `R` participant, delete the `participant R as Redis` line too. Otherwise leave it
- [ ] 4.4 Visually verify the diagram still parses (Mermaid live editor or `pnpm dlx @mermaid-js/mermaid-cli ...` if available). If not possible locally, a careful read of the block is acceptable — the removal is mechanical and can't introduce parse errors

## 5. Spec archive alignment (informational)

- [ ] 5.1 Confirm `openspec/changes/remove-dead-issued-action-breadcrumb/specs/scoreboard-auth/spec.md` uses `## MODIFIED Requirements` with the full updated requirement body — no delta will work otherwise
- [ ] 5.2 Confirm the scenario "Issued token is recorded in Redis" is absent from the delta file
- [ ] 5.3 Confirm the new scenarios "Issuance does NOT write to Redis" and "Issuance succeeds when Redis is unreachable" are present in the delta file

## 6. Validation

- [ ] 6.1 Run `openspec validate remove-dead-issued-action-breadcrumb` from inside `problem6/` — confirm exit 0
- [ ] 6.2 Run `mise run typecheck && mise run lint && mise run test` one final time — confirm exit 0 on all three
- [ ] 6.3 Git diff review — confirm the only files changed are: `actions.controller.ts`, `actions.controller.test.ts` (possibly), `flow-diagram.md`, and the openspec change directory. No other files should be touched
- [ ] 6.4 If any task above surfaced an unexpected dependency (e.g. `ConfigService` can't be removed because it's used in a way the grep missed), pause and triage before continuing — do NOT silently leave dead imports
