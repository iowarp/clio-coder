---
name: plan-create-prd
description: Use at the start of a greenfield product effort, when the user wants a problem-first product document — "why are we building this", "write the product thesis", "PRD for this idea". Interviews for the problem, evidence, and a falsifiable hypothesis; writes an intent-only PRD with zero engineering decisions. Not for engineering decisions; use plan-architecture. Not for turning a locked idea into milestone build prompts; use prd.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - find
  - ls
  - git
  - context
  - write
  - ask_user
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/plan-create-prd
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/plan-create-prd
  eval-status: untested
  model-size: large
  agents:
    - main
---

# Create PRD (intent, not instructions)

A PRD is intent: the problem and the hypothesis about solving it, in a form a
team can challenge before building and judge after shipping. Engineering
decisions (library, data model, boundaries) never enter it; they belong to
`plan-architecture`.

Two hard guards, checked before writing anything:

1. **Intent-framed.** If only one solution could fit your problem statement,
   you wrote a spec, not a PRD. "Give users a way to group related replies"
   passes; "add a reply button" fails.
2. **Never invent requirements.** Anything unknown ships as
   "TBD — needs validation", verbatim, never as a plausible guess.

## Step 0 — Ground in evidence

If the user passed reference docs (interviews, support tickets, analytics,
competitor notes), read them first and treat them as evidence. If none were
passed, ask whether any exist before interviewing.

## The interview

Ask in clusters via `ask_user`, and GATE: post the cluster, stop, wait for
answers. Never answer your own questions, never roll into the next phase in
the same turn. Thin answers get reflected back and dug into.

If the user declines the interview ("just write it"): honor it, name what
you will have to leave TBD, ask only the two or three highest-leverage
questions, and mark everything else "TBD — needs validation".

1. **Initiate.** Input given → restate and confirm. Blank → "What do you
   want to build? A few sentences." GATE.
2. **Foundation.** Who has the problem (a specific role, not "users")? What
   is the observable pain? How do they cope today (workaround, competitor,
   tolerating)? Why now? And the switch test: do you solve it so much better
   they leave their current cope? No switch case → no product yet; say so.
   GATE.
3. **Users.** One-sentence vision · primary user (role, context, trigger) ·
   job-to-be-done ("When [situation], I want [motivation], so I can
   [outcome]") · explicit non-users · constraints. GATE.
4. **Hypothesis.** Co-write the falsifiable bet. The WRONG condition is the
   most-skipped line and the one that makes it a hypothesis:

   ```
   We believe [change] will cause [users] to [do Y], resulting in [outcome].
   RIGHT if [leading signal] within [timeframe].
   WRONG if [counter-signal / a guardrail moves].
   ```

   No hypothesis ships without a WRONG condition. GATE.
5. **MVP and doors.** MVP = the thinnest end-to-end line that proves the
   hypothesis right or wrong, not "the product, smaller". Mark each major
   call two-way door (reversible → just build) or one-way door (expensive to
   undo → flag for a spike in plan-architecture). GATE before generating.

Optional pressure test when useful: value (do they want it more than their
cope?), usability, feasibility, viability. Most ideas over-argue feasibility
and under-argue value.

## Generate

Write to `docs/<kebab-slug>.prd.md` (slug from the core idea; repo root if
no `docs/`; a user-supplied path always wins). Never hardcode `PRD.md` — a
second PRD must not overwrite the first. Sections, scannable, product only:

1. **Problem statement** — who, what pain, cost of not solving it.
2. **Evidence** — quote/data/observation, or "Assumption — validate via
   [method]".
3. **Thesis** — why this, why now, why it beats the current cope.
4. **Hypothesis** — the RIGHT/WRONG block, verbatim.
5. **Target user & JTBD** — plus non-users.
6. **MVP** — the thinnest proving line.
7. **Success metrics** — outcome-shaped: metric · target · how measured.
   "Engagement" is not a metric.
8. **Non-goals.**
9. **Open questions** — named checkboxes, never hidden.

## Done when

The file exists; the summary to the user leads with thesis and hypothesis,
counts evidenced-vs-assumed claims and open questions; and the next step is
offered: `plan-architecture` for the engineering decisions this PRD
deliberately left open. Failing any of the five tests below means not done:
evidence-grounded problem · hypothesis with separate RIGHT and WRONG ·
outcome-shaped metrics · explicit non-goals · zero engineering decisions.
