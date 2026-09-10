---
description: "Conduct literature review, identify research gaps, and define search keywords"
---

<clio_execution>
Read ${component:resource:clio-execution} before acting. It defines argument parsing,
research state helpers, interview ownership, readback, and optional recording.
</clio_execution>

<clio_dispatch>
Select the named recipe with dispatch({agent:"materio-...", task:"assignment with
full context and exact permitted outputs", intent:{write_roots:["exact/output"]}}).
Replace the illustrative recipe/path with those stated in this command. Use the
registered dispatch fields shown here.
Read the recipe's bound skill references and inline required templates, domain
sections, answers and selected state into the worker task. Each dispatch starts
fresh: re-dispatch with the full original context, prior candidates/outputs and
the new selection, corrections, revisions or resume answer. Use monitor if the
returned run is still active. Do not infer a resumed transcript from a run ID.
Honor admission refusals instead of broadening write scope.

Agent returns are mutation-report JSON. Route on the beginning of summary using
the status branches below. For checkpoints, distinguish
`needs_input: checkpoint:decision`, `needs_input: checkpoint:human-action`, and `needs_input: checkpoint:human-verify`;
ask the exact question(s), collect the answer and re-dispatch. No new top-level
status fields are allowed. A conforming JSON result is not proof of completion.
After EVERY dispatch that wrote, use ls and read on every reported output and on
the command's required files, including loop_back and partial checkpoint returns.
Verify nonempty content and the promised changes before presenting success or
continuing; re-dispatch with any missing/incorrect file named. Treat actual failed
validation or execution as failure even when summary claims completion.
</clio_dispatch>

<execution_context>
@.research/RESEARCH.md
@.research/config.json
</execution_context>

<objective>
Conduct a structured literature review based on the research identity in RESEARCH.md. Identifies current state of knowledge, open gaps, key authors/groups, and proposes refined search keywords. Creates LITERATURE.md.

**Orchestrator role:** Validate RESEARCH.md exists, gather the supplied corpus and scope guidance from the user, spawn the materio-literature-reviewer agent, run the advisory citation check, collect the researcher's decisions on flagged entries and proposed keywords, handle loop-back to identify-research if a major problem with the prompt is found.

**Why subagent:** Literature synthesis requires sustained reading, cross-referencing, and gap reasoning across many papers. Fresh context = more rigorous gap analysis. The agent never asks the researcher anything; every decision comes back here.
</objective>

<context>
No arguments. Reads .research/RESEARCH.md and .research/config.json.
</context>

<process>

Worker write scope: .research/LITERATURE.md.


## 1. Gather Supplied Materials First

Before any other research read, use ls on `.research/data/` and read
`.research/DATA-INDEX.md`; inspect readable registered materials first. Record
unreadable formats as access limits and ask for usable text when needed. Then
validate the research identity and config below.

### Validate Environment

```bash
test -f .research/RESEARCH.md || echo "ERROR: No RESEARCH.md. Run /materio:identify-research first."
[ -f .research/LITERATURE.md ] && echo "WARN: LITERATURE.md exists. Running again will update it."
cat .research/RESEARCH.md
python3 "${component:script:research-state}" config
```

## 2. Gather the Supplied Corpus

```bash
ls -la .research/data/ 2>/dev/null
cat .research/DATA-INDEX.md 2>/dev/null
```

Supplied papers, BibTeX files, and notes are the primary corpus for the review; researcher-provided URLs may extend it. If nothing is registered, say so in the scope question below and offer `/materio:upload-data` first. Clio has no web search tool. State that the review is built from supplied
materials plus any specific URLs the researcher provides. Ask for those URLs in
the scope question; use web_fetch only when web_search is true and the tool is
available. With web_search false, use supplied materials only. Record this exact
coverage and access limits in LITERATURE.md under Sources Reviewed.

## 3. Confirm Scope with User

Use ask_user:
- header: "Literature Review Scope"
- question: "I'll review literature based on your research prompt:\n\n**[research prompt from RESEARCH.md]**\n\nCorpus: [N] supplied files [list] · Provided-URL fetching: [allowed|disabled]\n\nAnything to adjust before I start?\n1. Any specific papers, authors, or groups to prioritize?\n2. Any journals or conferences to focus on?\n3. Year range? (default: all years, emphasis on last 10)\n4. Any sub-topics to explicitly include or exclude?\n5. Any specific URLs to add to the supplied corpus?"
- options: "Start with current scope" | "I'll add more context" | "Upload papers first; /materio:upload-data"

## 4. Spawn materio-literature-reviewer Agent

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materio ► REVIEWING LITERATURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Use dispatch with `agent: "materio-literature-reviewer"` and a task containing the assignment and full context. The prompt carries:
- `<research>`; full RESEARCH.md content
- `<uploaded_data>`; every registered file path with its DATA-INDEX.md description
- `<user_guidance>`; scope adjustments from Step 3
- `<web_allowed>`; true only when config permits URL fetching and web_fetch is available
- `<provided_urls>`; the specific URLs supplied by the researcher, or none
- `<literature_path>`; `.research/LITERATURE.md`

## 5. Handle Agent Return

**`literature_review_complete:`:**

1. Use read on `.research/LITERATURE.md` and verify the file is on disk:
   ```bash
   test -s .research/LITERATURE.md && echo OK || echo "ERROR: LITERATURE.md missing"
   ```
   If missing, re-dispatch the agent and say so; do not continue.

2. Advisory citation check. Verify the Key Papers table against Crossref to catch fabricated papers or dead DOIs. This is advisory; it never deletes anything on its own:
   ```bash
   if command -v python3 >/dev/null 2>&1; then
     citation_flags=()
     [ "$(python3 "${component:script:research-state}" config --key web_search)" = true ] || citation_flags=(--offline)
     if python3 "${pluginRoot}/assets/scripts/verify_citations.py" "${citation_flags[@]}" .research/LITERATURE.md; then echo "CHECK EXIT: 0"; else echo "CHECK EXIT: $? (findings or incomplete coverage)"; fi
   fi
   ```
   - If python3 is absent, record citation verification as skipped. If every entry is UNVERIFIABLE with network errors, record the access limitation in Review Notes and continue. With web_search false, run only the offline structural check.
   - If any entry is **NOT_FOUND** or **MISMATCH**: show each flagged entry next to the closest Crossref match and ask via ask_user, one batched question:
     - header: "Citation Check"
     - question: "Crossref could not confirm [N] entries:\n\n1. [entry] → closest match: [title, year, DOI] (score [x])\n2. ...\n\nFor each: keep as-is, mark unverified, correct to the match, or remove?"
     - options: "Keep all, mark unverified" | "Correct to matches where shown" | "I'll decide per entry" | "Remove all flagged"
     Apply the decision to LITERATURE.md. A flagged entry is never removed without the researcher saying so.

3. Keyword gate. The agent proposed changes in the Refined Keywords section and in its return. Ask via ask_user:
   - header: "Keyword Refinement"
   - question: "Based on the literature, I suggest refining keywords:\n\nAdd: [terms]\nRemove: [terms]\nReplace: [old] → [new]\n\nAny adjustments?"
   - options: "Accept refined keywords" | "Keep original keywords" | "I'll adjust"
   Apply the accepted set to the Keywords section of RESEARCH.md.

4. Record (optional git):
   ```bash
   python3 "${component:script:research-state}" record --message "research: literature review; [N] sources, [N] gaps identified" --files "${CHANGED_FILES[@]}"
   ```

**`loop_back:`:**
- Read LITERATURE.md back and run the same advisory citation check and researcher decision gate above before applying the loop-back decision.
- The reviewer found the prompt is too broad, too narrow, already answered, or rests on a false premise. LITERATURE.md was still written.
- Present the finding and its three suggested prompts.
- Ask via ask_user:
  - header: "Prompt Needs Revision"
  - question: "The literature shows: [finding].\n\nSuggested revisions:\n1. [narrowed]\n2. [adjacent gap]\n3. [replication/extension]\n\nHow do you want to proceed?"
  - options: "Narrow to suggestion 1" | "Narrow to suggestion 2" | "Narrow to suggestion 3" | "Proceed with the current prompt anyway"
- If a suggestion is chosen: update the Selected Prompt and Key Decisions in RESEARCH.md and STATE.md, note the revision reason, then run the keyword gate above. If the change is larger than a rewording, recommend re-running `/materio:identify-research` with the new framing.

**`needs_input: checkpoint:decision`, `needs_input: checkpoint:human-action`, or `needs_input: checkpoint:human-verify`:**
- Present the question to the user, collect the answer via ask_user, re-dispatch the agent.

</process>

<offer_next>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materio ► LITERATURE REVIEW COMPLETE ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Review:   .research/LITERATURE.md
Sources:  [N] supplied, [N] researcher-provided URLs fetched
Gaps:     [N] identified
Keywords: [primary keywords]
Citations: [N verified, N marked unverified]

───────────────────────────────────────────

## ▶ Next Up

**Map your available lab resources**
(equipment, HPC, software, collaborations)

`/materio:define-virtual-lab`

<sub>Each dispatch starts with fresh worker context.</sub>

───────────────────────────────────────────

**Also available:**
- `/materio:identify-research`; refine prompt based on gaps found
- `/materio:upload-data`; add more papers/datasets to review
- `/materio:define-research-tasks`; skip virtual lab setup and go straight to workflow

</offer_next>

<success_criteria>
- [ ] Every question to the researcher was asked by this command, not by the agent
- [ ] Supplied corpus listed and passed to the agent; web availability passed explicitly
- [ ] Current state of knowledge summarized by sub-topic
- [ ] Evidence-supported gaps identified with limitations; zero gaps is a valid result
- [ ] Key papers listed with quoted titles and provenance
- [ ] Citation check run; flagged entries decided by the researcher, never auto-removed
- [ ] Keywords refined only after the researcher accepted
- [ ] Loop-back handled if the prompt needs revision
- [ ] LITERATURE.md verified on disk; commit only if commit_research is true
</success_criteria>
