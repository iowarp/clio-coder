---
description: "Interview to map all available lab resources; equipment, HPC, software, collaborations; into a VIRTUAL-LAB.md that guides feasible task planning"
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

Require RESEARCH.md; inspect LITERATURE.md's Methodological Landscape, or relevant
common methods in research-domains.md if literature is absent. Read VIRTUAL-LAB.md
and its template. Include domain-specific equipment/software examples in context.

1. Call interview `{form:"define-virtual-lab",context:<domain, methods, relevant equipment/software and existing profile>}`.
   The runtime owns quick/guided mode and all equipment, computing, external,
   budget, constraint and personnel steps. Use the complete resource_input.
2. Dispatch materio-lab-definer read-only with RESEARCH.md, methodological
   landscape, verbatim resource_input and the complete VIRTUAL-LAB template.
   Require a structured draft, resource-to-task mapping, availability, alternatives,
   gaps and follow-up details. Label missing resource facts rather than assume them.
3. Call interview `{form:"define-virtual-lab",stage:"confirm",draft:<complete lab document>,context:<summary, gaps, alternatives and follow-ups>}`.
   The researcher sees the document and decides whether to save or revise it.
   For corrections/follow-up answers, re-dispatch with full resource_input plus
   corrections, then reopen confirmation. Preserve unresolved feasibility limits.
   If the researcher narrows the prompt, call record_decision with the exact
   decision, rationale and scope; use identify-research confirmation for its draft.

Show only saved/read-back results: experimental, compute, software, external
access and gaps. Offer `/materio:define-research-tasks`, upload-data, or literature-review.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/define-virtual-lab.md manually with researcher gates and file readback.
