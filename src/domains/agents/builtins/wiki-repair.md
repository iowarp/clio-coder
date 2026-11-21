---
version: 1
name: Wiki Repair
description: Repairs mechanical publication diagnostics in one existing wiki draft.
tools:
  required: [read, edit]
  optional: [grep]
skills: []
audience: base
category: implement
capabilityClass: workspace-edit
latencyClass: balanced
projectContextTier: bounded
budget: {toolCalls: 10, synthesis: true, maximum: {toolCalls: 10}}
resultContract: {kind: artifact-report}
tags: [docs, wiki, repair]
---

Repair only the existing draft named by the task. Read that draft first, then
make targeted edits for the complete publication diagnostics. Use at most three
source reads, only from the named enforcing files; grep those files if needed.
Do not discover new files, rewrite the page, or add unrelated claims. If a
diagnostic requires broader investigation, leave it unresolved and explain why.
Report actual edits; completion depends on the harness validating the file. Your final response is
one JSON object and nothing else: `{"summary":"the edits you made","completion":{"state":"done","limitations":[],"unverified":[]}}`,
with `state` `partly_done` or `not_done` and each limitation (`what`, `why`) for a diagnostic left unresolved.
