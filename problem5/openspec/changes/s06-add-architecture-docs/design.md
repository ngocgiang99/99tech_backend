## Context

A take-home review happens in a browser tab, not in an IDE. The reviewer opens `README.md`, skims the project structure, and forms their opinion in the first 5–10 minutes. `Architecture.md` is the artifact that bridges code and intent: it shows *why* the code is structured the way it is, not just *what* is there.

The design challenge here is not technical — it is communicative. The question is: what does a reviewer need to understand the system in 5 minutes? The answer drives the choice of diagrams and the depth of each section.

## Goals / Non-Goals

**Goals:**

- A concise `Architecture.md` that a reviewer can read in under 10 minutes and understand the system end-to-end.
- Mermaid diagrams that render in GitHub (no external tools required).
- A failure modes table that shows the reviewer the system has been designed defensively.
- A README polish that makes the onboarding section and the architecture section cohere.

**Non-Goals:**

- Formal arc42 or C4 model compliance. We borrow the vocabulary (context, container) but do not follow the full template.
- API documentation. The spec files and in-code comments cover that.
- Operational runbooks. Out of scope for a take-home.
- Diagrams for every edge case. The six diagrams listed in the proposal cover the reviewer's key questions.

## Decisions

### Decision 1: Mermaid over PlantUML or draw.io

Mermaid diagrams are defined in Markdown fenced code blocks and render natively in GitHub's Markdown preview, GitLab, and VS Code. No tool installation required, no image exports to keep in sync, no binary blobs in the repo.

**Alternatives considered:**

- *PlantUML*: More expressive but requires a local Java install or a server-side renderer. Not universally available in browser preview.
- *draw.io (`.drawio` XML)*: Excellent tool but produces non-human-readable XML blobs; diffs are unreadable; not renderable in GitHub Markdown.
- *SVG images exported from a tool*: Pretty but becomes stale the moment the architecture changes.

### Decision 2: Six diagrams covering the C4 levels appropriate for the project's size

1. **Context diagram** — system in its environment (clients, Postgres, Redis). One Mermaid `graph LR`.
2. **Container diagram** — internal module decomposition. One Mermaid `graph TD`.
3. **Request-flow sequence** — two sequence diagrams: one for `GET /resources/:id` (cache HIT and MISS), one for `POST /resources` (with cache invalidation).
4. **Data model** — Postgres `resources` table schema + Redis key taxonomy. One Mermaid `erDiagram` or plain table.
5. **Deployment** — Docker Compose topology: `api`, `postgres`, `redis`, networks, volumes. One Mermaid `graph LR` or `flowchart`.
6. **Failure modes** — a Markdown table: scenario → system behavior → degradation vs. failure.

This is the minimum set that answers a reviewer's six mental model questions:
- What does it talk to? (context)
- What are the moving parts? (container)
- What happens on a request? (sequence)
- What does the data look like? (data model)
- How do I run it? (deployment)
- What breaks and how? (failure modes)

**Alternatives considered:**

- *More diagrams*: Adds reading time without proportionate insight.
- *Fewer diagrams (no failure modes)*: Misses the most important signal about defensive design.

### Decision 3: Failure modes as a table, not a diagram

Failure mode documentation reads faster as a table than as a state machine diagram. Each row states the failed component, the observable effect, whether the service degrades or fails completely, and how to recover. Reviewers scan tables faster than they trace diagrams for sequential logic.

**Alternatives considered:**

- *Sequence diagram per failure scenario*: Too verbose; adds 3–4 diagrams that each show a degenerate case.
- *Narrative prose*: Harder to scan at a glance.

### Decision 4: README polish is additive, not a rewrite

The existing README (from Change 2) already covers setup and API endpoints. This change adds an "Architecture" section that summarizes the design decisions in 5 bullet points and links to `Architecture.md` for depth. The existing content stays intact.

**Alternatives considered:**

- *Rewrite README from scratch*: Risky; may drop accurate setup information. Additive is safer.
- *Only add `Architecture.md`, don't touch README*: Leaves the README without any navigation to the architecture doc. Reviewers who read top-to-bottom may miss it.

## Risks / Trade-offs

- **[Risk: Mermaid diagrams become stale when code changes]** → Mitigation: Diagrams document the stable architecture (layers, data model, deployment topology), not implementation details that change often. The failure modes table is driven by design decisions documented in Changes 1–3, which are stable.
- **[Risk: Diagrams are too abstract to be useful]** → Mitigation: Each diagram includes module/file names from the actual codebase, grounding it in the code.
- **[Risk: Architecture.md is too long and the reviewer stops reading]** → Mitigation: The document is structured with a clear reading path: skim the context diagram first (30 s), dive into sequences if curious, reference failure modes for the "what breaks" question. Each section is bounded.

## Migration Plan

No runtime changes. New files only. Order: write diagrams in `Architecture.md`, run a GitHub/VS Code preview to confirm rendering, update `README.md` architecture section.

## Open Questions

- **Should we include a scale-out diagram showing what production would look like (multiple API replicas, PgBouncer, Redis Cluster)?** Useful for the Interpretation section of `Benchmark.md`, but duplicates effort. Decision: include a brief prose section in `Architecture.md` titled "Production topology" with a simple ASCII or Mermaid diagram, pointing to `Benchmark.md` for the performance context.
