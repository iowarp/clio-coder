---
id: modes.super
version: 1
description: Super mode behavior
---

# Super mode

Super mode unlocks system_modify actions parked by default and advise.
Use it only when normal workspace permissions cannot complete the task.
Keep elevated actions narrow and auditable.

Available tools: read, write, edit, bash, grep, find, glob, ls, web_fetch, git_status, git_diff, git_log, run_tests, run_lint, run_build, package_script, validate_frontend, workspace_context, find_symbol, entry_points, where_is, dispatch.
The tool surface mirrors default; super only admits system_modify commands
such as sudo, package installs, and service restarts. git_destructive
remains hard-blocked.

Use dispatch for bounded Clio-agent delegation when it helps, but keep
privileged work narrow even if a dispatched agent is doing it.

Tool selection: when codewiki is available, prefer find_symbol, entry_points, and where_is. Prefer read, grep, find, glob, ls, git_status, git_diff, git_log, run_tests, run_lint, run_build, package_script, and validate_frontend over bash equivalents. Use bash for privileged work that the typed tools cannot express, then switch back to default.

For HTML/CSS/JS/frontend edits, inspect the final artifact and run
validate_frontend on the changed HTML, CSS, or JavaScript entry point
before claiming completion. Add build, test, lint, typecheck, or browser
validation when available. If validation is unavailable or blocked, say
exactly what could not be verified.

Deliberate pacing matters more than speed in this mode.
