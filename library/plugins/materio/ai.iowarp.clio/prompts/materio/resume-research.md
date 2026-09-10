---
description: "Resume research from a paused state; shows current position and suggests next action"
---

<clio_execution>
Read ${component:resource:clio-execution} before acting. It defines argument parsing,
research state helpers, interview ownership, readback, and optional recording.
</clio_execution>

<objective>
Load research state and resume from the last paused or in-progress task. Equivalent to /wtfp:progress but triggers active resumption.
</objective>

<process>

## 1. Read State

```bash
cat .research/STATE.md 2>/dev/null
cat .research/WORKFLOW.md 2>/dev/null
```

## 2. Find Paused or Next Pending Task

Look for tasks with status `☐ paused` first, then `☐ pending`.

Change `☐ paused` back to `☑ in-progress` if found.

## 3. Show Resumption Context

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materio ► RESUMING RESEARCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Research:   [prompt]
Resuming:   Task [N]; [name]
Last saved: [timestamp from STATE.md]

Task context:
[full task block from WORKFLOW.md]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 4. Update STATE.md

Set status = "active", record the resume timestamp. Only if `commit_research` is true in `.research/config.json`:
```bash
python3 "${component:script:research-state}" record --message "research: resume at task [N]; [task name]" --files "${CHANGED_FILES[@]}"
```

## 5. Offer Next Action

Suggest: `/materio:execute-task [N]` to continue, or `/materio:progress` for full overview.

</process>

<success_criteria>
- [ ] Paused task identified and status restored to in-progress
- [ ] Full task context shown to orient the user
- [ ] STATE.md updated
- [ ] Next command clearly offered
</success_criteria>
