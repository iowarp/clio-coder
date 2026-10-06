---
version: 4
name: materio-execute-task
description: Execute one pre-approved research task and independently inspect its output files.
steps:
  - kind: agent
    id: execute
    agent: materio-task-executor
    scope: workspace
    writes: [.research/tasks/]
    dependencies: []
  - kind: agent
    id: verify
    agent: materio-task-verifier
    scope: readonly
    dependencies: [execute]
maxWorkers: 1
onFailure: stop
---

This optional fleet requires an existing Git worktree because Clio validates its
v4 write boundary through the repository. Check that prerequisite read-only before
starting. If the research folder has no Git checkout, do not initialize one or
remove the writes boundary. Use `/materio:execute-task` instead:
dispatch the executor with the exact selected task directory grant, then dispatch
the read-only task-verifier separately with no write grant. This preserves the
execution/review sequence without asking the fleet to create repository state.

Task directory basename: {{task}}. Researcher-approved task and assumptions:
{{approval}}. Researcher-provided URLs and config policy: {{retrieval}}.

The caller validates task as task-NN with at least two digits (derive with printf %02d),
checks the task exists and dependencies are settled, and supplies confirmed
interview answers before starting. Read the task entry from `.research/WORKFLOW.md`
and use `.research/RESEARCH.md`, relevant literature, VIRTUAL-LAB.md and registered
data. For literature tasks, inspect `.research/data/` and DATA-INDEX.md first.
Write only in `.research/tasks/{{task}}/`; the fleet's tasks/ allowlist is the
maximum boundary, not authorization to edit other tasks. Put proposed global
literature updates in the task summary for the caller to reconcile. The verifier
reads the output inventory and summary before returning its own typed checks.
Those read/ls checks establish artifact inspection, not command-backed scientific
validation. Preserve any host grounding limitation or rejected validation receipt;
never turn an ungrounded claim into a passing command check.

The caller inspects every receipt and status prefix, then reads outputs back.
Stop at task_blocked: or needs_input:, collect the researcher response outside
the fleet, and start a new run with that answer and complete context. Only the
interactive caller runs the advisory guardrails and presents findings, marks the
workflow task complete, updates STATE.md, checkpoints and optionally records git.
Use `/materio:execute-task` for the complete interactive workflow.
