---
description: Save, inspect, or restore a validated research checkpoint archive.
argument-hint: "[save|restore|list] [label or archive filename]"
---

Read ${component:resource:clio-execution} and ${component:resource:research-policy}.
Parse the subcommand from $ARGUMENTS; default to save. Invoke the research-state
helper through bash with validated, quoted arguments.

For save, choose a path-safe label and run
`python3 "${component:script:research-state}" checkpoint save LABEL`.
Read the JSON receipt and verify the named archive exists. It excludes data and
previous checkpoints. Save does not require git and creates no tag.

For list, run `python3 "${component:script:research-state}" checkpoint list`
and display the returned archive names. No state change or interview is needed.

For restore, first list available archives and resolve one exact returned name.
Tell the researcher that saved state and task artifacts replace current ones,
including removal of later artifacts, while data and checkpoints are preserved.
Collect confirmation with ask_user. Cancellation leaves state untouched. Save a
`before-restore` checkpoint, then run
`python3 "${component:script:research-state}" checkpoint restore NAME --confirmed`.
The helper validates all archive members and their digests before replacing state.
Read STATE.md, WORKFLOW.md and the restored file inventory before reporting success.
A failed helper call is not a restored checkpoint. Offer progress after restoration.
