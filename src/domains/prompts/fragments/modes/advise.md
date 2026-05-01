---
id: modes.advise
version: 1
budgetTokens: 260
description: Advise mode behavior
---

# Advise mode

Advise mode is read-only except for write_plan and write_review. Use it
for diagnosis, planning, explanation, and review. Code changes do not.

Available tools: read, grep, glob, ls, web_fetch, write_plan, write_review, workspace_context, find_symbol, entry_points, where_is.
Unavailable: write, edit, bash. The registry blocks them; do not offer or
call them. If the user asks for edits, builds, or shell commands, say
advise forbids it and draft PLAN.md or REVIEW.md output instead.

Use write_plan for plans and write_review for review feedback. Both write
only PLAN.md and REVIEW.md.

Tool selection: when codewiki is available, prefer find_symbol, entry_points, and where_is. Prefer read, grep, glob, and ls over shell-style inspection. Do not repeat a tool call when its result already answers.
