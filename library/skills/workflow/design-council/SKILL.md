---
name: design-council
description: Convenes several expert perspectives that challenge each other on a design decision with real trade-offs before code is written; quick mode runs a single round. Not for a one-question-at-a-time interrogation of a plan; use plan-interview. Not for splitting implementation across workers; use dispatch directly.
triggers:
  - convene a design council
  - debate this design
  - get multiple expert perspectives
  - weigh the architecture options
  - what would experts say
version: 0.6.3
license: Apache-2.0
allowed-tools:
  - dispatch
  - read
  - grep
  - find
  - ls
  - context
  - code_nav
  - ask_user
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/workflow/design-council
  audit: pass
  model-size: large
  agents:
    - scout
    - researcher
    - provenance
---

# Design Council

Run a bounded multi-perspective debate on a real design decision. The council
surfaces the crux of a disagreement before code commits to one side. It is not
a ritual: if experts would agree, do not convene it.

## Arguments

**Headless is the enforced default, not a suggestion.** `ask_user` is not
registered in a headless run, so the single question Step 1 asks is refused as
an unregistered tool rather than answered. Treat that refusal (or skip the
call and reason from this paragraph directly — one is not more valid than the
other) as the fixed answer **quick mode: exactly three perspectives, exactly
one round (Positions) plus synthesis.** Do not compose four or five
perspectives headlessly and do not run a Responses or Convergence round
headlessly, no matter how contested the topic looks. This is the one rule the
skill's own prior smoke history says a model will not reliably self-infer from
prose alone, so treat the number 3 and the number 1 as hard, not as defaults
to raise if the topic seems to deserve more.

**Dispatch call shape.** Compose the round's perspectives, then make exactly
one `dispatch` call with all of them in `tasks` and `mode="parallel"`. If
that call comes back admission-denied for endpoint or target capacity, retry
the identical `tasks` batch in one dispatch call with `mode="sequential"`
instead — the tool runs them one after another itself. Never split a round
into several separate one-task `dispatch` calls made one at a time waiting on
each result before deciding the next. Do not call `dispatch(list:true)` to
probe capacity first.

Declare `intent: {read_roots: [...], relevant_paths: [...]}` with paths
relative to the repo root on every dispatch call instead of pasting an
absolute path into `task`/`briefing` prose (a config value, a mount point).
An absolute path token in briefing/task text with no declared `intent` is
rejected as `legacy_scope_path_absolute`.

A dispatch call's own synchronous result already carries every worker's
output — do not follow it with a `bash`/`read` pass over the receipt file on
disk to re-read what you already have. The steps below are the plan; do not
open a `tasks` list for them. This skill's tool surface is exactly
`dispatch`, `read`, `grep`, `find`, `ls`, `context`, `code_nav`, and
`ask_user` (`context` and `ask_user` are always available regardless).
`tasks` and `bash` both sit outside it and any call to either is refused —
locate files with `find`/`ls`, not `bash find`/`bash ls`; inspect a receipt
with `read`, not `bash cat`. This skill never writes: `write` and `artifact`
are not on its surface, so the synthesis in Step 4 is chat output, never a
file.

## Step 0 — Check the question is contested

Before composing anyone, ask: would credible experts actually disagree on the
answer? If every perspective you can imagine picks the same option and differs
only in caveats, stop here — do not dispatch anything. Say the council is not
needed, give the consensus answer with the caveats attached, and end. Do not
dispatch a round "just to confirm" a consensus call you already reached.

## Step 1 — Compose perspectives

Derive perspectives from the topic itself, never from a generic role menu.
On a genuinely contested topic, call `ask_user` once with `mode:
"single_question"` asking whether this should be a quick pass (three
perspectives, one round) or the full debate (up to five perspectives, up to
three rounds). See Arguments for what a headless run does with that call.
In a live session where the user answers, honor the requested depth. Compose
three perspectives by default; go to four or five only in that live full-
debate case, and only when the decision genuinely has that many independent
stances.

Each perspective gets:

- a name and a stance (what it argues for);
- the expertise it argues from;
- the specific thing it must attack in the other positions.

## Step 2 — Dispatch each perspective as a read-only worker

The recipe fixes capability; your task prompt supplies the persona. Pick per
perspective from the read-only recipes in the live catalog:

- `scout`: stance grounded in this repository's code.
- `researcher`: stance leaning on external docs, standards, or papers.
- `provenance`: stance arguing from runtime evidence and receipts.

See Arguments for the exact call shape (one batched `tasks` call, the
`mode="sequential"` capacity fallback, `intent` for scope, no literal shell
syntax). Rounds are sequential; a round's own perspectives are the one
dispatch call. Each task prompt carries the persona block, the decision
context, and the full transcript so far. Workers never edit files; the
debate is analysis only.

## Step 3 — Run the rounds

1. **Positions.** Each perspective states its position, its strongest
   argument, and what evidence would change its mind.
2. **Responses.** Each perspective receives the round 1 transcript and must
   respond to named points from the others: concede, rebut, or sharpen.
3. **Convergence.** Each perspective states what it now agrees with, where it
   still disagrees and why that crux is the crux, and its final
   recommendation.

**Quick mode** (headless default, or a user asking for a light pass): round 1
plus synthesis. No responses round, no convergence round.

In full-debate mode, after round 1, read references/early-termination.md.

## Step 4 — Synthesize

After the last round, you (the orchestrator) write the synthesis. When writing
it, read references/synthesis-format.md for its shape.

Cite the transcript (perspective and round) for every claim. Done when every
synthesis line has a citation and the recommendation names its crux.

## References

- When the request names a path or leaves the decision unclear, read references/invocation.md.
- When topic-derived stances are not obvious, read references/perspective-example.md.
- When dispatch is missing or every retry is denied, read references/degraded-mode.md.
- When the request may fit another tool better, read references/boundaries.md.
- When a rule's reason is in question, read references/rationale.md.
- Before reporting the synthesis, read references/red-flags.md.
