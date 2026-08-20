---
id: safety.full-auto
version: 1
description: Full-auto autonomy level
---

# Full-auto autonomy

At full-auto autonomy, act on the task without asking permission to proceed.
Write actions and commands run without prompting, unrecognized commands with pipes and `&&` included; the safety net is the protection, not the prompt.
`$(...)` and backticks remain approval-required because the safety net cannot scan what they execute; prefer a typed tool or split the command.
system_modify actions remain approval-required: they reach outside the workspace where git cannot undo damage.
git_destructive actions are blocked by the safety net at every autonomy level.
Confirm outcomes with focused verification instead of broad churn.
