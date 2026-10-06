---
description: "Start exploring a research subject; guided interview to select fields, define scope, and generate a research prompt"
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

Start a research identity in the current directory; no arguments. Read the
RESEARCH.md template, config template and research-domains.md. Inspect existing
RESEARCH.md and supplied files without overwriting them. Include discovered
materials in the form context and offer upload-data after framing. Never git init.

1. Call interview `{form:"identify-research",context:<existing context and relevant domain/sub-field examples>}`.
   It owns foundation, profile, focus, gap and scope questions, including requests
   for exploration or defaults. If the researcher needs domain exploration,
   explain the relevant domain examples and rerun with that context as needed.
2. Dispatch materio-research-explorer read-only with the entire researcher_input
   transcript and relevant domain sections. Require three answerable candidate
   questions (focused, standard, ambitious), each with in/out scope, keywords,
   and a recommendation grounded in the researcher's resources and timeline.
   On exploration_inconclusive show missing information; do not invent answers.
3. Call interview `{form:"identify-research",stage:"select",candidates:[<A with scope/keywords>,<B>,<C>],context:<recommendation and reason>}`.
   Selection and corrections come back as structured answers.
4. Re-dispatch the explorer read-only with all original candidates, the complete
   transcript and verbatim selection/corrections. Require a complete RESEARCH.md
   draft matching the template, including a single Selected Prompt, researcher
   profile, initial keywords, scope and Key Decisions.
5. Call interview `{form:"identify-research",stage:"confirm",draft:<complete document>,context:<selected prompt and scope>}`.
   For revisions re-dispatch with full context and reopen confirmation. Only a
   saved/read-back closing text establishes publication of RESEARCH.md/STATE.md.
   The runtime initializes missing config/directories without replacing config.

Show the selected question, domain/sub-field and profile path. Offer
`/materio:upload-data` for existing papers, then `/materio:literature-review`;
planning is also available if the literature review is already complete.

If runtime is unavailable, follow ${pluginRoot}/assets/actions/identify-research.md manually with researcher gates and file readback.
