## ADDED Requirements

### Requirement: ACTION_TOKEN_SECRET_PREV optional env var supports dual-secret rotation

The `EnvSchema` SHALL include an optional `ACTION_TOKEN_SECRET_PREV: z.string().min(32).optional()` field. When unset, the `HmacActionTokenVerifier` operates in single-secret mode (identical to `step-03`'s behavior). When set, the verifier operates in dual-secret rotation mode (per `scoreboard-auth`'s GAP-05 requirement in this same change).

#### Scenario: Schema accepts ACTION_TOKEN_SECRET_PREV when set with valid length
- **GIVEN** the env has `ACTION_TOKEN_SECRET_PREV=<32+ char string>`
- **WHEN** the schema parses
- **THEN** `configService.get('ACTION_TOKEN_SECRET_PREV')` returns the string
- **AND** the type is `string | undefined`

#### Scenario: Schema accepts the variable being unset (default state)
- **GIVEN** the env has no `ACTION_TOKEN_SECRET_PREV`
- **WHEN** the schema parses
- **THEN** the parse succeeds (the field is optional)
- **AND** `configService.get('ACTION_TOKEN_SECRET_PREV')` returns `undefined`

#### Scenario: Schema rejects ACTION_TOKEN_SECRET_PREV shorter than 32 chars
- **GIVEN** the env has `ACTION_TOKEN_SECRET_PREV=short`
- **WHEN** the schema parses
- **THEN** the parse fails
- **AND** the boot exits non-zero with an error naming `ACTION_TOKEN_SECRET_PREV` and the min-length constraint
