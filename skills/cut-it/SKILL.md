---
name: cut-it
description: Use when a plan, PRD, or milestone must become an executable sprint — dependency-ordered vertical slices sized for one focused agent run each, with done-when verification per slice. Never fabricates a plan; if none exists or it is too vague to slice, says so and recommends an interview first. Triggers on "cut it", "slice this plan", "make this executable", "turn this into a sprint".
version: 0.1.0
license: Apache-2.0
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/cut-it
audit: pass
---

# Cut It

Transform an existing plan into ordered execution slices that a coding agent
can run one at a time, leaving the build green after every slice. The output
is a `SPRINT.md` another agent can execute cold — no conversation context
required.

Adapted from the community `cut-it` skill (TheOrcDev/skills), shaped to Clio's
agent fleet and sprint conventions.

## Step 1 — Locate the plan

In priority order: a file the user names, a plan in the conversation,
`PLAN.md` / `PRD.md` / `milestones/*/prompt.md` in the repo. **Never fabricate
the plan.** If none exists, or what exists is too vague to slice honestly,
stop and say so — recommend `grill-me` to resolve intent first. Artificial
slicing of a vague plan hides gaps; flagging them is the deliverable.

## Step 2 — Apply the cutting rules

- **Vertical slices.** Each slice delivers end-to-end behavior, however thin.
  No "all the types first, all the wiring later" horizontal layers.
- **Dependency order.** A slice may depend only on earlier slices. State the
  dependency explicitly.
- **One agent run each.** Sized so a focused agent completes it in a single
  run: small enough to hold in context, large enough to be meaningful.
- **Green after every slice.** Build, lint, and existing tests pass at every
  cut point. A slice that leaves the tree broken is two slices cut wrong.
- **Self-contained.** Real file paths, real commands, concrete steps. A reader
  with zero conversation context can execute it.

## Step 3 — Write the artifact

Default output is `SPRINT.md` at the repo root (honor a caller-supplied path).
Format:

```markdown
# Sprint: <name>

## Battle order
1. <slice 1 title>
2. <slice 2 title>  (depends on: 1)
...

## Slice 1 — <title>
**Goal**: <the behavior this delivers>
**Depends on**: <slice numbers or "nothing">
**Files**: <paths touched>
**Steps**:
1. <concrete step with real paths/commands>
**Done when**: <observable, testable criteria — the verification anchor>
**Out of scope**: <what this slice deliberately does not do>
```

"Done when" is the contract, not decoration. If you cannot write a testable
done-when for a slice, the slice is not ready to cut — go back to the plan.

## Red flags (you are doing it wrong)

- A slice whose steps say "and related changes" or "etc."
- Done-when criteria that restate the goal instead of naming a check.
- A slice that only compiles when a later slice lands.
- Slicing a plan you had to invent on the spot.
