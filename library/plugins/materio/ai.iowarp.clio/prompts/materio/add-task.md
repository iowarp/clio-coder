---
description: "Add a new task to the research workflow"
---

<clio_execution>
Read ${component:resource:clio-execution} before acting. It defines argument parsing,
research state helpers, interview ownership, readback, and optional recording.
</clio_execution>

<execution_context>
@.research/WORKFLOW.md
</execution_context>

<objective>
Add a new task to WORKFLOW.md through a short interview. Inserts at the end or at a specified position.
</objective>

<context>
No arguments.
</context>

<process>

## 1. Read Current Workflow

```bash
test -f .research/WORKFLOW.md || echo "ERROR: No WORKFLOW.md. Run /materio:define-research-tasks first."
cat .research/WORKFLOW.md
```

Count current tasks and show the list.

## 2. Gather Task Details

Use ask_user:
- header: "Add Task"
- question: "Define the new task:\n1. **Name**: Short descriptive name\n2. **Type**: literature | experimental | computational | data-analysis | analytical | writing\n3. **Description**: What needs to be done?\n4. **Inputs**: What data or prior task output does this need?\n5. **Expected output**: What will this task produce?\n6. **Position**: After which task? (default: end of list)\n7. **Dependencies**: Which tasks must complete first?"
- options: "Provided all details" | "Guide me through each field"

## 3. Generate New Task Entry

Run `python3 "${component:script:research-state}" next-task-id` to allocate a stable ID above active, archived, and on-disk IDs. Insert the entry at the chosen presentation position without renumbering any existing task, directory, output, or dependency. IDs use at least two digits (Task 07, Task 12). Interview the new task assumptions using the task-type guidance before finalizing its entry.

Write the new task block into WORKFLOW.md at the correct position.

## 4. Create Task Directory

```bash
mkdir -p ".research/tasks/task-$(printf '%02d' "$((10#$N))")"
```

## 5. Record

Only if `commit_research` is true in `.research/config.json`:
```bash
python3 "${component:script:research-state}" record --message "research: add task [NN]; [task name]" --files "${CHANGED_FILES[@]}"
```

</process>

<success_criteria>
- [ ] New task has all required fields
- [ ] Task identity is unique and stable; numbering gaps are allowed
- [ ] Task directory created
- [ ] WORKFLOW.md updated; committed only if commit_research is true
</success_criteria>
