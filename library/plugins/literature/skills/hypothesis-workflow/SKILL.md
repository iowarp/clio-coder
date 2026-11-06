---
name: hypothesis-workflow
description: "Turns a research question into ranked, testable hypotheses with cited grounding and the smallest experiment for each, then stops for the operator's choice. Intake through ask_user, literature through the researcher agent and citation-check, independent council proposals, a testability ranking recorded with decide as advice, a hazard checkpoint, and the operator's own choice through an operator_only ask_user question. Headless runs end with the ranked options. Never chooses the question or the hypothesis."
triggers:
  - generate hypotheses for this research question
  - propose testable hypotheses
  - rank hypotheses by testability
  - design the smallest experiment for each hypothesis
  - hypothesis workflow
---

# Hypothesis workflow

Turn the operator's research question into a slate of cited, falsifiable
hypotheses, ranked by how testable they are, each top one with the smallest
experiment that could refute it. Then stop. The operator chooses which
hypothesis to pursue, or none. You never choose the question or the
hypothesis, in any mode.

How the choice is kept with the operator: a hypothesis choice exists only as
the operator's answer to an `ask_user` question marked `operator_only: true`.
Clio records that answer on the session decision board with the mark
`operator_choice`, and nothing else can produce that mark: `decide` cannot,
`ask_user` `action=complete` cannot write or replace it, a timeout or yolo
autonomy answers nothing for it, and a headless run has no `ask_user` at all.
So never write a choice anywhere else: not in the slate, a file, a `decide`
call or a `complete` decision.

## Mode

`ask_user` registered means an operator is attending: run steps 1 to 8. In a
headless run `ask_user` is not registered and nobody will reply: take the
intake from the task text, run steps 2 to 7, and end with the headless report
in step 8. Never end a headless run with a question.

## Step 1. Intake

You need five things: the research question, the constraints, the data
available, the budget and the time. Use what the task already states and ask
only for what is missing.

- The research question is the operator's. If the task does not state one,
  ask it as its own `ask_user` call with `operator_only: true` and no
  options. Never offer candidate questions as a choice you made.
- Ask the rest in one `ask_user` round (up to four questions, options where
  natural). An answer of "none" or "unknown" is an answer.
- Headless: a field the task does not give is recorded as `"not given"`. With
  no research question in the task, stop and say that the run needs one.

## Step 2. Literature grounding

Collect what is known, with a source for every statement.

1. Dispatch the `researcher` agent with the question and the constraints, and
   follow the `arxiv-literature` skill for arXiv search and paper cards. Ask
   for findings whose evidence names a DOI, `arxiv:<id>`, PMID or URL.
2. Verify every identifier through the `citation-check` skill (CiteNexus
   `verify-citation`, or its `web_fetch` fallback). Record each source's
   verdict: VERIFIED, MISMATCH, NOT_FOUND, UNAVAILABLE, or UNVERIFIED when no
   check ran.
3. Write each statement once, with an id (`L1`, `L2`, ...). A statement
   with no source is kept and marked `"unsourced": true`, and wherever it is
   quoted to the operator it carries `[unsourced]`. Never cite from memory a
   work you have not resolved, and never drop a NOT_FOUND or MISMATCH quietly:
   keep the verdict beside the statement.

## Step 3. Council: independent proposals

Several models propose hypotheses without seeing each other.

- `dispatch` with `mode: "council"`, the roster the operator named (else
  `default`), `rounds: 1` and `synthesis: "none"`. One round with no
  synthesis is what keeps the members independent: each answers the same task
  and none reads another's answer.
- The task names the question, the intake, and the literature statements
  with their ids and verdicts, and asks each member for two to four
  hypotheses, each with a statement, a falsifiable prediction, the statement
  ids it rests on, the data it needs, and how many physical (bench, field or
  instrument) steps testing it takes.
- No roster configured: say so, and run three independent `parallel`
  `researcher` tasks instead. Record `"independentModels": false` in the slate,
  because one model's three answers are not a council.

Merge the answers yourself:

- Duplicates (the same prediction under different words) become one
  hypothesis whose `proposedBy` lists every member that proposed it.
- Disagreements stay visible. When members predict opposite outcomes, or one
  calls another's hypothesis untestable or contradicted, record it under
  `disagreements` as `{member, position}`. Never drop a member's hypothesis
  silently; one you fold into another stays listed in `merged`.

## Step 4. Ranking by testability

Rank every hypothesis, most testable first, on: a falsifiable prediction;
the data required (available now, or to collect); the cost; the time; and the
number of physical steps (fewer is more testable). Then record the ranking
with `decide`: key `hypothesis-ranking`, value the order (`H2 > H1 > H3`),
the orderings you rejected as `alternatives`, and the rationale. The ranking
is advice. It is not a choice, and saying "I recommend" about it is fine;
acting on it is not.

