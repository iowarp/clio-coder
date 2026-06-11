# clio-coder

Clio Coder is the coding agent in IOWarp's CLIO ecosystem of agentic science: a supervised, terminal-first harness for HPC and scientific-software repositories. The project is a TypeScript ESM Node.js codebase that owns the agent loop, interactive TUI, session format, tool registry, safety policy, and fleet dispatch. Inference comes from configured model targets, local runtimes or cloud APIs, through pi-ai-backed adapters; this repository is the harness, not the models.

## Conventions

- Biome owns formatting and lint: tabs, line width 120, double quotes. `npm run lint` must pass with zero diagnostics before review.
- Tests are node:test files under tests/contracts, tests/smoke, and tests/boundaries, run through tsx. New behavior lands with a test in the matching lane.
- Commit subjects are conventional and at most 72 characters: feat, fix, docs, test, refactor, build, ci, chore, with an optional scope.
- Update CHANGELOG.md in the same change for any user-visible behavior, developer workflow, or release-status change.
- ASCII punctuation in docs, comments, and commits. No em-dash clause separators and no emojis.
- No new biome-ignore, ts-ignore, or `any` without a linked tracking issue.

## Hard invariants

1. Engine boundary: only code under src/engine/** may value-import the pi SDK packages (@earendil-works/pi-*). Everything else consumes the engine through its exported interfaces.
2. Worker isolation: code under src/worker/** value-imports only the worker-safe provider modules under src/domains/providers/**; all other domain imports must be type-only.
3. Domain independence: src/domains/<x>/** never imports another domain's extension.ts; cross-domain flows go through SafeEventBus. `npm run check:boundaries` enforces all three invariants.

## Architecture map

src/cli owns command parsing and headless runs; src/interactive owns the TUI; src/engine wraps the pi SDK (agent loop, providers, streaming, ACP); src/domains holds the product logic (agents, config, context, dispatch, lifecycle, providers, resources, safety, session, and friends); src/tools implements the typed tool surface behind src/tools/registry.ts; src/worker is the isolated dispatch worker entry. src/domains is by far the largest area, followed by src/interactive, src/cli, and src/tools. One system prompt and one deterministic tool surface are compiled per session; per-tool policy is enforced at invocation time, not by reshaping the surface per turn.

## Context retrieval

The codewiki indexes the repository; refresh it after structural edits. For navigational tasks, prefer the indexed tools (entry_points, where_is, find_symbol) before broad reads. Useful starting points: src/cli/index.ts, src/domains/context/bootstrap.ts, src/domains/dispatch/index.ts, src/engine/index.ts, and src/tools/registry.ts.

## Verification expectations

Run `npm run typecheck` and `npm run lint` before any handoff. Use targeted lanes for narrow risk: `npm run test:contracts`, `npm run test:smoke`, `npm run check:boundaries`. Run `npm run test` when behavior crosses domains, tool contracts, smoke flows, or boundaries, and `npm run build` after CLI, worker, packaging, or generated-dist changes. `npm run ci` is the full local gate before committing shared behavior changes; `npm run ci:release` adds check-dist packaging verification and gates every tag.

## Workflow traps

The installed `clio` symlink executes dist/cli/index.js, so TypeScript edits are invisible until `npm run build` runs again. Lifecycle migration ids must be of the form `YYYY-MM-DD-<slug>` and registered in src/domains/lifecycle/migrations. Compiled prompt text and provider tool schemas are byte-stable per session by design; edits to prompt fragments or tool schemas invalidate local prompt-prefix caches and shift cache telemetry, so treat diffs in compiled prompt text as behavior changes. The shared settings file is written through field-level patches under an advisory lock; do not hand-edit it while sessions are live.

## Generated and local artifact policy

CLIO.md is the versioned, human-owned project handbook; review intentional changes like source. `.clio/*` (codewiki.json, state.json, proposals, handoffs) is ignored local context-engine state and is never committed unless explicitly force-added. dist/ is generated build output. docs/.superpowers/ is ignored dev scratch. `clio init` regenerates or updates CLIO.md through the bootstrap agent: `--propose` writes ignored drafts, `--apply` updates from the existing handbook, `--rewrite` generates a fresh handbook from repository structure.

## Self-development boundary

When Clio runs inside this repository, edits to her own TUI, skills, agents, tools, prompts, context engine, and harness are ordinary local source work when the user asks for them. Publishing, pushing, tagging, releasing, opening PRs, and registry contributions always require explicit user intent. The clio-dev skill under skills/ documents this boundary in full.
