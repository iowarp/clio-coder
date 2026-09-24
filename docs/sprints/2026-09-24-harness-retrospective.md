# Harness retrospective sprint — 2026-09-24

Durable fix index for the report at `/home/akougkas/projects/obsidian-processor/REPORT.md`.
The report is a source of leads; session `1vs919hzsf9j`, receipts, source, and focused
tests were checked before changes. Clio work was developed on branch
`codex/harness-sprint-20260924` from `1cebdaf7`, then merged into canonical
`v055` after integration checks. The two implementation panes (`wT:p28` Sol xhigh
and `wT:p29` Sol medium) and the temporary sprint worktree were retired; other
agents' panes and worktrees were left alone.
The first two Clio instances selected a homelab route and were stopped before
edits; all implementation and tests used Codex Sol panes. No pane spawned an agent.

| Lead | Delivered fix | Commit |
| --- | --- | --- |
| P0 completion vs validation | Done notes remain claims; failed/missing checks show unverified in task list and overlay, including repeat history. Ungrounded sealed writer receipts name the next host check. Task schema stays inside the attached prompt budget. | `c6d0ae36`, `aee603d4`, `51c4b063` |
| P1 delegated edit loop | A sealed workspace mutation advances the loop epoch; unchanged triple retries still block. | `edf225fb` |
| P1 pending collect loop | Batch progress advances the collect fingerprint; unchanged polling remains bounded. | `f62ebbef` |
| P1 profile vs node | A profile name used as a node gets a concrete profile/node remedy. | `3c60a31b` |
| P1 provenance access | An owning worker can read bounded session task and tool counts; foreign sessions are denied without raw task text. | `b7967b4d`, `b97bcbbe` |
| P1 memory paths | Reminder delivery checks workspace file references and suppresses resolved failure history. The cited reminder text was unavailable in the ledger; this is a defensive fix. | `c65b7d4f` |
| P2 runner timeout | A timed-out verbose pytest run reports its last announced case and says validation did not finish. | `65039547` |
| P2 scout overrun | Native read-only scout/provenance workers enter final synthesis after 36 observed calls; external CLI remains one-shot. Operator selected 36. | `93764ff8` |
| P2 skill drift | Load warnings show recorded and installed hashes plus review/update preview commands; receipts distinguish recipe-bound loads from workflow execution or commits. | `90756d6d` |
| P2 handoff wording | Packaged handoff instructions distinguish interactive and headless `ask_user`; skill and library pins/version refreshed. | `78f2f3c8`, `b9d8a6e7` |
| P2 batch visibility | Dispatch returns sealed aggregate tool calls and provenance-aware cost, identifying external opaque runs. | `db0308bb` |
| P3 evidence navigation | Evidence tool pages visible session bundles; GUI explains six trust axes and exact/best-effort/unclassified event attribution. | `6d2a9b70`, `5095ae53` |
| Autonomy yolo | Full-auto admits scanned npm validation scripts and typed verify checks; capable/suggest still ask and hard safety rails remain. Operator explicitly chose admission. | `aa3b4dc6` |
| Autonomy capable | Admits exact `git diff --check` and `git diff --cached --check` after safety scan. | `bf3b41a7` |
| Prompt manifest docs | Documented source version 3. | `3c60a31b` |
| Final integration | Resolved verifier argv and execution cwd are scanned by safety; updated stale fixture ownership, scout budget, vision runtime, schema cap, and capable/yolo terminal expectations. | `d2973673`, `43057e89`, `c4070d01` |

The five-worker public API rework was an agent integration error, not a reproducible
admission defect. Clio now exposes host validation next actions, unverified task
closure, and batch cost/calls; a shared contract fixture and integration owner remain
choices for the parent when splitting coupled work. The report's inference hang was
not traced to one provider. After explicit operator approval, isolated test changes
in `obsidian-processor` branch `codex/offline-tests-20260924` (commit `32e5633`)
made default pytest offline and gated live inference behind an opt-in and local
endpoints. Its temporary worktree was removed; the branch remains because that
repository's main checkout has other agents' uncommitted work.

Verification: Clio's full contract/smoke run passed **2029/2030** (one platform
skip, no failures). Full tests TypeScript, build, repository lint/hygiene, GUI
TypeScript and lint, skill/library pin checks, and both GUI evidence HTTP tests
passed. Obsidian's isolated default pytest run passed 11 tests in 12 seconds with
43 integration tests deselected; targeted opt-in skipped without authorization and
rejected nonlocal endpoints before a request. Deterministic autonomy contract tests
cover the changed admission branches.

Final integration on `v055`: 89 focused safety/dispatch/image tests passed; a
disk-backed full run passed 4,247 tests with one platform skip and found one old
`auto-edit`/`full-auto` menu-label assertion. After correcting it to the displayed
`capable`/`yolo` labels, the entire real-terminal file passed 9/9. The later vision
merge passed 28/28 affected tests and the GUI suite passed 194/194. TypeScript,
lint/hygiene, GUI checks and build passed. The numeric verifier's 26/26 tests passed
from the orchestrator shell; its eight failures inside a pane were caused by that
pane's `EPERM` process sandbox, which also refused `spawnSync(node -v)`.
