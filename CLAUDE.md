# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is a 99tech home assignment repository. Each problem is a **self-contained, independent project** in its own sibling directory — they do not share code, dependencies, or tooling.

- `problem-4/` — standalone TypeScript file with three `sum_to_n` implementations. No build tooling.
- `problem5/` — ExpressJS 5 + TypeScript CRUD service (Postgres, Redis, Docker, OpenSpec workflow). Has its own `package.json`, `tsconfig.json`, `.env`, and `CLAUDE.md`.
- `.worktrees/` — git worktrees for parallel feature branches (e.g. `feature-problem5`, `feature-problem6`). The active working directory is often itself a worktree.

Future problems will land as additional `problemN/` siblings with the same pattern: self-contained, own tooling, own `CLAUDE.md`.

## Load the Right CLAUDE.md

**Before doing any work, identify which problem directory the task belongs to and load that directory's `CLAUDE.md`.** This root file intentionally contains no project-specific commands or architecture — each sub-project's `CLAUDE.md` is the authoritative source for its own build commands, conventions, and structure.

Rules:

1. **Determine scope first.** Look at the file paths in the user's request, the current working directory, and the git branch name (e.g. `feature/problem5`) to figure out which `problemN/` directory you're operating in.
2. **Read `<problemN>/CLAUDE.md` before editing or running commands.** If it exists, it overrides anything you might assume from this root file. If no per-project `CLAUDE.md` exists yet, the project is minimal enough that this root file is sufficient (e.g. `problem-4/` today).
3. **Do not mix projects in one task.** Commands, dependencies, and conventions do not cross project boundaries. `pnpm`/`tsc`/`docker compose` invocations from one project do not apply to another.
4. **Run commands from inside the project directory**, not from the repo root, unless a per-project `CLAUDE.md` explicitly says otherwise.
5. **Never invent cross-project infrastructure** (shared libs, root-level `package.json`, monorepo tooling). Each problem is deliberately isolated.

## Known per-project CLAUDE.md files

| Directory | Has `CLAUDE.md`? | Notes |
|-----------|------------------|-------|
| `problem-4/` | No | Single file, no tooling. |
| `problem5/` | Yes → `problem5/CLAUDE.md` | Read this before touching any file under `problem5/`. |

When new problems are added, register their `CLAUDE.md` in the table above.