## Step 5. Smallest experiment for the top hypotheses

For each of the top three:

- The smallest experiment whose outcome could refute the prediction.
- Its success criterion, as a check where the work is computational: a
  `reproduce` check (pinned input digests, seed, `compare: twice` or a
  reference, a declared tolerance) or a `numeric-compare` check, with the
  `verify` entry id it would get. Draft the entry in the slate; do not add it
  to the project's verifier file before the operator chooses. Physical work
  gets a `manual` criterion with a measurable threshold.
- Hazardous work (pathogens, toxins, enhancement of transmissibility or
  virulence, chemical agents, explosives, radiological material): describe
  only what is measured and what outcome refutes the prediction. Never write
  procedures, quantities, synthesis routes or enhancement methods.

## Step 6. Write and check the slate

Write the slate to `research/hypotheses/<slug>.json`, unless the operator
named another place, in this shape:

```json
{
  "schema": "clio-coder.hypothesis-slate.v1",
  "question": {"text": "...", "constraints": "...", "data": "...", "budget": "...", "time": "..."},
  "literature": [
    {"id": "L1", "statement": "...", "sources": [{"id": "doi:10.1000/x", "verdict": "VERIFIED"}]},
    {"id": "L2", "statement": "...", "unsourced": true}
  ],
  "council": {"roster": "default", "members": ["a", "b", "c"], "independentModels": true},
  "hypotheses": [
    {
      "id": "H1", "status": "proposed",
      "statement": "...", "prediction": "...",
      "proposedBy": ["a", "c"], "grounding": ["L1"],
      "disagreements": [{"member": "b", "position": "..."}], "merged": [],
      "testability": {"data": "...", "cost": "...", "time": "...", "physicalSteps": 0},
      "experiment": {
        "summary": "...",
        "successCriterion": {"kind": "reproduce", "verifyId": "h1-...", "statement": "..."}
      },
      "hazard": {"flagged": false, "categories": [], "note": ""}
    }
  ],
  "ranking": {"order": ["H1"], "rationale": "...", "decision": "hypothesis-ranking"}
}
```

`status` stays `proposed`: tested, supported and refuted come later, from
evidence. Run the checker with `run_script` (or `bash` and `python3` when the
pack is installed outside the workspace) and fix every error it reports:

```text
run_script(interpreter="python3",
           script="${pluginRoot}/assets/scripts/hypothesis_slate.py",
           args=["--markdown", "research/hypotheses/<slug>.json"],
           inputs=["research/hypotheses/<slug>.json"])
```

It refuses a slate with an uncited, unmarked statement, a hypothesis without
a prediction, a ranking that misses a hypothesis, or any key that records a
choice (`selected`, `chosen`, `choice`, ...). Its `hazardConfirmationsRequired`
lists every hypothesis the slate flags or its term screen matches. Exit 0
means valid, 1 errors, 2 unreadable.

## Step 7. Hazard checkpoint

Before the choice, every hypothesis in `hazardConfirmationsRequired`, plus any
you judge hazardous yourself, needs the operator's explicit confirmation.

- Attended: one `ask_user` call per flagged hypothesis, `operator_only: true`,
  header `Hazard check H<n>`, the categories and matched terms in the question,
  and the options `Keep H<n> as an option` (the operator confirms the work has
  the review and approvals it needs) and `Drop H<n>`. A hypothesis not
  confirmed is not offered in step 8.
- Headless: list each flagged hypothesis as needing confirmation. It stays
  unconfirmed.

This checkpoint adds to Clio's safety policy and safety judge; both still
review every tool call.

## Step 8. The operator's choice

Attended: show the ranked table from the checker (`--markdown`) with the
disagreements and hazard flags in your text, then ask one `ask_user` question
with `operator_only: true`, header `Hypothesis choice`, and the options: each
eligible top hypothesis in rank order (`H2: <short statement>`, with its
prediction and experiment as the description), `Refine the hypotheses`, and
`None of these`. Mark no option recommended.

- A hypothesis: report the decision ref the result names, the chosen
  hypothesis, its experiment and its check draft. Start that experiment only
  when the operator asks.
- Refine: ask what to change, then rerun from the step it touches.
- None: end with the slate path; nothing is pursued.
- `operator_choice_unanswered` or a cancel: the choice stays open. End the
  turn and change nothing.

Do not restate the choice in an `action=complete` decision or a `decide` call.

Headless: end here with the report: the question, the ranked table, the
disagreements, the hazard flags awaiting confirmation, the unsourced
statements, the slate path, and the line "The operator chooses: run this
interactively, or reply with a hypothesis id." Never pick one, and never write
"proceeding with H<n>".
