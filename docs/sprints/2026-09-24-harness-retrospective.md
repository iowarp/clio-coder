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
- Both panes own code and focused tests for separate assigned fixes. Orchestrator
  owns this log and integration. Coordinate before changing another assignment's
  files. Do not dispatch nested workers or use homelab AI nodes for this sprint.

## Fix queue

| ID | Priority | Scope and acceptance | Status | Owner |
| --- | --- | --- | --- | --- |
| H1 | P0 | Task `done` notes remain claims, not `passed` validation. A note saying `14/16 failed; rerun pending` cannot project as passed; existing ledgers still refold; verified checks remain distinguishable. | done; 7/7 focused tests, source typecheck | panes + orchestrator |
| H2 | P1 | After a sealed delegated workspace mutation, one identical validation command is admitted; three unchanged attempts still block. | done; focused tests pass | xhigh pane |
| H3 | P1 | `monitor collect` can poll again after observed batch progress (for example pending 2 to 1); unchanged rapid polling remains bounded. | done; focused tests pass | xhigh pane |
| H4 | P2 | Unknown `node` that matches a configured profile returns an actionable profile/node remedy, while invalid placement stays denied. | done; 9/9 fleet lifecycle tests pass | orchestrator |
| H5 | P2 | A provenance worker can retrieve a bounded, redacted summary for its own session ID; foreign sessions are denied distinctly from absent sessions. | done; 10/10 evidence-tool tests | orchestrator |
| H6 | P3 | Align prompt manifest version documentation with source version 3. | done; diff checked | orchestrator |
| A1 | P1 | Admit repository validation scripts and typed verifiers at `yolo` after hard safety checks. Preserve `capable`/`suggest` asks, `read-only` denial, and explicit destructive/system/operator rails. Reproduce both bash and verify forms, including headless admission. | done; focused tests pass | medium pane |
| A2 | P2 | Admit only standalone `git diff --check` and `git diff --cached --check` at `capable`; keep shell operators, extra flags, substitutions, and project scripts on their existing rails. | done; focused tests pass | medium pane |

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
  passed 9/9. Committed H4, H6, and this log as `3c60a31b`.
- 2026-09-24: H1 implementer and tester finished assigned source and regression
  files. Focused task-board, finish-contract, and handoff tests passed 14/14;
  source-only TypeScript passed. Independent review is checking raw ledger
  consumers before integration. The orchestrator corrected the task overlay
  label and guide text in separate files. H2 source work started in the
  implementer pane; its file ownership is `src/engine/loop-guard.ts` and
  `src/tools/dispatch-runner.ts`.
- 2026-09-24: Operator added a direction to make `yolo` less interruptive and
  `capable` more useful for safe work. Source inspection found that
  `project-script-confirm` and `project-verifier-confirm` currently remain
  net confirmation rails even at full-auto. A1 is a separate, test-gated
  policy change; inspect the exact command path before editing it.
- 2026-09-24: Operator supplied a Claude-pane A/B result: 39/100 runs were
  denied `verify(typecheck|lint|build)` or `npm run lint|build|typecheck|ci`
  under `--autonomy yolo`, and chose “Admit at full-auto.” Reproduced policy
  decisions: `npm run typecheck`, lint, and build produce net `ask` at yolo,
  while `pnpm run lint` produces `allow`. The full-auto admission fix is
  separate from the broader `capable` preference.
- 2026-09-24: Switched the two existing Herdr panes to Codex `gpt-6-sol`
  xhigh (`wT:p25`) and medium (`wT:p26`) at operator request. Both now own
  code and focused tests on separate files: H2 and A1 respectively.
- 2026-09-24: Closed H1 review findings: legacy synthetic rows are recognized
  by their original passed-note shape; observed failed rows survive refolding;
  task list and evidence transcript label claims and checks separately.
  `task-board-done.test.ts` passed 7/7, Biome passed, and source typecheck passed.
- 2026-09-24: Added own-session evidence summary from the bounded inventory
  projection. Foreign session requests are rejected before bundle materialization;
  missing sources return `artifact_absent`. `evidence-tool.test.ts` passed 10/10.
- 2026-09-24: A1, H2, and H5 integration check passed 62/62 focused tests,
  source TypeScript, and Biome on changed files.
- 2026-09-24: H3 and A2 integrated; 51/51 focused tests passed together.
  H3 advances on a falling pending count or completion; unchanged count alone
  does not prove progress. Both panes passed source typecheck and Biome.
