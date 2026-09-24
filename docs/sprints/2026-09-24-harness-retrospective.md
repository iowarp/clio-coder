# Harness retrospective implementation sprint — 2026-09-24

This log is the durable coordination record for the Clio Coder fixes prompted by the
`obsidian-processor` harness retrospective. Read it before continuing work after
context compaction. The retrospective is evidence to recheck, not a specification.

## Isolation and roles

- Repository: `/home/akougkas/iowarp/clio-coder`.
- Branch: `codex/harness-sprint-20260924`.
- Worktree: `/home/akougkas/iowarp/clio-coder/.clio-coder/worktrees/harness-sprint-20260924`.
- Baseline commit: `1cebdaf76edf872bcc67003a2cfeb20e311fc77a`.
- Herdr tab: `wT:t2`. Orchestrator: `wT:p1W`; implementer: `wT:p25`; tester/reviewer: `wT:p26`.
- Only this worktree is writable for this sprint. Leave `v055`, the other
  worktrees, global Clio settings, and `obsidian-processor` untouched.
- File ownership: implementer owns assigned `src/` files; tester owns assigned
  `tests/` files; orchestrator owns this log and integration. Coordinate before
  changing a file outside the assignment. Do not dispatch nested workers or
  use homelab AI nodes for this sprint.

## Fix queue

| ID | Priority | Scope and acceptance | Status | Owner |
| --- | --- | --- | --- | --- |
| H1 | P0 | Task `done` notes remain claims, not `passed` validation. A note saying `14/16 failed; rerun pending` cannot project as passed; existing ledgers still refold; verified checks remain distinguishable. | in progress | implementer + tester |
| H2 | P1 | After a sealed delegated workspace mutation, one identical validation command is admitted; three unchanged attempts still block. | queued | implementer + tester |
| H3 | P1 | `monitor collect` can poll again after observed batch progress (for example pending 2 to 1); unchanged rapid polling remains bounded. | queued | implementer + tester |
| H4 | P2 | Unknown `node` that matches a configured profile returns an actionable profile/node remedy, while invalid placement stays denied. | done; 9/9 fleet lifecycle tests pass | orchestrator |
| H5 | P2 | A provenance worker can retrieve a bounded, redacted summary for its own session ID; foreign sessions are denied distinctly from absent sessions. | queued | implementer + tester |
| H6 | P3 | Align prompt manifest version documentation with source version 3. | done; diff checked | orchestrator |

## Deferred leads

- Memory path freshness: the alleged injected reminder text is not preserved
  as an independently checkable event. Reproduce before changing restoration.
- Evidence inventory pagination: fixed 12-item window is confirmed, but lower
  priority than the fixes above.
- Project process/batch pytest hangs: root cause is unproved and lies in the
  `obsidian-processor` test path; do not change that repository in this sprint.
- Worker budget overrun and five-way integration churn: advisory budget and
  agent workflow observations, not a confirmed product defect.

## Evidence and verification

- Review source: `/home/akougkas/projects/obsidian-processor/REPORT.md`.
- Primary Clio session: `1vs919hzsf9j` (2026-09-24); relevant run IDs include
  `18f2l9w7izxe`, `28fn89qwztm5`, and `39xu3ph0w196`.
- Baseline: 32 focused Clio tests passed in
  `task-board-done`, `loop-guard-epoch`, `advisory-dispatch-budgets`, and
  `gateway-corrections`. Direct source reproductions confirmed H1–H3.
- Run the narrow regression tests for each fix, then Clio typecheck and the
  relevant contract suite. Record command, result, and commit here.

## Chronology

- 2026-09-24: Created an isolated worktree and this sprint queue. The shared
  `v055` branch advanced from `4a98d59b` to `1cebdaf7` while isolation was
  being set up; the sprint branch starts at the latter commit. No work was
  applied to the shared checkout.
- 2026-09-24: Started two Clio Coder agents in Herdr panes `wT:p25` and
  `wT:p26`, but their current chat route selected the homelab `blade` target.
  Interrupted both before edits and exited those instances. Reused the same
  two panes for Codex agents pinned to `gpt-6-sol`, named
  `harness_impl_cloud_0924` and `harness_review_cloud_0924`. H1 source ownership is
  `src/domains/session/task-board.ts` and `src/tools/tasks.ts` for the
  implementer; H1 test ownership is `tests/extended/task-board-done.test.ts`
  for the tester. Both operate only in the sprint worktree.
- 2026-09-24: Updated `docs/architecture/artifact-versions.md` from prompt
  manifest version 2 to version 3 and checked the diff with `git diff --check`.
- 2026-09-24: Implemented H4 in placement admission and preview. A node pin
  matching a configured profile now names the distinction and valid route;
  unknown names still deny. `pnpm run test:file -- tests/extended/fleet-lifecycle.test.ts`
  passed 9/9.
