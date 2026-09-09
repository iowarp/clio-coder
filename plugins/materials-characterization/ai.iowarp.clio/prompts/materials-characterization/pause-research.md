---
description: Save the current research position and pause active work.
---

Read ${component:resource:clio-execution}. Inspect WORKFLOW.md, STATE.md, and
actual partial task files. Record the active task, completed preparation, pending
physical work, decisions, missing inputs, and exact next action. Mark the task
paused without changing its identity or claiming unfinished results. Confirm any
missing continuation details with ask_user. Read the updated documents back.
Run `python3 "${component:script:research-state}" checkpoint save paused` and
verify its receipt. Offer resume-research and show the saved continuation. If
optional recording is enabled, pass only the changed named files to record.
