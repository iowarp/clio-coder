---
description: "Resume research from a paused state; shows current position and suggests next action"
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

Read STATE.md, WORKFLOW.md and partial artifacts. Prefer the paused task, otherwise
the first dependency-ready pending task. Show the saved research prompt, full task,
continuation and actual timestamp. Call set_task_status
`{task:<id>,status:"in-progress"}`; dependencies or unanswered findings may refuse.
After success offer `/materio:execute-task <id>` or progress; no task means show
why nothing can resume. STATE updates and optional recording belong to the tool.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/resume-research.md manually with researcher gates and file readback.
