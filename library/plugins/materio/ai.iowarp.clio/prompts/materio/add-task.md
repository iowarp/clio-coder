---
description: "Add a new task to the research workflow"
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

Read current WORKFLOW/STATE and show active tasks. Call the define-research-tasks
collection form with the existing task list in context and a template description
for keeping the current workflow and adding the researcher's new step. Use its
customization/scope answers for the task name, type, description, inputs, outputs,
position and dependencies; request any missing facts in another collection form.
Allocate a stable ID with the research-state next-task-id helper (above active,
archived and on-disk IDs). Draft the new complete workflow without changing any
existing IDs or statuses. Collect its task-type assumptions with the assumptions
stage, retaining planner defaults as pending confirmation.
Call interview `{form:"define-research-tasks",stage:"confirm",draft:<complete revised workflow>,context:<new task, assumptions, position and dependencies>}`.
Handle revisions before claiming success. The runtime validates the plan, creates
the new task directory, saves WORKFLOW/STATE and reads both back. Record the
addition decision and rationale with record_decision.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/add-task.md manually with researcher gates and file readback.
