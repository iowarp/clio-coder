---
description: "Remove a task from the research workflow permanently"
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

Validate $ARGUMENTS as a positive active task ID. Read WORKFLOW/STATE, show its full
task and warn about every dependent. Explain permanent removal and offer
archive-task for preserved history. Build a proposed complete workflow with only
this removal and explicit revised dependencies; keep other IDs/statuses stable.
Call interview `{form:"define-research-tasks",stage:"confirm",draft:<proposed workflow>,context:<removed task, dependent warnings, permanent-removal consequences and archive alternative>}`.
A revision or cancellation preserves files; only explicit accept publishes the
validated plan. No unresolved dangling dependency is allowed. If archive is chosen,
use archive-task. Record the actual removal decision/rationale with record_decision;
do not delete task artifacts or renumber surviving tasks.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/remove-task.md manually with researcher gates and file readback.
