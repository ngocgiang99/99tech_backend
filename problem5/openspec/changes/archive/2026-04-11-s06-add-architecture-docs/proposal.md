## Why

Changes 1–5 produce a working, tested, benchmarked service. The only thing missing is a document that explains the system to a reviewer who has not read all five changes in order. Reviewers evaluate take-home submissions in under 30 minutes. An `Architecture.md` with clear Mermaid diagrams lets a reviewer understand the layering, the data flow, the failure modes, and the scale-out story in 5 minutes — without reading code.

The README also needs a final polish pass: the onboarding flow covers development and test, but the narrative connecting "why this architecture" to the code is buried in the OpenSpec changes, not surfaced in the file a reviewer reads first.

## What Changes

- Introduce `Architecture.md` at the project root containing:
  - Context diagram (the service in its environment: clients, Postgres, Redis)
  - Container diagram (the internal modules: HTTP layer, service, repository, cache, migrations)
  - Request-flow sequence diagram (GET and POST flows through all layers)
  - Data model diagram (resource entity, Postgres schema, Redis key schema)
  - Deployment diagram (Docker Compose topology)
  - Failure modes table (what happens when Postgres is down / Redis is down / both down)
- Update `README.md` with a polished "Architecture" section that links to `Architecture.md` and summarizes the key design decisions in 5 bullet points.
- No code changes.

## Capabilities

### New Capabilities

- `architecture-documentation`: The contract for how the system's architecture is communicated to reviewers and future contributors.

### Modified Capabilities

None.

## Impact

- **New files**: `Architecture.md`.
- **Modified files**: `README.md` (architecture summary section added).
- **New dependencies**: None. Mermaid diagrams are rendered by GitHub's markdown preview and by most editors.
- **APIs exposed**: None.
- **Systems affected**: None.
- **Breaking changes**: None.
