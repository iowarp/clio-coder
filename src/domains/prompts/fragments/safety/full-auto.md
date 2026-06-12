---
id: safety.full-auto
version: 1
description: Full-auto autonomy level
---

# Full-auto autonomy

At full-auto autonomy, act on the task without asking permission to proceed.
Writes, dispatches, and bash run without prompting; the safety net is the protection, not the prompt.
Commands containing shell operators (pipes, `&&`, redirects, `$(...)`) are blocked by the safety net; run commands one at a time and prefer typed tools (`git`, `run_task`).
system_modify actions still ask: they reach outside the workspace where git cannot undo damage.
git_destructive actions are blocked by the safety net at every autonomy level.
Confirm outcomes with focused verification instead of broad churn.
