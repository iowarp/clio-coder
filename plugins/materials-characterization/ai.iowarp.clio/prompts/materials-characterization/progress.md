---
description: "Show research progress with statusline, recent work, and smart routing to next action"
---

<clio_execution>
Read ${component:resource:clio-execution} before acting. It defines argument parsing,
research state helpers, interview ownership, readback, and optional recording.
</clio_execution>

<execution_context>
@.research/STATE.md
@.research/WORKFLOW.md
@.research/RESEARCH.md
</execution_context>

<objective>
Display a rich progress report with statusline, recent task completions, current position, and routing to the next action. Equivalent to /wtfp:progress but for research workflow.
</objective>

<process>

## 1. Validate

```bash
[ ! -f .research/RESEARCH.md ] && echo "No research project. Run /materials-characterization:identify-research." && exit 0
cat .research/STATE.md 2>/dev/null
cat .research/WORKFLOW.md 2>/dev/null
cat .research/RESEARCH.md 2>/dev/null | head -20
```

## 2. Build Statusline

```
Materials Characterization ► [N]/[total] tasks ◆ [phase: exploring|reviewing|executing|writing] ► [domain]
```

Display this first, before all other output.

## 3. Calculate Progress Metrics

From WORKFLOW.md, count:
- Total active tasks
- Complete tasks (☑ complete)
- In-progress tasks
- Pending tasks
- Archived tasks

Determine current phase:
- No LITERATURE.md → "exploring"
- LITERATURE.md exists, no WORKFLOW.md → "reviewing"
- WORKFLOW.md exists, tasks pending → "executing"
- All tasks complete → "writing"

## 4. Show Recent Work

Find task output files modified in the last 7 days:
```bash
find .research/tasks/ -newer .research/RESEARCH.md -name "*.md" 2>/dev/null | head -5
```

Show 1-line summary of recent task completions.

## 5. Display Progress Report

```
Materials Characterization ► [statusline]

# [Research Prompt]

**Phase:**    [exploring | reviewing | executing | writing]
**Progress:** [████████░░] [N]/[total] tasks
**Domain:**   [domain + sub-field]

## Recent Work
- Task [N] ([name]): [1-line output summary]

## Current Position
[Next pending task or current state]

## Key Decisions Made
[from STATE.md]

## Open Questions
[unresolved assumptions or decisions from WORKFLOW.md]
```

## 6. Route to Next Action

**Phase = exploring:** → `/materials-characterization:literature-review`
**Phase = reviewing:** → `/materials-characterization:define-virtual-lab` if VIRTUAL-LAB.md is missing, otherwise `/materials-characterization:define-research-tasks`
**Phase = executing, task in-progress:** → `/materials-characterization:execute-task [N]`
**Phase = executing, next pending task:** → `/materials-characterization:execute-task [N+1]`
**Phase = writing:** → `/materials-characterization:wtfp` or `/wtfp:progress`

Show the routed command clearly. If the researcher chooses it, follow its prompt flow with the existing context.

</process>

<success_criteria>
- [ ] Statusline displayed first
- [ ] Phase correctly determined
- [ ] Task progress shown with counts and visual bar
- [ ] Recent work summarized
- [ ] Smart routing to next command
</success_criteria>
