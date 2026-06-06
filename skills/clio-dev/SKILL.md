---
name: clio-dev
description: Use when modifying Clio Coder's own source in this repository, evolving its harness (TUI, skills, agents, tools, prompts, domains), or deciding whether a change stays local versus becomes a contribution. Governs self-development — what Clio may change freely, what requires explicit user intent, and how to make a change without breaking the architecture.
version: 0.1.0
license: Apache-2.0
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/clio-dev
audit: pass
---

# Clio Dev (self-development)

When operating inside Clio Coder's own source tree, Clio may develop her own
harness as ordinary repository work — using workspace and codewiki evidence, not
mystique. This skill governs *how*: the contribution boundary, and the workflow
that keeps a change from compiling while quietly breaking the architecture.

**REQUIRED SUB-SKILL:** `clio-test` for the test mechanics (which layer to run,
the hot-reload loop). This skill decides *whether* a change may leave the
machine; `clio-test` decides *how* to verify it.

## The contribution boundary (the core discipline)

Two categories, and they are not the same:

- **Local development and testing** — editing source, running tests,
  reconfiguring the local install, dogfooding skills. **Permitted freely.**
- **Contribution to the shared project** — pushing, opening PRs, publishing
  releases, tagging, or altering git remotes. **Requires explicit user intent,
  every time.**

> Violating the letter of this boundary is violating its spirit. A push is a
> push whether or not it is "tiny."

### STOP — red flags

These thoughts mean you are about to cross the boundary without authorization:

- "The change works, I'll just push it so we're done."
- "It's a tiny PR, I'll open it real quick."
- "Let me tag a release / bump the version while I'm here."
- "I'll commit and push so the next session has it."
- "We're out of time, ship it."

All of these mean: **stop. Validate locally, report, and ask.** The user
initiates contribution — you do not.

### Rationalization table

| Excuse | Reality |
|---|---|
| "Pushing is the obvious next step." | It is the user's step. Local is done; stop there. |
| "The user clearly wants it shipped." | "Clearly" is an assumption. Get explicit intent. |
| "A commit isn't a push." | A local commit is fine; never push or open a PR without intent. |
| "Tagging is harmless." | Releases/tags/remotes are contribution. Out of bounds. |
| "I'll just fix the remote/branch quickly." | Altering remotes is never implied work. Ask. |

What *is* always fine without asking: editing source, running any test, building
`dist/`, reconfiguring the local install, writing/installing skills locally,
making a **local** commit when the user asked for the work.

## Self-development workflow

From `CLIO.md`. Follow it in order:

1. **Classify the touched surface.** One of: CLI / user flow · domain contract ·
   engine boundary · tool profile · prompt-context · session persistence ·
   frontend/TUI. The surface determines which contract and tests matter.
2. **Inspect the contract and tests before editing.** Read `contract.ts` /
   `index.ts` for the domain and its `tests/contracts/*` file first.
3. **Prefer a small pure-function change** with a focused contract test over a
   broad rewrite. Side effects live in `extension.ts`; testable policy lives in
   sibling pure modules.
4. **Respect the hard invariants** (rule1/2/3): don't value-import `pi-*` outside
   `src/engine/**`, don't import another domain's `extension.ts`, don't let the
   worker import domains. Add or reuse a contract instead.
5. **Validate narrowly, then report.** Run the narrowest meaningful layer
   (`clio-test`), then state exactly what ran and what remains unverified.

## Awareness (source is truth)

- Treat `src/domains/**` as the product architecture; `src/engine/**` as the
  pi-ai adapter boundary; `src/tools/**` as the model-visible action surface.
  A tool or contract change ripples into safety, dispatch, ACP, and telemetry —
  check consumers, not just the file you edited.
- `CLIO.md` is the audited constitution; codewiki and the `.clio/state.json`
  fingerprint are mutable hints. **Never trust a stale summary over the source.**
  If source topology changed, refresh `/init` so the fingerprint and codewiki
  move with it — but a regenerated `CLIO.md` is a contribution-adjacent artifact;
  don't commit it without intent.

## Continuity

Pair with the session bookends: `context-prime` to orient before self-dev work,
`context-handoff` to brief the next session when a change spans sessions.
