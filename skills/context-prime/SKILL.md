---
name: context-prime
description: Use when a coding session begins, when resuming work after a break, or when you land in an unfamiliar or in-progress repository and need to orient before acting. Loads the last handoff, git state, the project constitution, and active-work signals so a fresh agent reconstructs intent instead of guessing. Triggers on "prime", "catch me up", "where were we", "get up to speed", or the first substantive request in a new session.
version: 0.2.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - glob
  - ls
  - find
  - git_status
  - git_diff
  - git_log
  - workspace_context
  - entry_points
  - where_is
  - find_symbol
  - ask_user
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/context-prime
audit: pass
---

# Context Prime

Reconstruct the state a previous session left behind, in one bounded pass,
before taking any non-trivial action. A fresh agent has the code but not the
*intent*; this rebuilds the intent.

This is the read-side bookend of `context-handoff`. It consumes what `context-handoff` wrote.
It is not `/resume` — that restores an engine session's transcript; this
reconstructs orientation a transcript alone doesn't carry.

## When to use

- The first substantive request of a new session.
- Resuming a project after time away, or picking up another agent's work.
- The user says "catch me up", "where were we", "prime", "get up to speed".

Skip it for a one-line question in a repo you already have full context on.

## Procedure

Work top to bottom; stop early once you have enough to state where things stand.

1. **Constitution.** Read the project's instruction file if present, in order of
   preference: `CLIO.md`, then `AGENTS.md`, `CLAUDE.md`, else `README.md`. Note
   hard invariants and workflow rules. Do not re-derive what it already states.

2. **Last handoff.** Read the newest `.clio/handoffs/handoff-*.md`; if none,
   fall back to `NEXT-SESSION.md` at the repo root. This is the previous
   session's brief: focus, work-in-progress, blockers, suggested skills.

3. **Git state.** Capture branch, uncommitted changes, and recent commits
   (`workspace_context` and `git_status` when available, else `git status -sb`
   and `git log --oneline -10`). Reconcile against the handoff's "work in
   progress" — flag anything that drifted (committed since, reverted, conflicts).

4. **Active signals.** Check `.clio/state.json` and codewiki freshness if
   present. Treat stale summaries as hints, never as authority over source.
   A v1 or missing `.clio/codewiki.json` may rebuild on demand through
   codewiki tools, but source files remain authoritative.

5. **Skills.** The `# Skills` catalog is already in context. Note any the
   handoff suggested for the next step; do not scan the filesystem for them.

6. **Orient.** Produce a short orientation (template below) and **confirm the
   focus with the user before non-trivial action** — via `ask_user` with the
   handoff's suggested focus as the first option when the tool is available,
   else in plain text. If the handoff and git state disagree, surface the
   conflict rather than picking silently.

## Orientation template

```markdown
## Session orientation — [YYYY-MM-DD]

- **Project**: [name] · branch `[branch]` · [N] uncommitted file(s)
- **Last session focus**: [from handoff, or "no handoff found"]
- **State**: [1–2 lines: what's done, what's mid-flight]
- **Next**: [the focus to confirm]
- **Blockers / open questions**: [if any]
- **Suggested skills**: [from handoff, or omit]
```

## Boundaries

- Bounded by design: summarize and reference by path; do not dump file trees or
  copy long documents into context.
- Read-only. context-prime orients; it does not start editing. The user confirms
  the focus first.
- Degrade gracefully: missing `CLIO.md` → next constitution file; missing Clio
  tools → plain `git`; no handoff → say so and orient from git + constitution.
