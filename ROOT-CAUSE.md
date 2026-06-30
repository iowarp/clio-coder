# Root-cause: runaway tool-call loops on the Qwopus3.6-35B local model

Session under analysis: `b54488e2f85beb59/2gwo4kgcep3v` (retry of `0vr6s0qm4s08`),
model `Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K` on target `mini` (llamacpp,
OpenAI-compat, qwen tool calls, thinking-off), 2026-06-30. The engine never
crashed. The harness let a weak local model spin in identical-tool-call loops
that the loop guard stopped only late and silently, returning empty turns.

## Failure inventory

The main session (`0vr6s0qm4s08`) succeeded. The retry collapsed into three
runaway loops, each stopped by the loop guard and each ending in an empty
aborted assistant turn (`text:""`, `content:[]`, `stopReason:"aborted"`).

| # | Loop | Lines | Identical call repeated | Terminal state |
|---|------|-------|-------------------------|----------------|
| 1 | `docs_search` | 43-105 | `{"query":"CLIO.md generated versioned handbook policy","limit":5}` x7 | line 105 empty aborted |
| 2 | `grep` | 118-150 | `{"pattern":"CLIO\\.md.*adopt\|CLIO\\.md.*propose","path":"docs","limit":20}` x7 | line 150 empty aborted |
| 3 | `code_nav` | 153-212 | `{"mode":"path","query":"clio-md","limit":10}` x7 | line 212 empty aborted, session quit |

Evidence for loop 1: tool_result line 104 = `"loop detected: docs_search was
called 7 times with identical arguments within 30s ... Loop budget exhausted
(3 blocks this turn); the agent is being stopped."`. Audit `2026-06-30.jsonl`
records all three stops as `kind:"abort", source:"stream_cancel", reason:"user
cancelled stream"` at 16:34:17 / 16:35:38 / 16:39:12. The user had to ask
"what happened?" (line 106); the final question (line 151) was never answered.

## Classification and source mapping

- **F1 (a) harness, empty terminal turn.** The loop-guard interrupt routed
  through `deps.chat.cancel()` -> `runtime.agent.abort()`
  (`src/interactive/index.ts` LoopBlocked/ToolBudgetExceeded subscribers;
  `src/interactive/chat-loop.ts` `cancel()`). The only explanation was an
  ephemeral TUI notice; the persisted turn was empty. Fixed by P1.
- **F1 (a) harness, late trip.** `DEFAULT_MAX_REPEATS=5`
  (`src/domains/safety/loop-detector.ts`) plus `INTERACTIVE_LOOP_BLOCK_BUDGET=3`
  (`src/engine/loop-guard.ts`) let a degenerate model burn 7 identical calls
  (4 free + 3 blocked) per loop before the stop landed. Fixed by P2.
- **F2 (b) model behavior.** Each in-loop assistant turn is `text:""` with one
  bare tool call (thinking-off), re-issuing the same canonical call and never
  self-terminating. Tolerated by harnessing (P1/P2), not special-cased.
- **F3 (a) harness, finish-contract false positive.** The informational answer
  to "how does docs_search work?" (line 39) tripped the completion-claim regex;
  the advisory injected at line 40/41 nudged the docs_search spiral. Source
  `src/domains/safety/finish-contract.ts`. Fixed by P4.
- **F4 (a) accounting.** Loop-guard interrupts were audited as `stream_cancel`
  / "user cancelled stream", indistinguishable from a real operator cancel.
  Fixed by P3.

- **F5 (a) harness, headless/ACP non-termination (found during live re-test).**
  Driving a live `clio run` against the model reproduced the loop and reached
  200+ blocked `docs_search` attempts in one turn (hard ceiling 40 ignored)
  before a wall-clock timeout. Only the interactive TUI subscribed to the
  loop-guard interrupt bus events and aborted; `src/entry/orchestrator.ts`
  registered the per-turn budgets but wired no interrupt-to-abort on the headless
  or ACP branches and passed no lifetime `toolCallCap`. Pre-existing (the commit
  for F1-F4 did not touch `orchestrator.ts`). Fixed by P5: a shared
  `subscribeLoopGuardStop` helper wires the same interrupt-to-stop path on the
  operatorless surfaces.

Ruled out with evidence: no malformed qwen tool calls (all 268 audited calls
executed); no context/compaction overflow; no fleet involvement (`dispatch
list:true` only; `runs.json` shows no new runs); thinking leakage is a
non-factor (one `reasoning_content` on the "hi" greeting in the main session,
zero in the failing session).

## Fixes

- **P1** `src/interactive/chat-loop.ts`, `chat-loop-messages.ts`,
  `src/interactive/index.ts`: `cancel(options?)` writes a durable, visible
  assistant turn carrying the stop reason and suppresses the empty aborted turn.
- **P2** `src/domains/safety/loop-detector.ts` (maxRepeats 5->3),
  `src/engine/loop-guard.ts` (block budget 3->2).
- **P3** `src/core/bus-events.ts`, `src/domains/safety/audit.ts`,
  `src/interactive/status/state-machine.ts`: new `loop_guard` abort source.
- **P4** `src/domains/safety/finish-contract.ts`:
  `isInformationalQuestionPrompt` gate (`informational_question_turn`).
- **P5** `src/interactive/loop-guard-interrupt.ts` (new shared helper),
  `src/entry/orchestrator.ts` (headless + ACP branches), `src/interactive/index.ts`
  (interactive reuses the shared message helpers): wire the interrupt-to-stop
  path on the operatorless surfaces.

Tests: `tests/contracts/chat-loop.test.ts`, `tests/contracts/loop-guard.test.ts`,
`tests/contracts/loop-guard-interrupt.test.ts`, `tests/contracts/safety.test.ts`.
Gate: `npm run ci` and `npm run check:boundaries` pass clean.
