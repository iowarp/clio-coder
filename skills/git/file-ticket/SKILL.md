---
name: file-ticket
description: Use when something noticed mid-session must become a tracker issue — "file a ticket", "open an issue for this", "log this bug", "ticket this behavior". Captures evidence from the live session, dedups against existing issues, composes a labeled issue with acceptance criteria, confirms, and creates it via gh. Filing only; never fixes. Not for batch ticket creation from a PRD; use backlog. Not for diagnosing an existing issue; use investigate-issue.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - git
  - bash
  - ask_user
  - artifact
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/file-ticket
  audit: pass
  provenance: designed
  eval-status: scenarios-recorded
  model-size: any
  agents:
    - main
    - git-master
---

# File Ticket

Turn one observed behavior into one well-formed tracker issue, then stop.
The ticket is the deliverable; the fix belongs to a later skill in the
pipeline (investigate-issue, then an implementation task).

## Step 1 — Capture

From the session that surfaced the behavior, record before anything scrolls
away:

- **Type**: bug, enhancement, docs, or question. Uncertain → ask, never
  guess between bug and enhancement.
- **Observed vs expected**: what actually happened, in the reporter's words,
  and what should have happened.
- **Reproduction**: the exact commands, slash commands, or session steps
  that showed the behavior. Only steps actually performed; a repro you did
  not run is written as "unverified".
- **Evidence**: when the code location is already known or findable in one
  short grep pass, cite it as `file:line`. This is a pointer for the
  investigator, not a root-cause analysis; stop after at most a few minutes
  of looking.

Complete when every bullet above is either filled or explicitly marked
unknown.

## Step 2 — Dedup

```bash
gh issue list --search "<key terms>" --state all --limit 20
```

Requires an authenticated gh CLI; if the command fails, report the exact
failure and stop rather than filing blind. An open duplicate → comment the
new evidence on it instead of filing, and report that issue's URL as the
outcome. A closed duplicate → file the new issue and link the closed one
in the body.

## Step 3 — Compose

- **Title**: conventional tag plus a specific imperative summary, matching
  the repo's issue templates (`fix: memory overlay cannot scroll`, `feat:`,
  `docs:`). Never a bare noun.
- **Body sections**: Problem (observed vs expected), Reproduce, Evidence
  (`file:line` pointers and session excerpts), Acceptance criteria as a
  markdown checklist a reviewer can verify from observable behavior, and
  Links (duplicates, related issues, source docs).
- **Labels**: one type label (`bug`, `enhancement`, `documentation`,
  `question`) plus every applicable `area:*` label that exists in the repo
  (`gh label list`). Missing area label → propose it in Step 4 rather than
  creating it silently.
- **Milestone**: the open milestone for the next release when the work
  clearly belongs there; otherwise none.

## Step 4 — Confirm

Show the full title, body, labels, and milestone, and get an explicit yes
via `ask_user`. Issue creation is outward-facing; nothing is created before
the yes. The user trimming scope here is normal — file what they confirm.

## Step 5 — Create and hand off

```bash
gh issue create --title "..." --body-file "$tmpdir/body.md" --label "..." [--milestone "..."]
```

Write the body to a file and pass `--body-file`; a body inlined in a
double-quoted shell string loses every backtick span to command
substitution. Run the create exactly once, then verify with
`gh issue view` before any retry; a retry after an unread result is how
duplicates happen. Report the issue number and URL, and name the next pipeline step: bugs that
need diagnosis go to investigate-issue; small well-understood items can go
straight to a worktree. Done when the URL is reported or the duplicate path
ended at an existing issue.

## Red flags

- Filing without the Step 2 dedup search.
- Sliding into fixing the bug instead of filing it.
- Acceptance criteria that restate the title.
- Reproduction steps written from imagination rather than the session.
- Creating labels or milestones nobody approved.
- Batch-filing many tickets; that is backlog's job.
