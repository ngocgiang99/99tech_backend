## ADDED Requirements

### Requirement: Controllers no longer contain local error-mapping try/catch (replaced by global filter)

The `ScoreboardController.incrementScore()` and `ActionsController.issueActionToken()` methods SHALL NOT contain local try/catch blocks for general error mapping. Errors propagate to the global exception filter (`scoreboard-observability` capability in this same change). The ONLY remaining try/catch in `ScoreboardController.incrementScore()` is for `IdempotencyViolationError`, because the replay path is a SUCCESS (200 with prior outcome), not an error.

#### Scenario: Controllers do not import error-mapping helpers
- **WHEN** `grep -E "catch \\(.*\\)" src/scoreboard/interface/http/controllers/` is run
- **THEN** the only matches are the `IdempotencyViolationError` replay catch in `scoreboard.controller.ts`
- **AND** there are NO other catch blocks mapping domain errors to HTTP codes

#### Scenario: Domain errors flow through the global filter
- **GIVEN** a controller method that calls `await this.handler.execute(cmd)` and the handler throws `InvalidArgumentError`
- **WHEN** the request is processed
- **THEN** the controller does NOT catch the error
- **AND** the global filter catches it
- **AND** the response is `400` with the standard envelope

#### Scenario: IdempotencyViolationError replay catch survives
- **GIVEN** a duplicate credit request that triggers `IdempotencyViolationError` from the handler
- **WHEN** the controller's local catch fires
- **THEN** the catch reads the prior outcome via `repository.findScoreEventByActionId()`
- **AND** returns 200 with the historical DTO
- **AND** the global filter is NOT consulted (the response is built locally)
