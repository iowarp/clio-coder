---
description: "Overview of materials characterization commands, workflow, and philosophy"
---

<objective>
Display the materials characterization command reference. No tools needed.
</objective>

<process>

Display the following:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materials Characterization; Material Science Research System
 Plan and automate your research with Clio Coder
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CORE RESEARCH LOOP
─────────────────────────────────────────
 1. /materials-characterization:identify-research
       Guided interview → select domain, sub-field,
       scope, and confirm a research prompt

 2. /materials-characterization:literature-review
       Review literature, identify gaps, refine keywords
       (loops back to identify-research if needed)

 3. /materials-characterization:define-virtual-lab
       Map available resources: experimental equipment,
       HPC systems, software licenses, collaborations
       Questions are targeted to your research domain

 4. /materials-characterization:define-research-tasks
       Choose from traditional research workflows or
       build from scratch; interview per task for assumptions
       (resource-aware: flags tasks requiring unavailable equipment)

 5. /materials-characterization:execute-task [N | all]
       Execute a specific task or the full workflow
       Types: literature, experimental, computational,
              data-analysis, analytical, writing

 6. /materials-characterization:wtfp
       Bridge to wtf-p; translate research into a paper
       project with include/exclude control

TASK MANAGEMENT
─────────────────────────────────────────
 /materials-characterization:add-task          Add a task to the workflow
 /materials-characterization:remove-task [N]   Remove a task permanently
 /materials-characterization:archive-task [N]  Archive (preserve but deactivate)

DATA
─────────────────────────────────────────
 /materials-characterization:upload-data [file] Register data files, papers,
                           and datasets for task use

PROGRESS & CONTROL
─────────────────────────────────────────
 /materials-characterization:status             Full project dashboard
 /materials-characterization:progress           Statusline + smart routing
 /materials-characterization:pause-research     Pause + auto-checkpoint
 /materials-characterization:resume-research    Resume from paused state
 /materials-characterization:checkpoint save [label]   Save state snapshot
 /materials-characterization:checkpoint restore [name]  Restore snapshot
 /materials-characterization:checkpoint list           List snapshots

META
─────────────────────────────────────────
 /materials-characterization:help               This help
 /materials-characterization:settings           View/edit project config

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
 writing       → Bridge to /materials-characterization:wtfp

GUARDRAILS (after each task, advisory)
─────────────────────────────────────────
 check_physics     impossible values (T < 0 K, ρ ≤ 0…)
 verify_citations  Crossref check on quoted titles/DOIs
 check_scripts     syntax + hallucinated imports
 Findings are shown to you; nothing is auto-removed.

INTEGRATION WITH WTF-P
─────────────────────────────────────────
 /materials-characterization:wtfp prepares reviewed import briefs.
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
 • /materials-characterization:upload-data papers BEFORE literature-review:
   supplied papers first, provided URLs second
 • materials characterization never initializes git. Set commit_research=true in
   /materials-characterization:settings if you want optional named-file commits. Checkpoints use archives.
 • /materials-characterization:checkpoint save before long tasks
 • /materials-characterization:literature-review can loop back to
   identify-research if your prompt needs revision
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

</process>
