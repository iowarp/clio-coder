---
description: "Overview of Materio commands, workflow, and philosophy"
display-only: true
---

<objective>
Display the Materio command reference. No tools needed.
</objective>

<process>

Display the following:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materio; materials research system
 Plan and automate your research with Clio Coder
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CORE RESEARCH LOOP
─────────────────────────────────────────
 1. /materio:identify-research
       Guided interview → select domain, sub-field,
       scope, and confirm a research prompt

 2. /materio:literature-review
       Review literature, identify gaps, refine keywords
       (loops back to identify-research if needed)

 3. /materio:define-virtual-lab
       Map available resources: experimental equipment,
       HPC systems, software licenses, collaborations
       Questions are targeted to your research domain

 4. /materio:define-research-tasks
       Choose from traditional research workflows or
       build from scratch; interview per task for assumptions
       (resource-aware: flags tasks requiring unavailable equipment)

 5. /materio:execute-task [N | all]
       Execute a specific task or the full workflow
       Types: literature, experimental, computational,
              data-analysis, analytical, writing

 6. /materio:wtfp
       Bridge to wtf-p; translate research into a paper
       project with include/exclude control

TASK MANAGEMENT
─────────────────────────────────────────
 /materio:add-task          Add a task to the workflow
 /materio:remove-task [N]   Remove a task permanently
 /materio:archive-task [N]  Archive (preserve but deactivate)

DATA
─────────────────────────────────────────
 /materio:upload-data [file] Register data files, papers,
                           and datasets for task use

PROGRESS & CONTROL
─────────────────────────────────────────
 /materio:status             Full project dashboard
 /materio:progress           Statusline + smart routing
 /materio:pause-research     Pause + auto-checkpoint
 /materio:resume-research    Resume from paused state
 /materio:checkpoint save [label]   Save state snapshot
 /materio:checkpoint restore [name]  Restore snapshot
 /materio:checkpoint list           List snapshots

META
─────────────────────────────────────────
 /materio:help               This help
 /materio:settings           View/edit project config

PROJECT STATE (.research/)
─────────────────────────────────────────
 RESEARCH.md     Research identity, prompt, scope
 LITERATURE.md   Review results, gaps, keywords
 VIRTUAL-LAB.md  Equipment, HPC, software, gaps
 WORKFLOW.md     Tasks with status and assumptions
 STATE.md        Current position, phase, decisions
 DATA-INDEX.md   Registered data files
 config.json     Settings (web_search, commit_research…)
 data/           Uploaded datasets and papers
 tasks/          Task-by-task outputs (task-NN/)
 checkpoints/    State snapshot archives
 handoff/        Paste-ready blocks for wtf-p 0.6

TASK TYPES
─────────────────────────────────────────
 literature    → Read supplied papers and provided URLs, synthesize
 experimental  → Generate protocol + data templates
 computational → Generate simulation/analysis scripts
 data-analysis → Analyze uploaded data, produce figures
 analytical    → Mathematical modeling, derivations
 writing       → Bridge to /materio:wtfp

GUARDRAILS (after each task, advisory)
─────────────────────────────────────────
 check_physics     impossible values (T < 0 K, ρ ≤ 0…)
 verify_citations  Crossref check on quoted titles/DOIs
 check_scripts     syntax + hallucinated imports
 Findings are shown to you; nothing is auto-removed.

INTEGRATION WITH WTF-P
─────────────────────────────────────────
 /materio:wtfp prepares reviewed import briefs.
 0.6+: writes .research/handoff/ blocks you paste into
       /wtfp:new-paper → map-project → create-outline
 Existing paper state: inspect/reuse/repair first.
 The bridge never writes paper state. Reuse answers already
 answered during research planning.

TIPS
─────────────────────────────────────────
 • Each dispatch receives fresh worker context
 • Interviews happen in the command; agents only
   synthesize and write, and report back checkpoints
 • /materio:upload-data papers BEFORE literature-review:
   supplied papers first, provided URLs second
 • Materio never initializes git. Set commit_research=true in
   /materio:settings if you want optional named-file commits. Checkpoints use archives.
 • /materio:checkpoint save before long tasks
 • /materio:literature-review can loop back to
   identify-research if your prompt needs revision
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

</process>
