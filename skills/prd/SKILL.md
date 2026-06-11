---
name: prd
description: Use when the user wants to turn an idea into a product requirements document through a phase-gated interview — each phase locks before the next opens — ending in PRD.md plus per-milestone prompt files ready to drive a coding agent. Triggers on "write a PRD", "spec this out", "help me define this feature/product", or a brain dump that needs structure before planning.
version: 0.2.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - glob
  - ls
  - find
  - git
  - workspace_context
  - code_nav
  - write
  - edit
  - ask_user
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/prd
audit: pass
---

# PRD

Guide the user from a raw idea to a locked product spec and executable
milestone prompts. The discipline is the phase gate: each phase produces a
small locked artifact that the next phase builds on. No phase reopens without
the user saying so.

Adapted from the buildermethods `bm-prd-creator` flow, made native to Clio:
markdown only, no external templates, repo-aware.

## Interview mechanics

- Use the `ask_user` tool for every confirmation and choice, with your
  recommendation as the first option. Without `ask_user`, ask in plain text,
  one focused exchange per phase.
- **Read the repo before asking.** Stack, conventions, existing entities, and
  integrations are facts; discover them and *confirm*, never ask cold.
- Keep each phase to one or two exchanges. Synthesize, propose, lock, move on.

## The phases (in order, each locks before the next)

1. **Brain dump.** Let the user describe the idea raw. Do not structure yet;
   capture it.
2. **Core purpose.** Synthesize a 1–3 sentence mission statement. Confirm.
3. **Top-level features.** Propose 4–8 in-scope features derived from the
   dump. Confirm the set.
4. **Out of scope.** Propose explicit v1 cuts — what this deliberately does
   not do. This list prevents scope creep later; make it real.
5. **Stack and foundation.** Detect the stack from the repo (manifests, lock
   files, configs); confirm it and inventory what foundation already exists.
6. **Integrations and credentials.** Map external services and the API
   keys/credentials each requires. Note which exist versus which the user
   must provision.
7. **Data model.** Entities, fields, and relationships in plain language.
   Reuse existing repo entities where they fit.
8. **Per-feature scoping.** For each locked feature: granular in/out
   boundaries. This is where v1 honesty lives.
9. **Milestones.** Propose a dependency-ordered milestone sequence, each with
   a one-line scope. Confirm.

## Output artifacts (phase 10 — write files)

- **`PRD.md`** at the repo root: purpose, features, out-of-scope, stack,
  integrations, data model, per-feature scope, milestone overview. Markdown
  only.
- **`milestones/N-<slug>/prompt.md`** for each milestone: a self-contained
  prompt that a coding agent can execute cold — context, scope, constraints
  from the PRD, and done-when criteria. A reader must not need the PRD open
  to act on it.

Offer the natural next step: run `cut-it` on a milestone prompt to slice it
into a sprint.

## Red flags (you are doing it wrong)

- Asking about the stack when package.json answers it.
- A phase "locked" without the user confirming it.
- Out-of-scope list that is empty or generic ("no mobile app").
- Milestone prompts that say "see PRD for details".
