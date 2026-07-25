# Clio Coder

Clio Coder is a TypeScript/Node.js project. Coding agent for HPC and scientific-software developers, part of IOWarp's CLIO ecosystem of agentic science.

## Conventions

- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.

## Context retrieval

The codewiki currently indexes 901 source files. Start orientation with these indexed entry points: `src/cli/index.ts`, `src/domains/agents/index.ts`, `src/domains/components/index.ts`, `src/domains/config/index.ts`, `src/domains/context/bootstrap.ts`, `src/domains/context/index.ts`, `src/domains/dispatch/index.ts`, `src/domains/eval/index.ts`. Use `code_nav` (modes: entries, path, symbol) before broad reads when the task is navigational.

## Repository shape

Largest indexed areas: src/domains (382), tests/contracts (228), src/interactive (83), src/cli (48), src/tools (43), src/engine (40), src/core (35), benchmarks/community (9). Treat this as an orientation hint, not a complete file map; refresh the codewiki after structural edits.

## Verification expectations

Before handoff, run `npm run typecheck` and `npm run lint` for TypeScript and style checks. Run `npm run build` after CLI, worker, packaging, or generated-dist changes. Use targeted checks for narrower risk: `npm run test:contracts`, `npm run test:smoke`, `npm run check:boundaries`. Run `npm run test` when behavior crosses domains, tool contracts, smoke flows, or boundaries. Use `npm run ci` for the full local gate before committing broad or shared behavior changes.

## Context artifacts

`CLIO.md` is the versioned, human-owned project handbook and should be reviewed like source when intentionally changed. `.clio/codewiki.json`, `.clio/state.json`, `.clio/proposals/`, and `.clio/handoffs/` are ignored local context-engine artifacts. Do not commit `.clio/*` unless the user explicitly asks to force-add a shared artifact. `clio context init --propose` writes ignored drafts; `--apply` updates from the existing handbook; `--rewrite` generates a fresh handbook from repository structure and sibling context.

## Dispatch routing quality

- `src/domains/dispatch/route-quality.ts` is the pure reducer for integrity-valid receipt, gate, and eval evidence. Descriptive receipt verification never establishes routing quality.
- `src/domains/dispatch/route-history.ts` is the bounded durable estimator source. Receipt integrity v8 requires a run-local `quality` block; later gate and eval results link by authenticated receipt digest instead of mutating receipts.
