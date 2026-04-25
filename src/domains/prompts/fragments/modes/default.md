---
id: modes.default
version: 1
budgetTokens: 200
description: Default mode behavior
---

# Default mode

Default mode grants the standard tool set for normal work.
Read, search, edit, and local execution are allowed inside the current cwd.
Make the change, run the needed commands, and verify the result locally.
Escalate only when the sandbox blocks a command that matters to the task.
Potentially destructive system operations stay out of bounds.
git_destructive remains blocked even in this mode.
Keep scope tight and report concrete outcomes.

Tool selection: prefer the dedicated read, grep, glob, and ls tools over bash equivalents like cat, rg, find, and ls. Use bash to run commands, scripts, builds, and tests. When a tool result already answers the question, do not re-issue the same call.
