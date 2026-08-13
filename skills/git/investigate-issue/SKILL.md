---
name: investigate-issue
description: Use when a GitHub issue needs diagnosis before any fix — "investigate issue 123", "root-cause this bug", "what's behind this issue". Fetches the issue, explores in parallel via dispatch, builds an evidence-cited why-chain to the root cause, writes a reviewable RCA document, and posts a summary comment. Diagnosis only; the fix is a separate task. Not for failures without an issue; use scientific-debugging.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - find
  - ls
  - git
  - bash
  - context
  - code_nav
  - dispatch
  - write
  - artifact
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/investigate-issue
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/investigate-issue
  eval-status: smoke-checked
  model-size: large
  agents:
    - main
    - git-master
    - scout
    - researcher
---

# Investigate Issue

Diagnose a GitHub issue to a root cause backed by `file:line` evidence, and
leave a reviewable RCA artifact. No fix is implemented in this skill.

## Step 1 — Fetch the issue

`gh issue view <id>` (requires an authenticated gh CLI; if `gh auth status`
or the fetch fails, report the exact failure and stop — never invent issue
content). When the task itself carries the issue content (pasted title and
body), use that as the issue record, note the id it claims, and skip the
fetch. Note title, description, comments, labels.
Edge gates before going further:

- Issue already closed → report it; continue only if the user still wants
  the analysis.
- Issue already has a linked PR → warn and confirm before continuing.

## Step 2 — Explore in parallel

Dispatch two read-only workers in one call (`mode="parallel"`):

- `scout`: trace HOW the affected code works — integration points, data
  flow, error handling — returning `file:line` findings.
- `scout` (second task) or `researcher` when external docs matter: find
  WHERE the issue's error strings, related modules, and similar patterns
  live.

Merge the findings into a short map: `file:line` plus why each matters. If
dispatch is unavailable, do the same exploration inline with `grep`,
`code_nav`, and `read`, bounded to the affected area.

## Step 3 — Date the bug

```bash
git log --oneline -20 -- <relevant-paths>
git blame -L <start>,<end> <affected-file>
```

Classify: recent regression, long-standing bug, or original behavior. The
classification changes both fix and risk, so state it explicitly.

## Step 4 — Chain to the root cause

Chain why → because until you reach specific, fixable code. Every link
carries evidence you actually read:

```
WHY <symptom>?  → because <cause A>   (evidence: file.ts:123 — <snippet>)
WHY <cause A>?  → because <cause B>   (evidence: file.ts:456 — <snippet>)
ROOT CAUSE: <the exact code/logic to change>  (evidence: file.ts:789)
```

A link without a cited line is a hypothesis, not a link. If the chain cannot
be closed, stop trying to force it: record the best hypothesis, mark
Confidence LOW, and flag that a human should look before any fix runs.

## Step 5 — Write the RCA

Write to `docs/issues/issue-<id>.md`:

```markdown
# RCA: Issue #<id> — <title>

| Metric | Value | Reasoning (one grounded line each) |
|---|---|---|
| Severity | Critical/High/Medium/Low | user impact · workaround · scope |
| Complexity | Low/Medium/High | files touched · integration points |
| Confidence | High/Medium/Low | evidence quality · open unknowns |

## Problem
Expected: ... / Actual: ... / Symptoms: ...
Reproduction steps + whether reproduction was verified (yes/no).

## Root cause
The why-chain from Step 4, verbatim, with evidence.
Affected files/functions. Introduced by: <commit/era from Step 3>.

## Impact
Scope, affected features, workarounds, data/security concerns.

## Proposed fix
Strategy in 2-4 sentences. Files to modify, each with the change and the
reason it addresses the root cause. Alternatives considered. Risks.
Test cases needed and the exact validation commands.
```

Scope too large for one RCA → say so, focus on the core problem, list the
rest as out of scope and suggest follow-up issues.

## Step 6 — Post the summary

```bash
gh issue comment <id> --body "<assessment table · root cause in 1-2 lines · files to change · RCA: docs/issues/issue-<id>.md>"
```

Done when the RCA file exists with a cited why-chain and the comment is
posted (or the user declined the comment). Confidence LOW must be stated in
both places; it is the signal that a human reviews before anyone fixes.

## Red flags

- A root cause with no `file:line` evidence behind any link.
- Stopping at the symptom ("the null check is missing") without asking why
  it is missing.
- Confidence HIGH with unverified reproduction.
- Sliding into implementing the fix.
