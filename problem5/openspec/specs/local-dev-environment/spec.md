# local-dev-environment

## Purpose

Defines how a developer (or CI) brings the full service stack up locally using
a single toolchain manager and a single container orchestration file. This is
the contract between the repository and anyone onboarding — the guarantees
that turn `git clone` into a working stack.

## Requirements

### Requirement: Single-Command Tool Installation

The repository SHALL provide a `mise.toml` at the project root that pins exact versions of every tool a developer needs to run the service and its checks, so that a single `mise install` command is sufficient to set up the toolchain.

#### Scenario: New developer runs mise install

- **WHEN** a developer with `mise` already on their machine runs `mise install` in the project root
- **THEN** `mise` installs the pinned versions of Node, pnpm, k6, and the OpenSpec CLI
- **AND** every tool is available on the shell PATH inside the project directory

#### Scenario: mise.toml is missing a required tool

- **WHEN** a developer runs `pnpm install` without first running `mise install`
- **THEN** the command fails with a clear message
- **AND** the README.md reproduces the recovery steps

### Requirement: Container Build

The repository SHALL provide a multi-stage `Dockerfile` that produces a runtime image containing only the compiled JavaScript, production Node modules, and a non-root user.

#### Scenario: Developer builds the image

- **WHEN** a developer runs `docker build -t resources-api .`
- **THEN** the build completes successfully
- **AND** the resulting image runs as a non-root user
- **AND** the resulting image does not contain `devDependencies` or source TypeScript files

### Requirement: Local Stack Orchestration

The repository SHALL provide a `docker-compose.yml` that starts the API, a Postgres 16 instance, and a Redis 7 instance on a private network, wired so that the API can reach both datastores by DNS name.

#### Scenario: Developer starts the stack

- **WHEN** a developer runs `docker compose up -d`
- **THEN** three containers (`api`, `postgres`, `redis`) reach the `running` state
- **AND** the API container's healthcheck passes within its configured timeout
- **AND** `curl http://localhost:${PORT}/healthz` returns `200 OK`

#### Scenario: Postgres or Redis is slow to start

- **WHEN** the API container starts before Postgres or Redis is ready
- **THEN** the API waits for its upstreams (via healthcheck `depends_on` or retry-on-connect) rather than crash-looping
- **AND** the healthcheck eventually reports `200 OK`

#### Scenario: Developer stops the stack

- **WHEN** a developer runs `docker compose down`
- **THEN** all three containers stop and are removed
- **AND** named volumes for Postgres data persist unless `-v` is passed

### Requirement: Environment Configuration Template

The repository SHALL provide a `.env.example` file listing every environment variable the service reads, with a safe default or a clearly fake placeholder, and SHALL document in `README.md` how to copy it to `.env` for local development.

#### Scenario: Developer copies the template

- **WHEN** a developer runs `cp .env.example .env`
- **THEN** the resulting `.env` file can be used directly by `docker compose up` without further edits
- **AND** no real secrets are present in the committed `.env.example`

### Requirement: README Onboarding Path

The `README.md` SHALL document a linear onboarding path taking a new developer from `git clone` to a passing `/healthz` response in no more than five numbered steps.

#### Scenario: New developer follows the README

- **WHEN** a developer reads `README.md` top to bottom and executes each numbered step
- **THEN** the final step produces a successful HTTP response from `/healthz`
- **AND** no undocumented manual steps are required
