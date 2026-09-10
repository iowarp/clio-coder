---
description: "Archive a task; moves it to the Archived section of WORKFLOW.md, out of active execution"
argument-hint: "[task number N]"
---

<clio_execution>
Read ${component:resource:clio-execution} before acting. It defines argument parsing,
research state helpers, interview ownership, readback, and optional recording.
</clio_execution>

<execution_context>
@.research/WORKFLOW.md
</execution_context>

<objective>
Move a task to the Archived Tasks section of WORKFLOW.md. Archived tasks are preserved for reference but excluded from /materio:execute-task and progress tracking. Preferred over remove-task when the task might be relevant later.
</objective>

<context>
Task number: $ARGUMENTS
</context>

<process>

## 1. Validate

```bash
test -f .research/WORKFLOW.md || echo "ERROR: No WORKFLOW.md."
[ -z "$ARGUMENTS" ] && echo "ERROR: Provide task number. Usage: /materio:archive-task 3" && exit 1
```

## 2. Show Task and Gather Reason

Display the task entry.

Use ask_user:
- header: "Archive Task [N]: [name]"
- question: "Why are you archiving this task? (This note is saved for future reference)\n\n[full task block]"
- options: "No longer needed for this research" | "Deferred to future work" | "Replaced by another task" | "Resource/time constraint" | "Other reason"

## 3. Move Task to Archived Section

- Change task status to `☐ archived`
- Move the task block from the active Tasks section to the `## Archived Tasks` section in WORKFLOW.md
- Add archive note and reason

## 4. Update Dependencies

If any active task depends on this task, warn user and ask how to handle the dependency.

## 5. Record

Only if `commit_research` is true in `.research/config.json`:
```bash
python3 "${component:script:research-state}" record --message "research: archive task [N]; [reason]" --files "${CHANGED_FILES[@]}"
```

</process>

<success_criteria>
- [ ] Task moved to Archived section (not deleted)
- [ ] Archive reason recorded
- [ ] Active task list clean
- [ ] Dependencies in other tasks flagged if affected
</success_criteria>
