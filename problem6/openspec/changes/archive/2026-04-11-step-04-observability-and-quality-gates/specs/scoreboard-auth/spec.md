## ADDED Requirements

### Requirement: HmacActionTokenVerifier supports dual-secret rotation (GAP-05)

The `HmacActionTokenVerifier` SHALL accept an optional secondary secret via the env var `ACTION_TOKEN_SECRET_PREV` (added to `EnvSchema` in this change). When set, verification SHALL attempt the primary secret (`ACTION_TOKEN_SECRET`) first; on signature failure, the verifier SHALL re-attempt with the prev secret. Verification of any other claim (sub/aid/exp/mxd) is unchanged.

#### Scenario: Token signed with primary secret verifies normally
- **GIVEN** both `ACTION_TOKEN_SECRET` and `ACTION_TOKEN_SECRET_PREV` are set
- **WHEN** a token signed with the primary secret is verified
- **THEN** the primary verification succeeds on the first attempt
- **AND** the prev secret is not consulted

#### Scenario: Token signed with prev secret verifies via fallback
- **GIVEN** both secrets are set
- **WHEN** a token signed with the prev secret is verified
- **THEN** the primary verification fails with a signature error
- **AND** the verifier catches the failure and retries with the prev secret
- **AND** the prev verification succeeds
- **AND** the verified claims are returned

#### Scenario: Token signed with neither secret is rejected
- **GIVEN** both secrets are set
- **WHEN** a token signed with an unrelated secret is verified
- **THEN** both attempts fail
- **AND** the verifier throws `InvalidActionTokenError`

#### Scenario: Verifier without prev secret behaves identically to single-secret mode
- **GIVEN** `ACTION_TOKEN_SECRET_PREV` is unset (the default)
- **WHEN** any token is verified
- **THEN** only the primary secret is attempted
- **AND** the verifier's behavior is identical to the pre-rotation `step-03` implementation

### Requirement: Operator-facing rotation runbook documents the four-step procedure

`problem6/docs/runbooks/action-token-rotation.md` SHALL document a manual rotation procedure with four numbered steps and a verification section. The runbook SHALL be operator-facing prose (not developer documentation) and SHALL bake in the rollover window length agreed at /opsx:apply time.

#### Scenario: Operator can follow the runbook from start to finish
- **GIVEN** an operator with deploy access and shell access
- **WHEN** they follow the runbook's four steps in order
- **THEN** they: (1) deploy with `ACTION_TOKEN_SECRET=old` and `ACTION_TOKEN_SECRET_PREV` empty, (2) deploy with `ACTION_TOKEN_SECRET=new` and `ACTION_TOKEN_SECRET_PREV=old`, (3) wait for the rollover window to close, (4) deploy with `ACTION_TOKEN_SECRET=new` and `ACTION_TOKEN_SECRET_PREV` empty
- **AND** at no point during the rotation are user-visible failures observed
- **AND** the runbook explicitly references the rollover window length (set by DECISION-1 at /opsx:apply time)

#### Scenario: Verification step proves dual-secret works
- **WHEN** the operator runs the runbook's "Verification" section
- **THEN** they obtain a token signed by the prev secret (using a saved curl example or a small script provided in the runbook)
- **AND** call `POST /v1/scores:increment` with that token
- **AND** observe a 200 response (proving the fallback path works)

#### Scenario: Runbook closes GAP-05 in the planning artifacts
- **WHEN** the runbook is committed
- **THEN** `_bmad-output/planning-artifacts/architecture.md` `openGaps` is updated to mark GAP-05 as "resolved via runbook"
- **AND** the runbook itself contains a backlink to that openGaps entry
