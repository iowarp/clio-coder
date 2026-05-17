# Clio Coder Simplification Plan

Date: 2026-05-16

This plan keeps the core engine focused on pi-sdk orchestration, context management, local model tuning, scientific reproducibility, observability, and correctness. MCP, scout/explore agents, tilldone/task-list workflows, and fleet orchestration remain extension or orchestration features unless a core contract is required.

## Core Tooling

- Keep the core tool layer small: read, write, edit, grep, find, ls, bash, web fetch, and safe fixed-vector commands.
- Prefer shared helpers for path resolution, truncation, executable discovery, mutation serialization, and diff generation.
- Retire custom traversal logic when `rg`, `fd`, `grep`, `find`, or codewiki-backed tools cover the same workflow.
- Keep `bash` bounded by Clio safety and mode policy. Do not port the reference renderer, streaming accumulator, shell hooks, or pluggable execution backend into core without a separate engine contract.
- Keep `ls` and search tools prompt-friendly and deterministic: bounded output, actionable continuation hints, and no redundant type/size formats unless a specific workflow needs them.

## Extensions Manager

- Split `src/domains/extensions/manager.ts` into three responsibilities:
  - discovery and manifest validation;
  - activation and lifecycle wiring;
  - runtime registry mutation for tools, prompts, middleware, and agents.
- Make activation outputs explicit value objects that can be diffed and tested before mutating registries.
- Keep hot reload outside the stable core path. Treat reload/restart machinery as external developer tooling unless production workflows prove otherwise.
- Add focused tests around duplicate ids, failed activation rollback, and extension-provided tool visibility.

## Resources

- Genericize prompt, skill, and future resource loaders around one loader shape:
  - roots;
  - frontmatter parser;
  - id derivation;
  - diagnostics;
  - project-over-user precedence.
- Keep domain-specific validation in thin adapters instead of duplicating filesystem walking and override logic.
- Preserve workspace context and codewiki resources as differentiators, but expose them through the same resource-loading diagnostics and precedence model.

## Config Resolution

- Move `!cmd` execution out of generic config value resolution.
- Replace it with an explicit command-backed secret or dynamic value provider that is opt-in, logged, cacheable, and policy-gated.
- Keep plain environment expansion and home/cwd path expansion in the generic resolver.
- Add migration diagnostics for existing bang-prefixed config values before removing compatibility.

## Search And Context Overlap

- Make `grep` and `find` the default broad filesystem search tools.
- Keep codewiki tools for semantic workspace questions such as symbol location, ownership, and entry points.
- Remove or de-emphasize older tree traversal helpers that now duplicate `find` or `grep`.
- Route missing-file remediation through `ls`, `find`, `grep`, and codewiki rather than bespoke search paths in each tool.

## Orchestration Features

- Add scout/fresh/fork context orchestration after basic tool parity, using explicit domain contracts instead of inflating the core tool layer.
- Add optional tilldone/task-list workflow discipline as an extension or recipe so basic coding-agent operation remains lightweight.
- Keep fleet orchestration behind dispatch/scheduling contracts with observability and reproducibility hooks.

## Verification Strategy

- Prefer small commits with narrow tests for each simplification.
- For core tool parity, run `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` before publishing a slice.
- For simplification refactors, add boundary tests when moving responsibilities across domains.
