# ci-pipeline

## Purpose

Defines the GitHub Actions CI pipeline that automates quality gates (typecheck, lint, unit tests) for both problem5 and problem6 on every push and pull request.

## Requirements

### Requirement: Automated quality gates on push and PR
The repository SHALL have a GitHub Actions workflow that runs typecheck, lint, and unit tests for both problem5 and problem6 on every push to any branch and every pull request targeting `main`.

#### Scenario: Push to feature branch triggers CI for changed project
- **WHEN** a developer pushes to a feature branch with changes in `problem5/`
- **THEN** the CI pipeline SHALL run typecheck + lint + unit tests for problem5 only

#### Scenario: Push to feature branch triggers CI for problem6
- **WHEN** a developer pushes to a feature branch with changes in `problem6/`
- **THEN** the CI pipeline SHALL run typecheck + lint + unit tests for problem6 only

#### Scenario: PR to main triggers CI for both if workflow file changes
- **WHEN** a PR to `main` modifies `.github/workflows/ci.yml`
- **THEN** the CI pipeline SHALL run quality gates for both problem5 and problem6

#### Scenario: CI uses mise for tool consistency
- **WHEN** the CI pipeline runs
- **THEN** it SHALL use `mise install` + `mise run` commands to match local developer tooling

### Requirement: CI runs only typecheck, lint, and unit tests
The CI pipeline SHALL NOT run integration tests, e2e tests, or load tests. These require Docker infrastructure and are out of scope.

#### Scenario: No Docker required in CI
- **WHEN** the CI pipeline executes
- **THEN** it SHALL complete without requiring Docker, Testcontainers, or any container runtime

### Requirement: Path-filtered matrix strategy
The workflow SHALL use a matrix strategy with path filters so each project's CI only runs when its files change.

#### Scenario: Unrelated project changes do not trigger CI
- **WHEN** a developer pushes changes only to `problem-4/`
- **THEN** no CI jobs SHALL run for problem5 or problem6
