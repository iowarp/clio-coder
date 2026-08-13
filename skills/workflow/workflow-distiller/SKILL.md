---
name: workflow-distiller
description: Use when a workflow that just happened should become reusable, when the user says "make this a skill", "package what we just did", "turn this into a workflow", or when the same multi-step process has been repeated across sessions. Reconstructs the workflow from the session record, interviews, checks overlap with installed skills, gates on approval, then writes the SKILL.md following skill-craft. Not for authoring a skill from scratch with no prior workflow; write the SKILL.md directly following skill-craft. Not for distilling into an agent recipe; propose that as a follow-up when the workflow is dispatch-shaped.
version: 0.2.1
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - find
  - ls
  - context
  - write
  - ask_user
requires:
  - skill:skill-craft
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/workflow/workflow-distiller
  audit: pass
  provenance: designed
  eval-status: smoke-checked
  model-size: large
---

# Workflow Distiller

Turn a workflow that actually ran into a reusable skill. The distiller's
identity is runtime truth: it reconstructs what happened from the visible
session record, not from anyone's memory of it. Skip the ceremony when there
is no prior workflow; a from-scratch skill is a SKILL.md written directly,
following skill-craft. skill-craft also governs how every skill this
distiller produces is written: description, body, and pruning rules live
there, not here.

## Phase 1 - Reconstruct From Evidence

Before asking anything, list the concrete steps that visibly executed in this
session, in order: tools called, commands run, files touched, dispatches made,
skills activated. Cite the conversation record for each step. Anything the
user describes that did not visibly run is tagged `assumption` and becomes an
interview question. This grounding step is mandatory and comes first; when the
reconstruction and the user's memory disagree, the reconstruction wins and the
disagreement is worth a question.

## Phase 2 - Interview

Use `ask_user` with `mode: "single_question"`, one question per round, bounded
rounds (default 8, max 12), following the grill-me operating contract:
recommended answer first when options are natural, stop signals ("stop",
"enough", "later", cancel) respected immediately, answers translated into
compact decisions. Question bank, roots before leaves:

1. Confirm the reconstruction and resolve tagged assumptions.
2. Inputs and outputs: what varies between runs, what is fixed.
3. Recurrence: how often has this actually happened? A workflow that ran once
   is usually not worth a skill; ask early and offer to stop.
4. Per-step rigidity: must-match versus any-reasonable-approach.
5. Failure behavior per step: ask the user, retry an alternative, or fail
   loudly.
6. Scope cuts: what the skill should refuse to do.
7. Name (lowercase-hyphen).

## Phase 3 - Overlap Check

Call `context(scope="skills")` with no name to list installed skills. Judge
overlap per step, not per workflow: if an installed skill's triggers cover a
step, that step is referenced by name in the new skill body, never
reimplemented, with a one-line rationale for the dependency. A different end
goal does not excuse reimplementing a covered step. Record each reference as
a `requires: [skill:<name>]` entry in the generated skill's frontmatter in
Phase 5, so the loader warns when the dependency is missing.

## Phase 4 - Design Gate

Present a compact design summary and wait for explicit approval:

```markdown
## Skill Design - <name>
Description draft: <triggers only, third person>
Steps: <step, rigidity, on-failure> per line
References: <skill:<name>, why> or none
Scope: project | user (user only if the workflow crosses repositories)
Validation scenario: <prompt, expected observable behavior>
```

No skill file is written before the user approves. "Looks fine, but change X"
means revise and re-present.

## Phase 5 - Create

Write `SKILL.md` under `.clio/skills/<approved-name>/`, following skill-craft
for the frontmatter contract, a triggers-only third-person description, and
the pruning pass, with `requires: [skill:<name>]` for every skill the overlap
check referenced. Confirm it loads with `clio skills validate`. Scope
defaults to project; use the user skill store only when the user said the
workflow crosses repositories. Placeholders replace every session-specific
path, name, and value; distill the pattern, not the incident. Keep the
generated skill under 120 lines; reference instead of inlining. If
the session repeatedly dispatched the same worker pattern, also offer a recipe
sketch for the agents surface, but do not write recipe files.

## Phase 6 - Validate

Record one RED-GREEN scenario agreed with the user: the prompt, and the
observable behavior that distinguishes with-skill from without. Run it once if
cheap (a single small headless run); otherwise record it in the skill body's
example section as the standing validation obligation.

## Worked Example

Session: the user fetched a CSV export, normalized column names with a small
script, and verified row counts against the source, three sessions in a row.

1. Reconstruct: `bash curl ...` (ran), `write normalize.py` + `bash python3
   normalize.py` (ran), `bash wc -l` comparison (ran). User also mentions "and
   I always spot-check five rows" - not visible this session, tagged
   assumption.
2. Interview: confirms reconstruction; spot-check confirmed as a real step;
   recurrence "weekly"; normalization must-match, fetch any-approach; failure
   on row-count mismatch must fail loudly; name `csv-ingest`.
3. Overlap: the `context(scope="skills")` listing shows no fetch or CSV skill
   installed; no references.
4. Gate: summary presented; user approves after tightening the description.
5. Create: write `.clio/skills/csv-ingest/SKILL.md`, placeholders for the
   export URL and column map; `clio skills validate` passes.
6. Validate: scenario "ingest this month's export" must show fetch,
   normalize, count-verify, spot-check in that order; recorded in the body.

## Red Flags

- Writing any skill before the design gate is approved.
- A reconstruction that lists steps nothing in the session shows.
- Reimplementing an installed skill's job instead of referencing it.
- Session-specific paths or values surviving into the generated skill.
- Batching interview questions or ignoring a stop signal.
- Distilling a one-off without asking about recurrence.
