# pre-commit-hooks

## Purpose

Defines the Husky + lint-staged pre-commit hook setup that enforces lint and format on staged `.ts` files across both problem5 and problem6.

## Requirements

### Requirement: Pre-commit lint and format enforcement
Both problem5 and problem6 SHALL have Husky pre-commit hooks that run lint-staged on every `git commit`. lint-staged SHALL execute `eslint --fix` and `prettier --write` on staged `.ts` files.

#### Scenario: Staged TypeScript file is auto-fixed on commit
- **WHEN** a developer commits a staged `.ts` file with a lint violation
- **THEN** Husky SHALL run eslint --fix and prettier --write on the file before the commit completes

#### Scenario: Non-TypeScript files are not processed
- **WHEN** a developer commits only `.md` or `.json` files
- **THEN** lint-staged SHALL not run any linters on those files

#### Scenario: Lint failure blocks commit
- **WHEN** a staged `.ts` file has an unfixable lint error (e.g., `no-unused-vars`)
- **THEN** the commit SHALL be rejected with the eslint error output

### Requirement: Husky installed per-project with git-root awareness
Husky SHALL be configured in each project's `package.json` with the `prepare` script pointing to the correct `.husky/` directory relative to the git root. The `.husky/pre-commit` hook SHALL `cd` into the project directory before running `lint-staged`.

#### Scenario: Hook works from repo root
- **WHEN** a developer runs `git commit` from the repository root
- **THEN** the pre-commit hook SHALL correctly resolve the project directory and run lint-staged

#### Scenario: CI skips Husky hooks
- **WHEN** CI runs `pnpm install --frozen-lockfile`
- **THEN** the Husky `prepare` script SHALL be skipped (no `.husky/` installation in CI)

### Requirement: No typecheck in pre-commit
The pre-commit hook SHALL NOT run `tsc --noEmit` or any TypeScript type-checking. Type checking is CI-only due to requiring full project compilation.

#### Scenario: Commit completes without typecheck
- **WHEN** a developer commits a file with a type error but no lint violations
- **THEN** the commit SHALL succeed (type errors are caught in CI, not at commit time)
