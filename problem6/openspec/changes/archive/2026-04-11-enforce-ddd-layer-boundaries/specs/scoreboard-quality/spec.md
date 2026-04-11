## MODIFIED Requirements

### Requirement: ESLint enforces hexagonal layer boundaries

The `eslint-plugin-boundaries` configuration in `eslint.config.mjs` SHALL enforce the hexagonal layering contract defined by the `scoreboard-architecture` capability. The `boundaries/dependencies` rule SHALL be configured at `error` severity (not `warn`) and SHALL cause `pnpm eslint src/` to exit non-zero on any boundary violation. The `interface` layer's `allow` list SHALL include `application`, `domain`, and `shared` (plus `external` and `core`). The `interface → infrastructure` path SHALL be explicitly disallowed via a per-rule `disallow` entry with a human-readable `message`, rather than relying on the plugin's `default: disallow` semantics.

Exemptions SHALL be expressed as per-line `// eslint-disable-next-line boundaries/dependencies -- <rationale>` comments on the specific import line. Config-file-level exemptions SHALL NOT be used because they hide exemptions from file readers. The only two permitted exemption categories are (1) NestJS guard imports used via `@UseGuards()`, and (2) the `health.controller.ts` import of `HealthService` from `infrastructure/health/`.

#### Scenario: The interface → domain allow is present
- **WHEN** `eslint.config.mjs` is inspected
- **THEN** the `boundaries/dependencies` rule's `interface` `from` entry has `allow` containing at least `domain`, `application`, and `shared`

#### Scenario: The interface → infrastructure explicit disallow is present
- **WHEN** `eslint.config.mjs` is inspected
- **THEN** there is a rule entry with `from: { type: 'interface' }`, `disallow: [{ to: { type: 'infrastructure' } }]`, and a `message` field containing the phrase "Interface layer cannot import from infrastructure"

#### Scenario: Lint fails on a synthetic violation
- **GIVEN** a temporary file `src/scoreboard/interface/http/controllers/tmp-violation.controller.ts` that imports anything from `src/scoreboard/infrastructure/` without an eslint-disable comment
- **WHEN** `pnpm eslint src/scoreboard/interface/http/controllers/tmp-violation.controller.ts` is run
- **THEN** the exit code is non-zero
- **AND** the output mentions `boundaries/dependencies`
- **AND** the output contains the configured disallow message

#### Scenario: Lint passes on the refactored codebase
- **WHEN** `pnpm eslint src/` is run after this change is applied
- **THEN** the exit code is 0
- **AND** every existing boundary violation has either been fixed or marked with a per-line eslint-disable comment containing the phrase "NestJS guard" or "health controller is a thin HTTP adapter over infra probes"

#### Scenario: `mise run lint` is a CI gate
- **WHEN** `mise run lint` is run as part of the pre-push gate (`mise run check`)
- **THEN** any boundary violation introduced by a future change fails the gate
- **AND** the failure message is clear enough for a developer to locate the offending import
