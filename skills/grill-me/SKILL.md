---
name: grill-me
description: Use when the user wants a plan, design, or idea stress-tested through a relentless one-question-at-a-time interview before any code is written, or when intent is too ambiguous to plan from. Walks every branch of the decision tree, resolves dependencies between decisions, and ends with a written decision log. Triggers on "grill me", "interview me", "stress-test this plan", "poke holes in this".
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
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/grill-me
audit: pass
---

# Grill Me

Interview the user relentlessly about their plan until you reach shared
understanding. The goal is not to make them feel interrogated; it is to make
every implicit decision explicit *before* anyone writes code. A plan with
unexamined branches is a plan with hidden rework.

Adapted from the community `grill-me` skill (mattpocock/skills), upgraded for
Clio's structured interaction tools.

## The core loop

1. **Map the decision tree.** Read the plan (conversation, file, or ask for
   it). Privately list every decision it implies: scope boundaries, data
   shapes, failure modes, sequencing, naming, integration points, rollout.
2. **Ask one question per turn.** Never batch unrelated questions. Each
   question targets the unresolved decision that the most *other* decisions
   depend on — resolve roots before leaves.
3. **Always provide your recommended answer.** Use the `ask_user` tool when it
   is available, with your recommendation as the first option and 2–3 real
   alternatives after it. When `ask_user` is unavailable, ask in plain text
   and state your recommendation inline.
4. **Explore instead of asking.** If a question can be answered by reading the
   codebase, configs, or git history — read them. Never ask the user something
   `grep` can answer. Spend the user's attention only on judgment calls.
5. **Chase the branch to resolution.** A vague answer spawns a follow-up, not
   a note to self. Do not move to a new branch while the current one dangles.
6. **Stop when the tree is resolved.** Every branch has either a decision or
   an explicit "deferred, and here is why it is safe to defer".

## Termination: the decision log

This skill's tool surface is deliberately read-only plus `ask_user`: the
deliverable is the conversation and the log below, not a file. End the
interview by restating the shared understanding as a decision log:

```markdown
## Decision Log — <topic>
1. <decision> — chosen over <alternative> because <reason>
2. ...
Deferred: <item> — safe because <reason>
Open risks: <anything neither of you could resolve>
```

Offer the natural next step: hand the log to planning (`prd` for a full spec,
or `cut-it` to slice an existing plan into an executable sprint).

## Red flags (you are doing it wrong)

- Asking three questions in one message.
- Asking anything answerable from the repo.
- Accepting "whatever you think" without recording *your* recommendation as
  the decision and saying so.
- Ending without the decision log.
