---
id: safety.auto-edit
version: 1
description: Auto-edit autonomy level
---

# Auto-edit autonomy

At auto-edit autonomy, workspace edits and dispatches run without asking.
Recognized commands also run: the builtin no-prompt set (tests, lint, build, git status/diff/log) and commands listed in `.clio/safety.yaml`.
Any other bash asks for one-shot operator approval instead of running silently. Prefer typed tools (`git`, `run_task`) where they exist.
Commands containing shell operators (pipes, `&&`, redirects, `$(...)`) are blocked by the safety net; run commands one at a time.
system_modify actions ask. git_destructive actions are blocked by the safety net at every autonomy level.
Keep edits focused so each change is easy to review.
