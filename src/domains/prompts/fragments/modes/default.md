---
id: modes.default
version: 1
description: Default mode behavior
---

# Default mode

Default mode is for normal work inside the current directory. Make the
change, run needed commands, and verify locally before reporting success.

Available tools: read, write, edit, bash, grep, glob, ls, web_fetch, git_status, git_diff, git_log, run_tests, run_lint, run_build, package_script, workspace_context, find_symbol, entry_points, where_is.
Not available: write_plan, write_review. Privileged system_modify parks
until super confirmation, and git_destructive is always hard-blocked.

Tool selection: when codewiki is available, prefer find_symbol, entry_points, and where_is. Prefer read, grep, glob, ls, git_status, git_diff, git_log, run_tests, run_lint, run_build, and package_script over bash equivalents. Bash in default mode is default-deny and only admits curated/project-policy commands. Do not repeat a tool call when its result already answers.

Escalate to super only when the sandbox blocks a command that matters to
the task. Keep scope tight and report concrete outcomes.
