---
name: fix-issue
description: "Resolves a tracker issue end to end: fetches it, diagnoses only when the issue does not name the code, fixes test-first, and self-reviews against the acceptance criteria, leaving a verified uncommitted change. Not for filing; use file-ticket. Not for committing or PRs; use ship."
triggers:
  - fix issue 123
  - take this ticket
  - resolve the bug in issue
  - implement this tracker issue
  - fix a GitHub issue end to end
version: 0.2.0
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
  - edit
  - artifact
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/fix-issue
  audit: pass
  provenance: designed
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
    - coder
---

# Fix Issue

Resolve one tracker issue: diagnose only as much as the issue leaves
unknown, fix test-first, verify against the issue's own acceptance
criteria. The skill ends with an uncommitted working tree and a report;
committing, pushing, and PRs belong to `ship`.

## Step 1 — Fetch and gate

`gh issue view <id>`; if that fails (older gh, GraphQL changes), fall back
to `gh api repos/<owner>/<repo>/issues/<id>` and `.../issues/<id>/comments`.
Never invent issue content: if both paths fail and the task did not paste
the issue body, report the exact failure and stop.

Gates before any code:

- Issue closed → report it; continue only on explicit confirmation.
- A linked PR already exists → warn and confirm before continuing.
- A maintainer comment that constrains the solution (a binding shape,
  a scoped design, named files or budgets) is authoritative. Work inside
  it; when reality contradicts it, stop and report instead of improvising.

## Step 2 — Diagnose only the unknown

Read the issue's evidence first. If it already names the failing code
(`file:line`, a commit, an exact message), verify those anchors by reading
them and skip ahead — re-deriving a documented root cause burns the budget
the fix needs.

When the cause is genuinely unknown, close the gap with a why-chain, each
link carrying evidence you actually read:

```
WHY <symptom>?  → because <cause>   (evidence: file.ts:123)
ROOT CAUSE: <the exact code to change>  (evidence: file.ts:789)
```

A link without a cited line is a hypothesis. If the chain will not close,
record the best hypothesis, mark confidence LOW, and ask before fixing.
Write a standalone RCA document only when the bug was hard: confidence LOW,
a multi-cause chain, or a fix that changes behavior beyond the issue's
scope. Routine fixes carry their why-chain in the final report, not a file.
Either way the RCA's destination is the issue: `ship` posts it as the
closing comment under the `rca` label (see docs/development-pipeline.md).

## Step 3 — Fix test-first

Write the test that reproduces the defect and watch it fail for the stated
reason. Then make the smallest change that fixes the root cause, not the
symptom. Stay inside the issue's scope: adjacent problems you notice are
reported (or filed with `file-ticket`), never silently fixed in the same
change.

## Step 4 — Verify

Run the reproducing test, the project's full check suite, and every
validation command the issue names. Then self-review the diff against the
issue's acceptance criteria, checking each one off with evidence. Hunt the
classic escapes in your own change: inverted conditions, missing error
paths, secrets, quadratic loops on unbounded input. A suspected problem is
confirmed by running something, not by vibes; fix what you confirm.

## Step 5 — Report and stop

Leave the change uncommitted. Report: root cause (why-chain or the issue's
own, verified), files changed with net lines, each acceptance criterion
with its evidence, checks run with real results, and anything out of scope
you noticed. Failing or skipped checks are stated as such — never implied
green. Hand off to `ship` only when the user asks.

## Red flags

- Re-deriving a root cause the issue already documents.
- A fix with no failing test that preceded it.
- "All checks pass" without naming the checks and their output.
- Silently widening scope beyond the issue.
- Committing, pushing, or opening a PR from this skill.
