---
name: prototype
description: Use when a design question should be answered with throwaway code — "does this state model feel right", "sanity-check this logic", "what should this UI look like", "mock something up". Builds a clearly-marked, trivially-runnable, no-persistence prototype, then captures the verdict and discards the code. Not for pre-registered performance experiments; use experiment-protocol. Not for production implementation.
triggers:
  - throwaway prototype
  - mock up this UI
  - prototype this state model
  - sanity-check this logic
  - what should this UI look like
version: 0.2.1
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - find
  - ls
  - git
  - bash
  - write
  - ask_user
  - artifact
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/coding/prototype
  audit: pass
  provenance: adapted
  origin: https://github.com/mattpocock/skills/tree/main/skills/engineering/prototype
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
---

# Prototype

A prototype is throwaway code that answers a question. Name the question
first; the question decides the shape.

## Step 1 — Pick the branch

From the user's prompt, the surrounding code, or by asking:

- **"Does this logic / state model feel right?"** → read
  `references/LOGIC.md`. Build a single shareable HTML file — free-play
  controls plus guided walkthroughs — that pushes the state machine through
  the cases that are hard to reason about on paper, drivable by a
  non-developer.
- **"What should this look like?"** → read `references/UI.md`. Generate
  several radically different UI variations on one route, switchable via a
  URL parameter.

The branches produce very different artifacts; getting this wrong wastes
the prototype. Ambiguous and the user unreachable → default by neighborhood
(backend module → logic; page or component → UI) and state the assumption
at the top of the prototype.

## Step 2 — Build under the prototype rules

1. **Throwaway from day one, marked as such.** Place it near the code it
   prototypes for, named so a casual reader sees it is not production.
   Follow the project's existing routing/layout conventions; invent no new
   top-level structure.
2. **Trivial to run.** One command in the project's own task runner, or one
   double-clickable HTML file. No setup thinking required.
3. **No persistence.** State lives in memory. If the question is itself
   about a database, use a scratch DB or file named "PROTOTYPE — wipe me".
4. **Skip the polish.** No tests, no error handling beyond runnable, no
   abstractions. Speed of learning is the only quality bar.
5. **Surface the state.** After every action (logic) or variant switch
   (UI), print or render the full relevant state so the change is visible.

## Step 3 — Capture and discard

When the question is answered:

1. Fold the validated decision into the real code or the relevant plan.
2. Commit the prototype to a throwaway branch off the main line, and leave
   a pointer to that branch wherever the work is tracked (issue, plan,
   handoff).
3. Record the verdict and the question it settled in the same place.
4. The main branch keeps only the validated decision — never the prototype.

Done when the verdict is recorded, the pointer exists, and no prototype
code remains on the working branch.

## Red flags

- A prototype quietly growing tests, error handling, or abstractions — it
  is becoming production without a decision.
- Persistence added "just to make it work".
- The prototype merged to the main line.
- Code built before the question was stated.
