---
name: backlog
description: Turns a finished PRD or architecture doc into a ticket backlog of small stories with verifiable acceptance criteria, confirmed, then created as GitHub issues or in another configured tracker. Not for local sprint slicing into a SPRINT.md; use sprint-plan.
triggers:
  - create the stories
  - turn this PRD into issues
  - build the backlog
  - decompose this plan into tickets
  - create GitHub issues from this architecture
version: 0.4.4
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - git
  - bash
  - tasks
  - ask_user
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/planning/backlog
  audit: pass
  model-size: any
  agents:
    - main
---

# Backlog

Turn a finished planning doc into small, engineer-ready tickets on a real
tracker. Decomposition is tracker-agnostic; creation branches on the target.
When vetting a ticket list or final report, read references/red-flags.md.

## Arguments

```text
/skill backlog <path to the finished PRD or planning doc>
```

- Required: the doc path. Named inline, or clearly the file just discussed
  in context, never a doc invented from memory. If no path can be found or
  inferred, say so at Step 1 and stop; do not decompose without a doc.
- Optional, inferred rather than asked for by default: target platform
  (Step 1's own rule picks it; see below) and a milestone/epic to attach
  tickets to.

In a headless run `ask_user` is not registered, so any call is refused as an
unregistered tool. Read references/headless.md before Step 1. An unanswered
`ask_user` at Step 3 is never a yes.

The steps below are the plan; hold it in your head, not in a tool. Do not
call `tasks` with `plan`/`add`/`done`/`block`/`drop` to track your own
progress through Steps 1–5 as if they were a workflow board. Do not re-invoke
`context(scope="skills")` once the skill is already loaded this turn; it
is refused as a redundant call and wastes a turn; if you need to recheck
what you already read, use `read`/`grep` on the files themselves.

Shell rules for every `bash` call: one command per call, plain and direct.
Never use `$(...)` or backticks; they trigger an approval gate a headless
run cannot answer, and the call is refused outright. Never redirect output
to `/tmp` (`> /tmp/...`) to stage or capture something for a later step;
that write needs an approval a headless run cannot give either, and the
call is refused the same way; just run the command and read its output
directly, nothing needs staging on disk first. The `git` tool only covers
`status`/`diff`/`log`; it has no `remote` op, so Step 1's remote and
`gh`-availability check still goes through `bash` (e.g. `git remote -v`,
`command -v gh`). Use `git` for a plain status check, `bash` for
everything else this skill needs from git or `gh`.

## Step 1 — Inputs

Required: the path to the PRD or planning doc (see Arguments). Target
platform: GitHub issues via `gh` when a git remote exists and the `gh`
binary is present. Check both in one `bash` call (`git remote -v;
command -v gh`) and trust the result; empty output from `git remote -v` is
a definitive "no remote", not an inconclusive check that needs a second or
third method (`git config`, reading `.git/config` directly; the latter is
a hard-blocked path regardless of this skill). Fall back to local tracking
automatically (see Step 4) when there is no remote, `gh` is unavailable, or
the user asked for local tracking, and say which was detected and why. A
platform the user names with no integration available is genuinely
ambiguous → ask, never guess, and never silently substitute a different
platform than the one requested (references/headless.md has the headless case).
Optional: a milestone or epic to attach tickets to.

## Step 2 — Decompose

Read the doc in full. Each implementation phase becomes a ticket group;
each user story becomes one or more tickets. Per ticket, draft:

- **Title**: imperative and specific ("Add token refresh endpoint", never
  "Auth").
- **Description**: what and why, linked back to the source doc's phase.
- **Acceptance criteria**: a checklist a reviewer can verify: observable
  behavior, not "works correctly".
- **Phase label**: `phase-N` from the source doc.

Sizing rules: a ticket is at most about a day of work; a ticket that needs
more than one screen to describe is two tickets. A phase too vague to
decompose is a gap in the source doc; stop and flag it rather than
inventing tickets. Flag it by name (which phase, what is missing) in the
Step 3 list and again in the Step 5 report; do not paper over it with a
plausible-sounding ticket the source doc never actually specified.

## Step 3 — Confirm before creating

Print the full proposed list, grouped by phase (title *and* acceptance
criteria per ticket, not titles alone, plus any flagged gaps from Step 2)
and the target platform, and get explicit confirmation via `ask_user`.
Ticket creation is outward-facing and not one-click reversible; nothing is
created before the yes. When that confirmation cannot be obtained, stop here and
do not proceed to Step 4.

## Step 4 — Create

Runs only after Step 3's explicit yes.

GitHub: when that is the target, read references/gh-commands.md for the calls.
Acceptance criteria go in the body as a markdown checklist. Capture every
created issue number and URL. A failed create is reported per ticket, not
papered over.

Local fallback: when the workspace has no GitHub remote, gh is unavailable,
or the user asks for local tracking, create each confirmed ticket with the
`tasks` tool instead (one task per ticket, acceptance criteria in the
description) and capture the task ids. Say which target was used and why.

Every report in this skill, confirmed-and-created or stopped-before-
confirmation, is delivered as a chat message, never a file. Do not call
`write` to save the proposal or the report to disk as a backlog/proposal
markdown file; `write` is not in this skill's tool surface and the call is
refused. If the user wants the backlog persisted as a document, that is a
different, file-producing skill (`prd`, `architecture`), not this one.

## Step 5 — Report

Confirmed-and-created run: a table of title → phase → issue number/URL,
plus the source doc path and any failures. Done when every proposed ticket
is either created with its URL captured or listed as failed with the
error.

Stopped-before-confirmation run: read references/headless.md for what the final
message has to carry.
