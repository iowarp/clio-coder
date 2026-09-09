---
description: "Register and index data files, papers, or datasets for use in research tasks"
argument-hint: "[file path or directory, optional]"
---

<clio_execution>
Read ${component:resource:clio-execution} before acting. It defines argument parsing,
research state helpers, interview ownership, readback, and optional recording.
</clio_execution>

<objective>
Register data files (experimental results, papers, datasets, scripts) into the .research/data/ index so that task executors can find and use them. Does not move files; records paths and metadata.

**Orchestrator role:** Accept file paths or scan for files, gather metadata via ask_user, write/update .research/DATA-INDEX.md.
</objective>

<context>
Optional file path: $ARGUMENTS
</context>

<process>

## 1. Find Files to Register

If $ARGUMENTS provided:
```bash
[ -f "$ARGUMENTS" ] && echo "File exists: $ARGUMENTS"
[ -d "$ARGUMENTS" ] && ls "$ARGUMENTS"
```

If no argument: scan for common data file types:
```bash
find . -name "*.csv" -o -name "*.xlsx" -o -name "*.txt" -o -name "*.pdf" \
       -o -name "*.dat" -o -name "*.json" -o -name "*.mat" -o -name "*.bib" \
       2>/dev/null | grep -v ".research" | grep -v ".claude" | grep -v ".git" | head -20
```

## 2. For Each File, Gather Metadata

Use ask_user (batch for multiple files):
- header: "Data Registration"
- question: "Found these files:\n[list]\n\nFor each, tell me:\n1. **Type**: experimental-data | paper | dataset | script | model-output | other\n2. **Description**: What does it contain? (1 sentence)\n3. **Relevant tasks**: Which workflow tasks use this data?\n4. **Format notes**: Units, column headers, any preprocessing needed?"
- options: "I'll describe them" | "Register all as-is with auto-detection"

## 3. Copy to .research/data/ (optional)

Use ask_user:
- header: "Copy Files?"
- question: "Copy files into .research/data/ for centralized storage, or just index their current locations?"
- options: "Copy into .research/data/" | "Index in-place (keep original location)"

If copy:
```bash
python3 "${component:script:research-state}" copy-data "$FILE"
```

## 4. Update DATA-INDEX.md

Write or append to `.research/DATA-INDEX.md`:

```markdown
## [filename]
- **Path**: [full path]
- **Type**: [type]
- **Description**: [description]
- **Relevant tasks**: Task [N], Task [M]
- **Format**: [format notes]
- **Registered**: [date]
```

## 5. Record

Only if `commit_research` is true in `.research/config.json`:
```bash
python3 "${component:script:research-state}" record --message "data: register [N] files; [brief description]" --files "${CHANGED_FILES[@]}"
```

</process>

<offer_next>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Materio ► DATA REGISTERED ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Index: .research/DATA-INDEX.md
Files: [N] registered

───────────────────────────────────────────

Data is now available to the literature reviewer and task executors.
Papers and .bib files feed `/materio:literature-review`; datasets feed `/materio:execute-task [N]`.

───────────────────────────────────────────

</offer_next>

<success_criteria>
- [ ] All provided files located and verified
- [ ] Type, description, and relevant tasks captured per file
- [ ] DATA-INDEX.md written/updated
- [ ] Files optionally copied to .research/data/
- [ ] Committed only if commit_research is true
</success_criteria>
