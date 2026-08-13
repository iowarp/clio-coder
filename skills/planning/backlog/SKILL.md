---
name: backlog
description: Use when a finished PRD or architecture doc must become a real ticket backlog — "create the stories", "turn this PRD into issues", "build the backlog". Decomposes phases and user stories into small tickets with verifiable acceptance criteria, confirms the list, then creates them as GitHub issues (or in another tracker when an integration exists). Not for local sprint slicing into a SPRINT.md; use cut-it.
version: 0.2.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - bash
  - tasks
  - ask_user
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/planning/backlog
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/backlog
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
---

# Backlog

Turn a finished planning doc into small, engineer-ready tickets on a real
tracker. Decomposition is tracker-agnostic; creation branches on the target.

## Step 1 — Inputs

Required: the path to the PRD or planning doc. Target platform: GitHub
issues via `gh` by default; another tracker only when the user names it and
an integration for it is available. Platform genuinely ambiguous → ask,
never guess. Optional: a milestone or epic to attach tickets to.

## Step 2 — Decompose

Read the doc in full. Each implementation phase becomes a ticket group;
each user story becomes one or more tickets. Per ticket, draft:

- **Title**: imperative and specific ("Add token refresh endpoint", never
  "Auth").
- **Description**: what and why, linked back to the source doc's phase.
- **Acceptance criteria**: a checklist a reviewer can verify — observable
  behavior, not "works correctly".
- **Phase label**: `phase-N` from the source doc.

Sizing rules: a ticket is at most about a day of work; a ticket that needs
more than one screen to describe is two tickets. A phase too vague to
decompose is a gap in the source doc — stop and flag it rather than
inventing tickets.

## Step 3 — Confirm before creating

Print the full proposed list (titles grouped by phase) and the target
platform, and get explicit confirmation via `ask_user`. Ticket creation is
outward-facing and not one-click reversible; nothing is created before the
yes.

## Step 4 — Create

GitHub:

```bash
gh label create "phase-N" 2>/dev/null || true
gh issue create --title "..." --body "..." --label "phase-N" [--milestone "..."]
```

Acceptance criteria go in the body as a markdown checklist. Capture every
created issue number and URL. A failed create is reported per ticket, not
papered over.

Local fallback: when the workspace has no GitHub remote, gh is unavailable,
or the user asks for local tracking, create each confirmed ticket with the
`tasks` tool instead (one task per ticket, acceptance criteria in the
description) and capture the task ids. Say which target was used and why.

## Step 5 — Report

A table: title → phase → issue number/URL, plus the source doc path and any
failures. Done when every proposed ticket is either created with its URL
captured or listed as failed with the error.

## Red flags

- Tickets created before the Step 3 confirmation.
- Acceptance criteria that restate the title.
- A mega-ticket hiding a week of work.
- Tickets with no trace back to a phase or story in the source doc.
