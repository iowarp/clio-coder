---
description: "Register and index data files, papers, or datasets for use in research tasks"
argument-hint: "[file path or directory, optional]"
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

Optional file or directory: $ARGUMENTS. Locate actual files with read/ls/find;
when omitted, inspect common CSV, XLSX, TXT, PDF, DAT, JSON, MAT, BIB and script
files, excluding .git and host internals. Never invent a discovered path.

Call interview `{form:"upload-data",files:[<1–20 actual file paths>]}`.
For each file the runtime owns type, description, relevant tasks and format/units;
initial drafts offer conservative extension-based types and mark content unknown.
It then asks copy into .research/data/ or index in place. Original files stay.
The handler validates paths/tasks, performs requested copies without collisions,
appends DATA-INDEX.md and reads it back. For more than twenty files, use successive
calls. A cancelled form does not publish an index or copy files.

Show the registered count, DATA-INDEX.md and storage choice only after the closing
text confirms saving. Papers/BibTeX feed literature-review; datasets feed execute-task.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/upload-data.md manually with researcher gates and file readback.
