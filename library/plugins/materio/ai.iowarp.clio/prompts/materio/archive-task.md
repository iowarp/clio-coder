---
description: "Archive a task; moves it to the Archived section of WORKFLOW.md, out of active execution"
argument-hint: "[task number N]"
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

Validate $ARGUMENTS as a positive active task ID. Show the full task and every
dependent. Gather the archive reason and dependency decision through a
workflow collection form, using context to name the selected task and consequences.
Draft a complete workflow moving its unchanged identity/block to Archived Tasks
with status archived, the researcher reason and date. Revise dependencies only
as the researcher decided; preserve other IDs/statuses and task artifacts.
Call interview `{form:"define-research-tasks",stage:"confirm",draft:<proposed workflow>,context:<archive reason, task and every dependency change>}`.
Only explicit accept publishes the validated plan. Record archive decision and
rationale with record_decision using research scope after the task leaves active
execution. Show the saved workflow and remaining active tasks.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/archive-task.md manually with researcher gates and file readback.
