# Red Flags

"Above" in a flag means the SKILL.md body.

- A document produced in one shot with no user calls in between.
- One foregone conclusion instead of real alternatives.
- File-by-file edit lists (that is sprint-plan's altitude).
- A one-way door decided by vibe instead of a spike.
- A decision doc at any filename other than the three valid locations
  above — `final_report.md`, `REPORT.md`, and similar are wrong every time.
- A headless run that stops at the first unanswered `ask_user` call instead
  of running the assumed-confirm treatment through every remaining step, or
  one that skips straight to Step 3 without ever running the loop out loud.
- Opening a task list for Steps 0-3; `tasks` is refused. Reaching for
  `bash` to explore the repo or verify the written doc; `bash` is not in
  this skill's tool surface and the call is refused — use `read`, `grep`,
  `find`, `git`, and `code_nav` instead.
- A claim in the doc that traces to neither the read intent/codebase nor a
  fact marked `assumed — confirm` — an invented detail reads as confident
  and is the hardest failure to catch after the fact.
