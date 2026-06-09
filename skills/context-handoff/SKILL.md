---
name: context-handoff
description: Use when a session is winding down and work will continue in a new session or another agent, when context is about to be compacted or lost, or when the user asks for a handoff, brief, summary, or "notes for the next session." Produces a durable, redacted, reference-not-copy handoff document the next session can pick up from.
version: 0.1.0
license: Apache-2.0
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/context-handoff
audit: pass
---

# Context Handoff

Write a durable brief so a fresh session continues the work without re-reading
the whole transcript. This is the write-side bookend of `context-prime`, which
reads what this produces.

Distinct from two things it is often confused with:

- `/compact` summarizes *within* the current session; it is ephemeral and lost
  when the process exits. A handoff is a file that outlives the session.
- `/resume` restores a session's transcript. A handoff carries *intent*:
  decisions, rationale, and blockers that a transcript alone makes expensive to
  recover.

## When to use

- A long session is ending and work resumes later or in another context.
- Context is near its limit and about to be compacted away.
- The user asks for a handoff, brief, or "what should the next session know."

## Procedure

1. **Focus.** If the user passed arguments, treat them as the next session's
   focus and slug. Otherwise summarize all active threads.

2. **Gather state.** Capture git state and recent commits with
   `workspace_context` and `git_status` when available, else `git status -sb`
   and `git log --oneline -10`. Note uncommitted changes.

3. **Get the real date.** Run `date +%F`. Never fabricate the date.

4. **Draft** using the template below. Pull from the conversation: goals,
   decisions + rationale, work completed, work in progress (with the exact
   pick-up point), blockers, errors and what was tried.

5. **Reference, don't duplicate.** Point at PRDs, ADRs, plans, issues, and diffs
   by path or URL (`docs/adr/001.md`, a PR link). Do not paste their contents.

6. **Redact.** Remove API keys, tokens, secrets, passwords, and PII unless it is
   genuinely part of the project. Replace with `[REDACTED]` and note what was
   removed.

7. **Suggest skills** from the in-context `# Skills` catalog (do not scan the
   filesystem): name two to five the next session should invoke, one line each, tied to
   the next focus or the work in progress. Always include `context-prime` as the
   first step.

8. **Write** to `.clio/handoffs/handoff-YYYY-MM-DD[-slug].md`. `.clio/` is
   intentionally ignored by default unless the user force-adds something. Use
   `scripts/new-handoff.sh [slug]` (relative to this skill's base_dir) to
   resolve the date, ensure the directory exists, and print the target path.

9. **Confirm.** Tell the user the full path, a one-line summary, any blocker
   needing attention, and that the next session should run `context-prime`.

## Template

```markdown
# Handoff [YYYY-MM-DD]: [focus]

## Context
- **Project**: [name / repo] · branch `[branch]`
- **Session focus**: [what this session worked on]
- **Next session focus**: [user hint, or "TBD"]

## Goals
- [Overall objective]

## Work completed
- [Done]: [path or commit]

## Work in progress
- [WIP]: pick up at [file:line or task]

## Decisions & rationale
- [Decision]: because [reason]

## Blockers & open questions
- [Needs human input]

## Errors & gotchas
- [Notable failure and what was tried]

## Suggested skills
- context-prime: orient before acting
- [skill]: [why]

## References
- [path or URL]: [one line]
```

## Helper

`scripts/new-handoff.sh [slug]` prints the resolved target path and creates
`.clio/handoffs/` if needed. Write the document to the path it prints.
