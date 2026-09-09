---
description: "Show full research project dashboard; identity, workflow progress, data, and next action"
---

<clio_execution>
Read ${component:resource:clio-execution} before acting. It defines argument parsing,
research state helpers, interview ownership, readback, and optional recording.
</clio_execution>

<objective>
Display a concise dashboard of the current materials-characterization research project. No subagents; reads files directly and formats output.
</objective>

<process>

## 1. Check Initialization

```bash
[ ! -f .research/RESEARCH.md ] && echo "No research project initialized. Run /materials-characterization:identify-research to start." && exit 0
```

## 2. Read All State Files

```bash
cat .research/RESEARCH.md
cat .research/LITERATURE.md 2>/dev/null | head -30
cat .research/WORKFLOW.md 2>/dev/null
cat .research/STATE.md 2>/dev/null
cat .research/DATA-INDEX.md 2>/dev/null | head -20
ls .research/tasks/ 2>/dev/null
ls .research/data/ 2>/dev/null
ls .planning/ 2>/dev/null | head -5
ls .research/handoff/ 2>/dev/null
ls -1t .research/checkpoints/ 2>/dev/null | head -3
```

## 3. Display Dashboard

Format and display:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materials Characterization RESEARCH STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RESEARCH IDENTITY
  Prompt:   [research prompt from RESEARCH.md]
  Domain:   [domain + sub-field]
  Stage:    [career stage]

LITERATURE
  Status:   [LITERATURE.md exists? complete | pending]
  Gaps:     [N gaps identified]
  Keywords: [primary keywords]

VIRTUAL LAB
  Status:   [VIRTUAL-LAB.md exists? defined | not defined]
  Equipment:[N items] | Compute: [HPC systems] | Gaps: [N flagged]

WORKFLOW  ([N]/[total] tasks complete)
  Task 01:  [name]; [☑ complete | ☑ in-progress | ☐ pending | ☐ archived]
  Task 02:  [name]; [status]
  ...

DATA
  [N] files registered (.research/DATA-INDEX.md)
  [N] files in .research/data/

PAPER (wtf-p)
  [.planning/project.json → "wtf-p 0.6 project initialized" |
   other existing .planning files → "existing paper state; inspect compatibility" |
   .research/handoff/ → "Handoff written; paste into wtf-p" |
   "Not started; use /materials-characterization:wtfp"]

───────────────────────────────────────────
▶ SUGGESTED NEXT ACTION
  [smart routing based on state]
───────────────────────────────────────────
```

## 4. Smart Next Action

Based on state, suggest:
- No RESEARCH.md → `/materials-characterization:identify-research`
- No LITERATURE.md → `/materials-characterization:literature-review`
- No VIRTUAL-LAB.md → `/materials-characterization:define-virtual-lab`
- No WORKFLOW.md → `/materials-characterization:define-research-tasks`
- Tasks pending → `/materials-characterization:execute-task [next pending N]`
- All tasks complete, no paper → `/materials-characterization:wtfp`
- All tasks complete, paper in progress → `/wtfp:progress`

</process>
