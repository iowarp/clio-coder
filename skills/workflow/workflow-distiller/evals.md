# Evals - workflow-distiller

Baseline scenarios (run a subagent WITHOUT the skill to capture the gap, then
WITH the skill to confirm it closes). Rubric is pass/fail per bullet.

## S1 - "make what we just did a skill"

Setup: Make what we just did a skill. For the record, this session we ran
the release-notes workflow end to end: pulled the merged PR titles since
the last tag with gh, grouped them by conventional-commit type, rewrote
each group into user-facing bullets, and verified every PR number in the
draft against the gh list before saving docs/release-notes.md. I also
mentioned we sometimes ping the release channel afterwards, but we did not
do that here.

Expected:

- Reconstructs the executed steps from the session record, in order, before
  asking any question; unobserved steps the user mentions are tagged as
  assumptions.
- Interviews via `ask_user` with `mode: "single_question"`, one question per
  round, bounded rounds.
- Lists installed skills via `context(scope="skills")` with no name before
  designing.
- Presents a compact design summary and waits for explicit approval.
- Writes the SKILL.md only after approval, with session-specific values
  replaced by placeholders.
- Records a RED-GREEN validation scenario.

## S2 - overlap with an installed skill

Setup: the workflow's retrieval step is already covered by an installed skill
(for example arxiv-literature for paper retrieval).

Expected:

- The overlap check finds the installed skill.
- The generated skill references it by name instead of reimplementing the
  step, with a one-line rationale in the body.
- The generated frontmatter carries `requires: [skill:<name>]` so the loader's
  unmet-dependency warning arms when the referenced skill is absent.

## S3 - no recurrence

Setup: mid-interview the user admits the workflow has only ever run once and
may not recur.

Expected:

- Questions whether distillation is worth it and offers to stop.
- Does not press on to create a skill for a one-off by default.

## S4 - anti-trigger: brand-new skill

Setup: user asks for a new skill for something never done in any session.

Expected:

- Skips the distiller ceremony and points at writing the SKILL.md directly,
  following skill-craft.

## Baseline failure modes to watch for (RED)

- Writes a vague skill immediately from the user's description, no grounding
  in what actually ran.
- No overlap check; reimplements an installed skill's behavior.
- No approval gate; the skill file appears before the user saw a design.
- Session-specific paths, URLs, and values baked into the skill body.
- Multi-question interviewing or an unbounded question stream.

## Observed results

Runs 2026-07-02, headless `clio-coder run --skill`. `ask_user` is not registered in
headless runs, so interviews were exercised with pre-supplied decisions in the
prompt; the phases still had to run in order.

- Six-phase walk (CSV header normalization fixture): the workflow visibly ran
  (write plus execute normalize.py, row-count check), Phase 1 cited exactly
  those steps, Phase 2 applied the pre-supplied decisions question by
  question, Phase 3 listed installed skills with no name, Phase 4 presented
  the summary and stopped for approval even though pre-approval was offered
  (the strict reading of the gate), and after an explicit approval turn Phase
  5's skill-creation call landed a loadable project skill that `clio-coder skills
  inspect` resolves, with placeholders instead of session paths. Phase 6
  recorded the validation scenario in the body.
- S2 RED (no distiller, arxiv-literature installed): the baseline created the
  skill immediately with no overlap check against the installed-skill
  listing, no gate, and a body that reimplements the fetch step. Gap
  confirmed.
- S2 GREEN: with the shipped per-step overlap wording, the design references
  `arxiv-literature` with a rationale instead of reimplementing retrieval.
  Two earlier drafts missed this: workflow-level overlap judgment and a
  fixture prompt that prescribed the fetch mechanism both masked the
  behavior; the wording now says a different end goal does not excuse
  reimplementing a covered step. At the time of that run the skill-creation
  tool could not emit `requires` frontmatter, so the skill handed the user
  the line to add; `requires: [skill:arxiv-literature]` on the generated
  skill was verified to produce the loader's "requires skill ... which is not
  available" warning when the dependency is absent. 2026-07-02: skill
  creation moved to writing SKILL.md directly (the artifact tool's skill kind
  was removed); Phase 5 now writes the `requires` entries into the
  frontmatter itself.

## Smoke record (2026-08-13)

One representative scenario via `clio-coder skills eval` against Nemo-3.5-Lightning
(30B local, llamacpp on mini), full-auto sandbox. PASS. Inline session-trace setup engaged; judge 5/6.
