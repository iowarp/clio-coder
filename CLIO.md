# Clio Coder

Clio Coder is IOWarp's TypeScript/Node.js coding-agent harness for HPC and scientific-software engineering. It owns the Clio identity, orchestration loop, TUI, context bootstrap, codewiki indexing, provider routing, safety gates, sessions, tools, dispatch, and ACP surfaces.

## Conventions

- Local TypeScript imports include `.js`; tests use `node:test`; prefer precise contracts over `any` and narrow array access explicitly.
- Domain manifests declare load order; extension factories wire runtime behavior; public cross-domain APIs live in `contract.ts` and `index.ts`.
- Prompt/context changes must preserve bounded tokens: prefer structured summaries, source provenance, and retrieval hints over copied file trees.
- For subprocess or pty tests, always arrange cleanup with `try/finally` and `p.kill()` so failures do not leak children.
- Generated or cache-like artifacts belong under `.clio/` or XDG paths; never make the model depend on `dist/` as source of truth.
- Use `Reflect.deleteProperty(obj, "key")` when cleaning object keys on hot paths or test env maps; Biome rejects `delete obj.key`.

## Hard invariants

1. Engine boundary: only `src/engine/**` may value-import `@earendil-works/pi-*`; non-engine code talks through Clio contracts or erased type-only imports.
2. Worker isolation: `src/worker/**` must not import `src/domains/**`; worker-facing shape crosses through `src/worker/spec-contract.ts` or other explicit contracts.
3. Domain independence: `src/domains/<x>/**` must not import `src/domains/<y>/extension.ts`; cross-domain access uses the contract exported from the target domain index.

## Architecture map for agents

Clio is a domain-loaded harness, not a monolithic CLI. `src/cli/index.ts` is argument routing; `src/entry/orchestrator.ts` and interactive entry points assemble domains and engine services. Core primitives in `src/core/**` are low-level and must stay dependency-light.

Treat `src/domains/**` as the product architecture. Each domain owns its manifest, extension, contract, and narrow pure helpers. Side effects usually belong in `extension.ts`; testable policy belongs in sibling pure modules. If a change needs another domain, add or reuse a contract method instead of importing internals.

Treat `src/engine/**` as the adapter boundary to pi-ai, provider streaming, session files, ACP transport, and TUI primitives. Engine modules may know external SDK details; domains should see normalized Clio types. If an SDK leak appears outside `src/engine/**`, fix the boundary rather than spreading the dependency.

Treat `src/tools/**` as the model-visible action surface. Tool names and profiles affect safety, dispatch prompts, ACP mapping, and telemetry, so tool changes require checking registry/profile consumers rather than only the implementation file.

## Context and bootstrap constitution

`CLIO.md` is the stable, human-audited constitution. It should encode repository-specific constraints, architecture traps, workflow strategy, and failure modes that are expensive for an agent to rediscover. It should not repeat generic language advice, obvious script names, raw file trees, secrets, caches, or long copied policy files.

`/init` and `clio init` should produce compact, verifiable guidance from evidence: package metadata, README summaries, existing agent configs, and codewiki signals. Adoption is provenance-preserving: imported rules are summarized with sources and conflicts rather than concatenated. Global imports only enter when explicitly requested.

Codewiki is the mutable retrieval layer. Do not bloat `CLIO.md` with symbol inventories. Tell agents which boundaries matter, then rely on `entry_points`, `where_is`, and `find_symbol` for exact TypeScript structure. If source topology changes, refresh `/init` so the fingerprint and codewiki move together.

## Workflow for changing Clio itself

Start by classifying the touched surface: CLI/user flow, domain contract, engine boundary, tool profile, prompt/context, session persistence, or frontend/TUI. Inspect the contract and tests before editing. Prefer small pure-function changes with focused contract tests over broad rewrites.

For context, prompt, and bootstrap work, verify both parse/serialize behavior and prompt injection behavior. A valid `CLIO.md` must survive `parseClioMd`, be rendered into project context, and stay useful when codewiki is available but not preloaded.

For provider, dispatch, ACP, and tool changes, follow the data path end to end: settings/defaults, provider resolution, safety/profile gating, worker spec, engine adapter, telemetry/receipt, and user-visible output. Many bugs are schema mismatches across these seams.

Finish with the narrowest meaningful validation. Prefer targeted contract tests while iterating, then typecheck/build when exported types or prompt contracts move. Report exactly what was run and what remains unverified.

## Self-Development & Contribution

When operating inside Clio Coder's own source tree, Clio may develop her own harness (TUI, skills, agents, tools, prompts, etc.) as ordinary repository work. Use workspace/codewiki evidence rather than mystique.

Distinguish local testing/configuration from community contribution:
- Local changes for testing/reconfiguring the local installation are permitted.
- Contributions back to the shared registry/repository require explicit user intent and normal Git/GitHub etiquette.
- Never push, open PRs, publish releases, or alter remotes without an explicit user request.

## High-risk failure modes

A prompt improvement can regress performance by spending tokens on obvious advice. Optimize for decision leverage per token: hard boundaries, retrieval strategy, non-obvious invariants, and known edge cases beat command lists and directory summaries.

A domain shortcut can compile while breaking architecture. Importing another domain's extension, bypassing manifests, or leaking engine SDK types makes future dispatch, ACP, and testing work harder. Add contracts instead.

A generated context artifact can become stale silently. The fingerprint footer and `.clio/state.json` exist to warn the agent; do not remove that metadata, and do not treat stale codewiki summaries as authoritative over source.

## Imported agent context

Conflict policy: CLIO.md conventions and hard invariants are canonical; project-local imports win over explicit global imports; duplicate rules are merged by normalized text.

### Adopted rules

- Consolidate results and present a unified summary of changes and tests run. Sources: `.codex/AGENTS.md`.
- Use the TUI slash commands or CLI for native Clio flows. Sources: `.codex/AGENTS.md`.
- Run interactive flows and dispatch multiple workers, then verify receipt structure on exit when testing dispatch behavior. Sources: `.codex/AGENTS.md`.
- Engine boundary, worker isolation, and domain independence are enforced repository rules; keep the canonical wording in Hard invariants. Sources: `.codex/skills/clio-testing/SKILL.md`.

### Source provenance

- Codex instructions (project): `.codex/AGENTS.md`; 4 candidates.
- Codex skill (project): `.codex/skills/clio-testing/SKILL.md`; 4 candidates.

<!-- clio:fingerprint v1
{
  "initAt": "2026-06-06T19:46:50.946Z",
  "model": "local-bootstrap",
  "gitHead": "083fd8a61b3c7adc791a3a8ff964ad97d21d87c0",
  "treeHash": "07d0c2c8a72111d98a9b953ff437a000e6f81dce19768f049813ee5100b76ac9",
  "loc": 76590
}
-->
