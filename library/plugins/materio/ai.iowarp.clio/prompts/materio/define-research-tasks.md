---
description: "Build a research workflow; select from traditional templates or create from scratch, with assumption interviews per task"
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

Dispatch the named recipe with the full current research context, required
package templates/references, every verbatim answer and prior candidate/revision.
Candidate and synthesis dispatches are read-only: omit intent.write_roots and
request the proposed document in the return, without publishing files. Each
re-dispatch gets fresh context; use monitor for active runs and respect admission
refusals. Route mutation-report summary prefixes. Resolve exact worker decision,
human-action and human-verify checkpoints before a fresh bounded dispatch; no
worker can approve its own output. Failed validation overrides claimed success.

Require RESEARCH.md. Read LITERATURE.md, VIRTUAL-LAB.md, WORKFLOW.md (if present),
traditional-workflows.md and the WORKFLOW template. Warn explicitly if the lab is
missing: feasibility is unchecked. Existing IDs and statuses must stay stable.

1. Call interview `{form:"define-research-tasks",templates:[<relevant full template descriptions and task lists>],context:<research prompt, lab gaps and existing workflow>}`.
   Offer all relevant templates (up to eight) and the built-in scratch option.
   It owns template selection, add/remove/reorder customization, scope,
   exclusions, first milestone and existing-data questions.
2. Assemble a tentative complete workflow from the chosen template and answers.
   Call interview `{form:"define-research-tasks",stage:"assumptions",draft:<tentative workflow>}`.
   It owns task-type questions per non-writing task. Preserve answers keyed by
   task ID and every explicit request for planner defaults; writing bridges to wtfp.
3. Dispatch materio-workflow-planner read-only with all research/literature/lab
   context, selected template, customizations, scope, assumptions and WORKFLOW
   template. Require a full draft: type, description, assumptions with provenance,
   inputs, expected outputs, dependencies, effort, pending status for new tasks,
   flags, critical path, alternatives and defaults awaiting researcher confirmation.
4. Call interview `{form:"define-research-tasks",stage:"confirm",draft:<complete workflow>,context:<critical path, first checkpoint, every resource flag and default>}`.
   Revisions/flag decisions return as answers; re-dispatch with full context and
   reopen confirmation. The runtime refuses bad dependencies, cycles, reused IDs
   and status edits, then publishes WORKFLOW/STATE and creates stable directories.
   Record workflow decisions with record_decision, preserving the Decisions Made list.

Show the saved task table and actual first dependency-ready task; offer
`/materio:execute-task <id>`, add-task, remove-task or archive-task.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/define-research-tasks.md manually with researcher gates and file readback.
