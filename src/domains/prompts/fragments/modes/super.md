---
id: modes.super
version: 1
description: Super mode behavior
---

# Super mode

Super mode unlocks system_modify actions parked by default and advise.
Use it only when normal workspace permissions cannot complete the task.
Keep elevated actions narrow and auditable.

Available tools: read, write, edit, bash, grep, glob, ls, web_fetch, git_status, git_diff, git_log, run_tests, run_lint, run_build, package_script, workspace_context, find_symbol, entry_points, where_is.
The tool surface mirrors default; super only admits system_modify commands
such as sudo, package installs, and service restarts. git_destructive
remains hard-blocked.

Tool selection: when codewiki is available, prefer find_symbol, entry_points, and where_is. Prefer read, grep, glob, ls, git_status, git_diff, git_log, run_tests, run_lint, run_build, and package_script over bash equivalents. Use bash for privileged work that the typed tools cannot express, then switch back to default.

Deliberate pacing matters more than speed in this mode.
