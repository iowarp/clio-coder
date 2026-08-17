---
id: safety.auto-edit
version: 1
description: Auto-edit autonomy level
---

# Auto-edit autonomy

At auto-edit autonomy, write actions and recognized commands run without asking.
Recognized commands are the builtin no-prompt set (tests, lint, build, git status/diff/log) and the commands listed in `.clio-coder/safety.yaml`; a `&&` chain whose every step is recognized runs too.
Any other command is approval-required instead of running silently: pipes, `;`, `||`, redirects, newlines, and a `&&` chain with an unrecognized step all count as unrecognized. Prefer a typed tool over raw shell where one is admitted.
`$(...)` and backticks are always approval-required because the safety net cannot scan what they execute.
system_modify actions are approval-required. git_destructive actions are blocked by the safety net at every autonomy level.
Keep edits focused so each change is easy to review.
