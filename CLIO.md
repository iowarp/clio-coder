# clio-coder

Clio Coder is IOWarp's orchestrator coding agent. It owns the agent loop, TUI, session format, tool registry, and identity.

## Hard invariants

1. Migration ids must be of form `YYYY-MM-DD-<slug>` and are registered in src/domains/lifecycle/migrations.
2. Worker isolation: code under src/worker/** may only import from src/domains/providers, not other domain modules.

## Context Retrieval

The codewiki indexes 499 modules across the repository. Start orientation with these indexed entry points: src/cli/index.ts, src/domains/agents/index.ts, src/domains/components/index.ts, src/domains/config/index.ts, src/domains/context/bootstrap.ts, src/domains/context/index.ts, src/domains/dispatch/index.ts, src/domains/eval/index.ts. Use entry_points, where_is, and find_symbol before broad reads when the task is navigational.

## Repository Shape

Largest indexed areas are src/domains (267 modules), src/interactive (67), src/cli (36), src/tools (33). Treat this as an orientation hint; refresh the codewiki after structural edits.

## Architecture Boundaries

- Migration ids must be of form `YYYY-MM-DD-<slug>` and are registered in src/domains/lifecycle/migrations.
- Worker isolation: code under src/worker/** may only import from src/domains/providers, not other domain modules.

## Verification expectations

Before handoff, run `npm run typecheck` and `npm run lint` for TypeScript and style checks. Run `npm run build` after CLI, worker, packaging, or generated-dist changes. Use targeted checks for narrower risk: `npm run test:contracts`, `npm run test:smoke`, `npm run check:boundaries`. Run `npm run test` when behavior crosses domains, tool contracts, smoke flows, or boundaries. Use `npm run ci` for the full local gate before committing broad or shared behavior changes.

## Context artifacts

`CLIO.md` is the versioned, human-owned project handbook and should be reviewed like source when intentionally changed. `.clio/codewiki.json`, `.clio/state.json`, `.clio/proposals/`, and `.clio/handoffs/` are ignored local context-engine artifacts. Do not commit `.clio/*` unless the user explicitly asks to force-add a shared artifact. `context-init --propose` writes ignored drafts; `--apply` updates from the existing handbook; `--rewrite` generates a fresh handbook from repository structure and sibling context.
