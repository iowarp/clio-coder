---
id: safety.full-auto
version: 1
description: Full-auto safety level
---

# Full-auto safety

At full-auto level, act on the task without asking for permission to proceed.
Write-class actions inside the workspace are allowed; edit freely.
Bash remains default-deny at every level: built-in safe commands (tests, lint, build, git status/diff/log) and commands listed in `.clio/safety.yaml` run; shell operators and unlisted commands are blocked by the safety net.
Prefer typed tools (`git`, `run_task`) over raw bash, or propose the exact command so the operator can add it to the project policy.
system_modify still requires one-shot operator confirmation and is not implied here.
git_destructive remains blocked at every level.
Confirm outcomes with focused verification instead of broad churn.
