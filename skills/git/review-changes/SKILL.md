---
name: review-changes
description: Use before committing, when the user asks to review the uncommitted work — "review my changes", "check this before I commit", "pre-commit review". Reads changed files in full against the project's documented standards, hunts real bugs and security issues, verifies findings before reporting them, and writes a severity-ranked report. Not for reviewing a branch or PR range; use the repo's review tooling for that.
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
  - write
  - artifact
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/review-changes
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/review-changes
  eval-status: smoke-checked
  model-size: large
  agents:
    - main
    - coder
    - git-master
---

# Review Changes

Technical review of the uncommitted work: real bugs, security, standards.
Style nitpicks a formatter or linter would catch are not findings.

## Step 1 — Load the project's bar

Read the standards the diff will be judged against: the project instruction
file (`CLIO.md`, `AGENTS.md`, `CLAUDE.md`), README, and documented standards
under `docs/`. A finding that contradicts a documented project convention is
wrong, not the code.

## Step 2 — Collect the change set

```bash
git status
git diff HEAD
git diff --stat HEAD
git ls-files --others --exclude-standard
```

Read every changed and new file in full, not just the diff hunks: bugs live
in the interaction between the changed lines and the unchanged context.

## Step 3 — Analyze each file

Check, in priority order:

1. **Logic errors**: off-by-one, inverted conditionals, missing error
   handling, race conditions, broken edge cases.
2. **Security**: injection, unsafe data handling, secrets or keys in code —
   flag these CRITICAL.
3. **Performance**: N+1 patterns, quadratic loops on unbounded input, leaks,
   repeated computation.
4. **Quality**: duplication a nearby helper already solves, functions doing
   three jobs, misleading names, missing types where the project types.
5. **Standards**: the documented conventions from Step 1 — testing, logging,
   typing, structure.

## Step 4 — Verify before reporting

A suspected issue is confirmed by evidence, not vibes: run the specific test
that exercises it, trigger the type checker, or trace the failing input
concretely. A finding you could not verify is reported as "unverified" with
the reason, or dropped when the check proved it wrong.

## Step 5 — Report

Write `.clio/reviews/<YYYY-MM-DD>-<slug>.md` (`.clio/` is local and
ignored). Header stats: files modified/added/deleted, lines added/deleted
(from `git diff --stat`). Then each finding:

```
severity: critical|high|medium|low
file: path/to/file.ts
line: 42
issue: <one line>
detail: <why this is a problem, concretely>
suggestion: <the fix>
verified: <how, or "unverified: <reason>">
```

Order findings by severity. If nothing survived verification, write exactly
that: "Review passed. No verified technical issues." Done when the report
file exists and its path plus a severity count summary has been given to the
user.

## Red flags

- Findings quoted from the diff without reading the surrounding file.
- Style complaints dressed up as findings.
- A "critical" that was never verified.
- Rewriting the code instead of reviewing it — this skill only reports.
