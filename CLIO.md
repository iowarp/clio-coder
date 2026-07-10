# Clio Coder

Clio Coder is a TypeScript/Node.js project. Coding agent for HPC and scientific-software developers, part of IOWarp's CLIO ecosystem of agentic science.

## Conventions

- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.

## Context retrieval

The codewiki currently indexes 806 source files. Start orientation with these indexed entry points: `src/cli/index.ts`, `src/domains/agents/index.ts`, `src/domains/components/index.ts`, `src/domains/config/index.ts`, `src/domains/context/bootstrap.ts`, `src/domains/context/index.ts`, `src/domains/dispatch/index.ts`, `src/domains/eval/index.ts`. Use `code_nav` (modes: entries, path, symbol) before broad reads when the task is navigational.

## Repository shape

Largest indexed areas: src/domains (350), tests/contracts (182), src/interactive (81), src/cli (48), src/engine (39), src/tools (39), src/core (31), benchmarks/community (9). Treat this as an orientation hint, not a complete file map; refresh the codewiki after structural edits.

## Verification expectations

Before handoff, run `npm run typecheck` and `npm run lint` for TypeScript and style checks. Run `npm run build` after CLI, worker, packaging, or generated-dist changes. Use targeted checks for narrower risk: `npm run test:contracts`, `npm run test:smoke`, `npm run check:boundaries`. Run `npm run test` when behavior crosses domains, tool contracts, smoke flows, or boundaries. Use `npm run ci` for the full local gate before committing broad or shared behavior changes.

## Context artifacts

`CLIO.md` is the versioned, human-owned project handbook and should be reviewed like source when intentionally changed. `.clio/codewiki.json`, `.clio/state.json`, `.clio/proposals/`, and `.clio/handoffs/` are ignored local context-engine artifacts. Do not commit `.clio/*` unless the user explicitly asks to force-add a shared artifact. `clio context init --propose` writes ignored drafts; `--apply` updates from the existing handbook; `--rewrite` generates a fresh handbook from repository structure and sibling context.

## Imported agent context

Conflict policy: CLIO.md conventions and hard invariants are canonical; project-local imports win over explicit global imports; duplicate rules are merged by normalized text.

### Adopted rules

- No project-specific rules were adopted from external agent configs.

### Source provenance

- No supported project-local agent config files were found.

### Rejected sources

- Claude Code `CLAUDE.md`: skipped symlink skipped.
- Codex `AGENTS.md`: skipped symlink skipped.
