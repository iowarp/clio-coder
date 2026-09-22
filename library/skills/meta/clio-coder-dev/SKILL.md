---
name: clio-coder-dev
description: "Develop Clio Coder inside its own repository: trace source contracts, implement bounded changes, coordinate sprint work, and preserve running-agent and session correctness. Use before changing Clio source, prompts, tools, or library; pair with clio-coder-test for validation."
triggers:
  - develop Clio in its own repository
  - implement a Clio sprint packet
  - change Clio context or session lifecycle
  - edit Clio skills tools or prompts
version: 0.5.0
license: Apache-2.0
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/meta/clio-coder-dev
  audit: pass
  provenance: designed
  model-size: any
---

# Clio self-development

Use this workflow when the requested task changes Clio itself. The canonical
name is `clio-coder-dev`. In a detected Clio checkout,
the source skill is natively discoverable unless an installed package owns its
name. Discovery does not mean its body has already been loaded.

## Establish the actual assignment

Read `CONTRIBUTING.md`, applicable repository instructions, and the user's
assigned packet or issue. Check cwd, branch, status, and the base commit before
editing. Use the detected repository root even when launched from a subdirectory
or worktree. A Clio npm installation or an unrelated nested repository is not a
self-development checkout.

Distinguish design, implementation, review, and validation. Deliver the phase the
user authorized. A comprehensive sprint plan does not launch implementation.
Existing authorization persists: do not demand a second confirmation for an
already authorized action. Complete authorized local work and verification;
remote writes and release actions need matching user intent and repository rules.

## Trace the behavior before changing it

Find the owning source and current callers with `rg`, then read its contract,
nearby tests, and relevant architecture guide. Use code navigation when available
for symbol/caller relationships; read exact source before changing semantics.
Treat handbooks, generated wiki, and old sprint reports as navigation aids.
`CLIO-CODER.md` may be absent or ignored; do not regenerate project context simply
because you are developing Clio.

Choose a checkable before/after behavior and its smallest useful integration
boundary. Put pure policy next to the owning domain; compose dependencies at the
entry seam. Preserve these enforced boundaries:

- Pi package imports, including types, stay in `src/engine/**`.
- Worker domain value imports stay within declared provider rehydration seams.
- Domains communicate through contracts, never another domain's `extension.ts`.
- Tools do not import interactive UI; turn-runtime modules do not import entry.
- Keep the protected instant-shell graph and lazy CLI imports within their seams.

For source maps and high-risk lifecycle changes, read
[references/change-map.md](references/change-map.md). Do not widen tool authority,
worker write scope, memory applicability, or release claims to simplify a change.

## Implement and verify against the requested scope

Load `clio-coder-test` through the normal skill interface when choosing checks.
If it is unavailable, use the checkout's `CONTRIBUTING.md` and package scripts;
continue the assignment without an installation detour. The two skills are
companions, not a recursive required-loading chain.

Prefer meaningful regression tests for changed contracts. For a documentation
or instruction-only edit, verify the facts, links, and package metadata without
inventing runtime tests for prose. For skills, update the manifest version, then
regenerate both skill and full-library pins.
Active installed resource trees remain operator-managed: edit curated source
under `library/`, not `.clio-coder/plugins`, config plugins, or a symlink to them.

A source edit does not change the running agent's loaded ESM modules. Build and
dogfood a candidate in an isolated worktree when the main checkout's `dist/` may
back the running CLI. Restart a separate candidate process; do not replace the
active installation, relink the CLI, or mutate real user state as a test shortcut.

## Working from a sprint packet

Read the packet and its approval/status record before coding. If delegation was
authorized, give each worker a bounded result, exact base/worktree, owned files,
required checks, and report path. Pass skill bindings through the worker recipe
when available; do not assume the parent model's loaded skills reach the worker.
An instruction in this skill is not itself authorization to spawn workers.

Ignored `.superpowers/` plans do not appear in a new Git worktree. Supply the
absolute packet path or a scoped copy of the necessary briefing. Keep each
worker's write scope inside its assignment; the orchestrator owns shared seams,
review, and serialized integration. Preserve authorized uncommitted work and
record unfinished work in a handoff instead of broad staging or cleanup.

## Finish with evidence

State what changed, why, the exact checks and outcomes, and remaining limitations.
Distinguish source tests, built-process tests, installed-package tests, and actual
model evidence. Update user docs/changelog only for implemented behavior. For a
long-running task, update the assigned status/report with branch, commits,
authority, evidence refs, and next action. Use `context-handoff` only when a
handoff is needed; do not turn every local change into a separate interview,
release, or repository initialization workflow.
