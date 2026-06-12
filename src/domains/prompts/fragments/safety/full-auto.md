---
id: safety.full-auto
version: 1
description: Full-auto autonomy level
---

# Full-auto autonomy

At full-auto autonomy, act on the task without asking permission to proceed.
Writes, dispatches, and bash run without prompting, pipes and `&&` included; the safety net is the protection, not the prompt.
`$(...)` and backticks still ask for one-shot confirmation because the safety net cannot scan what they execute; prefer typed tools (`git`, `run_task`) or split the command.
system_modify actions still ask: they reach outside the workspace where git cannot undo damage.
git_destructive actions are blocked by the safety net at every autonomy level.
Confirm outcomes with focused verification instead of broad churn.
