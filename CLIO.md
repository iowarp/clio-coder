# Clio Coder

Clio Coder is a TypeScript coding agent framework for HPC and scientific-software developers, part of IOWarp's CLIO ecosystem of agentic science. It exposes an interactive TUI, a CLI with 20+ commands, and a multi-agent fleet dispatch system backed by a domain-driven architecture. The project bundles its own tool registry, prompt bundler, session manager with migrations, and safety/middleware layers.

## Conventions

- TypeScript strict mode: noUncheckedIndexedAccess, noImplicitOverride, exactOptionalPropertyTypes, isolatedModules enforced via tsconfig.json.
- Test harness has three layers — contracts (API shape), smoke (critical-path integration), boundaries (cross-domain invariants) — run together by `npm test`.
- Domain modules under src/domains/ are the primary architectural units; each domain exports an index.ts and owns its submodules.
- Agent fleet recipes are Markdown files with normalized spec fields: audience, category, capability, tools, skills, latency hints.

## Domain Architecture

The codebase is organized into ~20 domains under `src/domains/`, each owning a cohesive set of responsibilities. Key domains:

- **agents** — agent recipes, builtins, and fleet catalog
- **dispatch** — bounded task dispatch to the fleet (single + batch)
- **tools** — tool registry; every tool registers on a shared registry
- **prompts** — prompt bundler with fragment system and `--no-context-files` toggle
- **context** — bootstrap, CLIO.md loading, and context composition
- **session** — session state management with versioned migrations (Phase 12+)
- **lifecycle** — state migration runner keyed by `YYYY-MM-DD-<slug>` ids
- **safety** — safety policy enforcement (allow/ask/hard-block) and confirmation gating
- **providers** — model/target providers and capability negotiation
- **middleware** — request/response interception pipeline

Domains are imported by the orchestrator (`src/entry/orchestrator.ts`) and the TUI (`src/interactive/`). Cross-domain imports should flow inward toward infrastructure; avoid circular domain dependencies.

## Test Strategy

Three deterministic test layers under `tests/`:

1. **Contracts** (`tests/contracts/`) — validate public API shapes, domain module factories, and tool registration. Run via `npm run test:contracts`.
2. **Smoke** (`tests/smoke/`) — critical-path integration tests (CLI help, agent dispatch round-trip). Run via `npm run test:smoke`.
3. **Boundaries** (`tests/boundaries/`) — cross-domain invariant checks (e.g., all tools registered, no orphaned domains). Run via `npm run check:boundaries`.

Full suite: `npm test`. CI pipeline: typecheck → lint → build → test (`npm run ci`).

The mock-provider and ACP-over-stdio harness in the smoke tests allow offline verification without live API calls.

## Fleet & Agent Recipes

Clio manages a small fleet of coding agents. Each agent is a Markdown recipe with normalized spec fields (audience, category, capability, tools, skills, latency hints).

**User-facing agents:** coder, documenter, architect, debugger, tester, verifier.

**Shadow agents:** scout (reconnaissance), provenance (receipts/telemetry), researcher (external sources). These are internal orchestration helpers — never recommend them as normal choices.

Dispatch via the `dispatch` tool (single task) or `dispatch_batch` (multiple tasks). Default agent is `coder`. Target/model defaults come from fleet configuration. Use `agent_runtime` or `target` overrides only when needed.

## Self-Development Policy

When modifying Clio Coder's own source, the `clio-dev` skill governs what may change freely versus what requires explicit user intent. Key boundaries:

- **Free to modify:** TUI, skills, agents, tools, prompts, domains, context/bootstrap, harness — when making improvements or bug fixes.
- **Requires explicit user intent:** shared contributions, publishing, pushing, PRs, releases. Do not imply autonomous publishing.
- **Session handoff:** use the `context-handoff` skill when a session winds down and work continues in a new session or agent.
- **Session prime:** use the `context-prime` skill at session start to reconstruct intent from the last handoff and git state.

<!-- clio:fingerprint v1
{
  "initAt": "2026-06-09T13:26:49.548Z",
  "model": "configured-clio-target",
  "gitHead": "285e20639108a93205afe45a926c072b0c6172ec",
  "treeHash": "91e1e19861a7bac9036f35272336fb96bb8c65ada6f9e14e0b5f1c858d377dda",
  "loc": 83150
}
-->
