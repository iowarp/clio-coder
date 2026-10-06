---
description: "Execute a specific research task or the entire workflow"
argument-hint: "[task number N, or 'all' for full workflow]"
---

Read ${component:resource:research-policy}. Use gateway to describe and call
`extension_materio__interview`, `extension_materio__set_task_status`,
`extension_materio__complete_task`, and `extension_materio__record_decision`.
Use `gateway({op:"call",capability:"extension_materio__interview",args:{...}})`
for the forms below. The parked result contains `interview`, step-keyed `answers`,
and closing `text`. Cancellation, revision, stale files or errors never authorize
continuation; use the actual answers, never infer consent from prose.
Runtime instructions here supersede the manual state/interview steps in
${component:resource:clio-execution}. Runtime tools own publication, readback,
task directories, checkpoints after accepted findings, and optional named-file
recording. Never grant a worker write access to WORKFLOW.md or STATE.md.

Read ${component:resource:clio-execution} for dispatch and evidence contracts.
Target: $ARGUMENTS (positive task number, all, or next dependency-ready task).
Inspect .research/data/ and DATA-INDEX.md first, then WORKFLOW/STATE, RESEARCH,
LITERATURE, VIRTUAL-LAB and effective config. Honor web_search=false; fetch only
specific researcher-provided URLs when authorized and available. Record corpus
coverage and unreadable formats; Clio has no general web search capability.

Resolve an omitted target or all via the research-state next-task helper; use
actual dependency-ready IDs and at least two-digit task directories. Never
invent an ID or execute with unmet dependencies. Show the full task, assumptions
(including unconfirmed defaults), inputs, outputs and missing lab resources.
Call interview `{form:"define-research-tasks",stage:"confirm",draft:<current complete workflow>,context:<selected task, execution confirmation, assumptions and missing data>}`
to collect proceed/revision answers. Handle corrections with a revised workflow
confirmation before executing; missing data goes to upload-data. Record scientific
decisions with record_decision. Never promote a cancelled or revised form to proceed.
Call set_task_status `{task:<id>,status:"in-progress"}` before dispatch; refusal
stops this task. Writing tasks stop and bridge to `/materio:wtfp` instead.

Use direct dispatch without git when necessary. The optional v4 fleet requires an
existing Git worktree; never initialize git or weaken a write boundary to enable it.
Dispatch materio-task-executor with full approved task, research, literature,
relevant virtual-lab rows, dependency summaries, supplied data descriptions/paths,
web_allowed, provided_urls and exact output_dir. Grant only
`.research/tasks/task-NN/`, plus LITERATURE.md for an approved literature update.
Use monitor if active and full fresh context on every re-dispatch; honor admission.

Route types honestly: experimental prepares protocols/templates/checklists;
computational prepares input/submission/analysis code and README; data-analysis
requires registered data; analytical prepares derivation/validation plan;
literature uses supplied corpus first. Preparation is not executed science.

On task_complete, read every reported output and task-NN-SUMMARY.md; all must be
nonempty. Re-dispatch for missing/incorrect artifacts. Dispatch materio-task-verifier
separately read-only, with approved assumptions, dependencies, actual inventory and
summary. Preserve grounding diagnostics; rejected receipts remain incomplete.
Resolve every decision, human-action or human-verify checkpoint through the
researcher and re-dispatch with the exact answer and full original context.
On task_blocked show its blocker and offer upload-data, revised assumptions,
the blocking task, or skipping; never silently claim completion.

Call complete_task `{task:<id>,summary:<honest prepared/executed distinction>}`.
It checks summary readback and current findings; unanswered findings refuse it.
Call interview `{form:"findings",task:<id>}` for the researcher's decision.
For fix, re-dispatch with MATERIO-REVIEW.md, inspect outputs and recheck using
`/materio:status check <id>` before reopening findings. Accepted exceptions remain
advisory and citations remain offline/unverified. Then retry complete_task;
never write WORKFLOW/STATE yourself or bypass the refusal with set_task_status.
A changed LITERATURE.md outside the task directory still needs its separate
citation check and researcher gate from literature-review; runtime checks cover
the selected task artifacts. The runtime records accepted completion and checkpoint.

Show actual evidence separately: artifact inspection and verifier receipt;
prepared scripts/protocols; exact executed commands and exits (or none); advisory
findings/coverage/warnings; scientific validation not performed by this workflow.
For all, continue in dependency order only after accepted completion; stop at
blocked/checkpoint returns and the first writing task. Offer progress or next task.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/execute-task.md manually with researcher gates and file readback.
