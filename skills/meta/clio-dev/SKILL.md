---
name: clio-dev
description: Use when modifying Clio Coder's own source in this repository, evolving its harness (TUI, skills, agents, tools, prompts, domains), or deciding whether a change stays local versus becomes a contribution. Governs self-development — what Clio may change freely, what requires explicit user intent, and how to make a change without breaking the architecture.
triggers:
  - modify Clio Coder
  - change the Clio harness
  - edit Clio skills or agents
  - evolve Clio tools or prompts
  - Clio contribution boundary
version: 0.2.2
license: Apache-2.0
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/meta/clio-dev
  audit: pass
  provenance: designed
  eval-status: scenarios-recorded
  model-size: any
---

# Clio Dev (self-development)

Working inside Clio Coder's own source tree is ordinary repository work with
one extra discipline: the contribution boundary. This skill governs that
boundary and the change workflow.

**REQUIRED SUB-SKILL:** `clio-test` for test mechanics (which layer to run,
the hot-reload loop). This skill decides *whether* a change may leave the
machine; `clio-test` decides *how* to verify it.

## The contribution boundary

Two categories. They are not the same:

- **Local development and testing**: editing source, running tests,
  reconfiguring the local install, dogfooding skills, making a local commit
  when the user asked for the work. **Permitted freely.**
- **Contribution to the shared project**: pushing, opening PRs, publishing
  releases, tagging, or altering git remotes. **Requires explicit user intent,
  every time.** No exception for "tiny" changes.

### STOP — red flags

Any of these thoughts means you are about to cross the boundary. Stop,
validate locally, report, and ask:

- "The change works, I'll just push it so we're done."
- "It's a tiny PR, I'll open it real quick."
- "Let me tag a release / bump the version while I'm here."
- "I'll commit and push so the next session has it."
- "We're out of time, ship it."

### Rationalization table

| Excuse | Reality |
|---|---|
| "Pushing is the obvious next step." | It is the user's step. Local is done; stop there. |
| "The user clearly wants it shipped." | "Clearly" is an assumption. Get explicit intent. |
| "A commit isn't a push." | A local commit is fine; never push or open a PR without intent. |
| "Tagging is harmless." | Releases/tags/remotes are contribution. Out of bounds. |
| "I'll just fix the remote/branch quickly." | Altering remotes is never implied work. Ask. |

## Self-development workflow

Follow in order for every change:

1. **Classify the touched surface.** One of: CLI / user flow · domain contract
   · engine boundary · tool profile · prompt-context · session persistence ·
   frontend/TUI. The surface determines which contract and tests matter.
2. **Read the contract and tests before editing.** Open the domain's
   `contract.ts` / `index.ts` and its `tests/contracts/*` file first.
3. **Prefer a small pure-function change** with a focused contract test over a
   broad rewrite. Side effects live in `extension.ts`; testable policy lives
   in sibling pure modules.
4. **Respect the hard invariants** (rule1/2/3): no value-import of `pi-*`
   outside `src/engine/**`; no importing another domain's `extension.ts`; the
   worker never imports domains. Add or reuse a contract instead.
5. **Validate narrowly, then report.** Run the narrowest meaningful layer per
   `clio-test`, then state exactly what ran and what remains unverified. Done
   when the report names both.

## Source is truth

- `src/domains/**` is the product architecture, `src/engine/**` the pi-ai
  adapter boundary, `src/tools/**` the model-visible action surface. A tool or
  contract change ripples into safety, dispatch, ACP, and telemetry: check the
  consumers, not just the file you edited.
- `CLIO-CODER.md` is the audited constitution; codewiki and the `.clio-coder/state.json`
  fingerprint are mutable hints. Never trust a stale summary over source. If
  source topology changed, refresh via `clio-coder context init` — but a regenerated
  `CLIO-CODER.md` is contribution-adjacent; do not commit it without intent.

## Continuity

Pair with the session bookends: `context-prime` to orient before self-dev
work, `context-handoff` to brief the next session when a change spans
sessions.
