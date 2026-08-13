---
name: architecture
description: 'Use when an intent (PRD, epic, brief, or idea) needs its engineering approach decided — "how should we build this", "pick the stack", "architecture for this feature". An interactive working session: investigates, proposes 2-3 genuinely different approaches with trade-offs, recommends with reasoning, lets the user decide, and writes a high-level architecture decision doc. Not a task-by-task plan; use cut-it for that. Not a multi-perspective debate; use design-council. Not product intent; use product-intent.'
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - find
  - ls
  - git
  - context
  - code_nav
  - web_fetch
  - write
  - ask_user
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/planning/architecture
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/architecture
  eval-status: untested
  model-size: large
  agents:
    - main
---

# Architecture

The intent says what and why; this session decides how: approach, stack,
data shape, boundaries, and what to de-risk first. The deliverable is a
high-level decision doc — the moment you start listing file edits or task
steps, you have gone too deep; pull back up to the decisions.

This is interactive. Run the loop out loud with the user, via `ask_user`:

```
investigate → 2-3 options with trade-offs → recommend + reasoning →
ask → wait for their call → go deeper
```

Never converge silently. Optimize for the user's goals, familiarity (a
stack they know beats a "better" one they don't), leanness (decide only
what is needed to move), and reversibility (spend deliberation on the
expensive calls only).

## Step 0 — Ground

Read the intent (PRD path, brief, or the user's words). Read any reference
docs passed alongside; if none were passed, ask whether any exist — the
context needed is usually already written down.

## Step 1 — Greenfield or brownfield

Infer from the input and workspace; genuinely unclear → ask. It changes the
exploration:

- **Greenfield**: explore the solution space — approaches, current best
  practice (web_fetch when it materially helps), first principles.
- **Brownfield**: read the relevant existing surfaces first — where this
  plugs in, what it reuses, what it must not break. High-level read, not a
  file audit.

## Step 2 — Explore, decision by decision

For each area, surface options, recommend with reasoning, ask, record the
user's call. Skip what does not apply and say that you skipped it:

- **Approaches**: 2-3 genuinely different directions with trade-offs.
- **Stack & libraries**: what and why (fit, maturity, familiarity), with
  alternatives named.
- **Data model**: main entities, relationships, storage — shape level, not
  columns and migrations.
- **Boundaries & contracts**: auth posture, secrets, external services,
  the API/integration boundaries crossed. Flag, never gloss.
- **Missing pieces**: what has to exist that does not yet.
- **Spikes**: any uncertain or one-way-door call gets a spike, not a guess:

  ```
  Question:      <what we are unsure about>
  Spike:         <smallest thing to build/test> over <timebox>
  Decision rule: <X> if <signal> / <Y> if <counter-signal>
  ```

  Reversible cheap calls: just decide and move on.

## Step 3 — Write the decision doc

Only after the calls are made. Default location: `docs/architecture-<slug>.md`
(or folded into the PRD as an `## Architecture` section when the user
prefers one document; a tracker page when the user names one and an
integration exists). Shape:

```markdown
# Architecture — <intent name>

## Problem & goals        (one paragraph, the lens for every decision)
## Approaches considered  (the 2-3 directions with trade-offs)
## Recommended approach   (the shape of the solution; brownfield: where it
                           plugs in and what it reuses)
## Key decisions          (stack+why, data model shape, boundaries,
                           other eng-lead calls; skipped areas noted)
## Missing pieces
## Spikes & experiments   (each with its decision rule)
## Open questions         (deliberately deferred, with what settles each)
```

## Done when

The doc exists at a confirmed location, every section is either filled or
explicitly marked skipped, every one-way-door call has a spike or a user
decision, and the user has been offered the next moves without a forced
pipeline: slice into tickets (`backlog`), slice into a local
sprint (`cut-it`), spike a flagged risk now, or keep refining here.

## Red flags

- A document produced in one shot with no user calls in between.
- One foregone conclusion instead of real alternatives.
- File-by-file edit lists (that is cut-it's altitude).
- A one-way door decided by vibe instead of a spike.
