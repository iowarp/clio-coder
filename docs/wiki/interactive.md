---
title: "Command-line surfaces: the interactive terminal app"
summary: "How the interactive terminal UI is composed and driven: the application entry point, the chat transcript and its streaming renderer, the dispatch board, slash commands including /export, overlay frames, and HTML export. Read this when changing anything the operator sees in the interactive TUI."
sources:
  - "src/interactive/index.ts"
  - "src/interactive/interactive-application.ts"
  - "src/interactive/chat-panel.ts"
  - "src/interactive/chat-renderer.ts"
  - "src/interactive/interactive-slash-runtime.ts"
  - "src/interactive/dispatch-board.ts"
  - "src/interactive/overlay-frame.ts"
  - "src/interactive/export-html/index.ts"
symbols:
  - "startInteractive"
  - "createInteractiveApplication"
  - "dispatchInteractiveAction"
  - "createChatPanel"
  - "createCoalescingChatRenderer"
  - "createInteractiveSlashRuntime"
  - "renderSessionHtml"
  - "FocusBox"
tests:
  - "tests/contracts/continuity-replay-fork.test.ts"
invariants:
  - "renderSessionHtml throws when maxBytes is not a safe integer or is below twice the 8 KiB template reserve, and throws when the final document exceeds maxBytes."
  - "renderSessionHtml admits whole rendered rows only, stopping at the first row that would exceed the line budget, and marks the output truncated in that case."
  - "A replayed continuity handoff note is rendered as assistant-authored text and HTML-escaped in the /export output, so script markup in the note does not appear as live HTML."
  - "The /export markdown path sizes its code fence to one more than the longest backtick run in the transcript, so embedded fences cannot close the block early."
validate:
  - "pnpm run test:file -- tests/contracts/continuity-replay-fork.test.ts"
  - "pnpm run typecheck"
---

# Command-line surfaces: the interactive terminal app

The `src/interactive` directory is the terminal UI that runs when the operator starts Clio Coder interactively. A reader needs this page when changing what appears in the transcript, the dispatch board, the slash commands, overlays, or the `/export` output. Entry is through `startInteractive`, which the orchestrator loads lazily.

## What this area does

- `startInteractive` is the process-boundary entry. It forwards its dependency bag to `createInteractiveApplication`, which owns the terminal lifecycle. The orchestrator imports it with a dynamic import and passes jobs, connections, and other host collaborators, in `src/entry/orchestrator.ts:5759:startInteractive`.
- `createInteractiveApplication` builds the terminal shell, the chat panel, the workspace facts, the session transcript, and the exit summary collector. It also registers a synchronous SIGTERM listener that writes the input-wedge dump when a render trace is active.
- `dispatchInteractiveAction` maps a `ClioKeybinding` id to a deps callback and returns `true` only when the action ran. Actions that need an optional dep (`suspend`, `autonomy.toggle`, `music.toggle`) return `false` when that dep is absent. `clio-coder.leader` returns `false` unconditionally, and `clio-coder.exit` returns `false` when `canExit` reports the editor is not empty.
- `createChatPanel` builds the transcript model and renders it. Its options include `unboundedToolBodies`, which `/export` sets so the written transcript is not elided.
- `createCoalescingChatRenderer` sits between chat-loop events and the panel. It coalesces delta events into frame requests and gates streamed text when a long reply makes Markdown re-lexing expensive.
- `createInteractiveSlashRuntime` implements the slash commands, including `/export`.
- `createDispatchBoardView` and the row helpers in `src/interactive/dispatch-board.ts` derive row presentation (status, usage text, phase cells) from dispatch rows. `isDispatchBoardRowSteerable` and `isDispatchBoardRowCancellable` are the predicates the board uses to decide which rows accept operator guidance or abort.
- `FocusBox` in `src/interactive/overlay-frame.ts` is a bordered container that forwards keyboard input to its input target and hands the row budget to budgeted children through `setBodyRows`.
- `renderSessionHtml` in `src/interactive/export-html/index.ts` builds the bounded, self-contained HTML document used by `/export`.

## Ownership map

| Concern | Source | Key symbols |
| --- | --- | --- |
| Entry and terminal lifecycle | `src/interactive/index.ts`, `src/interactive/interactive-application.ts` | `startInteractive`, `createInteractiveApplication`, `InteractiveDeps`, `KeyBindingDeps`, `dispatchInteractiveAction` |
| Transcript model and rendering | `src/interactive/chat-panel.ts` | `ChatPanel`, `ChatPanelOptions`, `createChatPanel`, `warmTranscriptRender` |
| Streaming coalescer and replay rehydration | `src/interactive/chat-renderer.ts` | `createCoalescingChatRenderer`, `CoalescingChatRenderer`, `rehydrateChatPanelFromTurns` |
| Slash commands and `/export` | `src/interactive/interactive-slash-runtime.ts` | `createInteractiveSlashRuntime`, `longestBacktickRun`, `EXPORT_RENDER_WIDTH` |
| Dispatch board presentation | `src/interactive/dispatch-board.ts` | `DispatchBoardRow`, `dispatchUsageText`, `isDispatchBoardRowSteerable`, `isDispatchBoardRowCancellable`, `createDispatchBoardView` |
| Overlay frame | `src/interactive/overlay-frame.ts` | `FocusBox`, `createChoiceList`, `ScrollingBody`, `createCachedBody`, `RowBudgetedBody` |
| HTML export | `src/interactive/export-html/index.ts` | `renderSessionHtml`, `HtmlSessionExportInput`, `MAX_HTML_EXPORT_BYTES` |

Several source files in this directory have their own wiki pages. For overlays see [Interactive overlays](interactive/overlays.md); for rendering details see [Interactive renderers](interactive/renderers.md); for the status line see [Interactive status](interactive/status.md); for the footer see [Interactive footer](interactive/footer.md); for theming see [Interactive theme](interactive/theme.md). The entry that starts this app is described in [Entry](entry.md), and the non-interactive CLI is in [Cli](cli.md).

## Control flow

### Application startup

`startInteractive` calls `createInteractiveApplication(deps)` and returns its numeric result. Inside `createInteractiveApplication`, the first step is `presentContextCommands(host)`, which produces the deps object used for the rest of startup. The terminal shell comes from `deps.terminalLease?.shell` when a lease is provided; otherwise `createProcessInteractiveShell` is called with the `interface.mode` setting and a stream-pacing flag derived from `interface.smoothStreaming`. `interface.demo === false` forces smooth streaming off.

Two pieces of state are tracked across chat events: `agentRunEnded`, set on `agent_end` and cleared on `agent_start`, and a per-text-delta ingress record stored in a `WeakMap`. Each `text_delta` or `thinking_delta` is recorded with a sequence number, and when a render trace is active it is forwarded to `renderTrace.recordVisibleEvent`.

### Keyboard action dispatch

A keybinding id reaches `dispatchInteractiveAction(id, deps)`. The function first records an optional feature name from `ACTION_FEATURES` through `deps.recordFeature`, then switches on the id. For example, `clio-coder.exit` calls `deps.canExit` first and returns `false` when it reports the editor is non-empty; otherwise it calls `deps.requestShutdown`. Callers can rely on the boolean to decide whether the key was consumed.

### Chat events to the screen

Chat-loop events go through `createCoalescingChatRenderer`. The renderer distinguishes delta events (`text_delta`, `text_frame`, `thinking_delta`, `tool_execution_update`) from all others. Delta events are coalesced: the first delta after a quiet period requests a frame immediately, and deltas inside the coalesce window wait for a timer (default `DEFAULT_COALESCE_MS` of 16). Non-delta events call `cancelPending` and `requestNow` synchronously.

`admitText` is the single path for streamed answer text into the panel. When `liveTextRender()` reports at least `COST_GATE_MIN_CODE_UNITS` (20 KiB) of text, `gateWaitMs` computes a minimum interval so the re-lex cost stays within `COST_GATE_MAIN_THREAD_SHARE` (0.3) of the main thread, capped at `COST_GATE_MAX_INTERVAL_MS` (2000 ms). Text inside that interval is held in `gatedText` and released by a timer or at an ordered boundary through `releaseGatedText`. A short reply never enters this gate.

The `isTransparentAssistantWrapper` helper in `src/interactive/chat-renderer.ts` treats a `message_update` whose inner event is a text or thinking delta as transparent, so it does not cancel the coalesce window. Wrappers carrying tool-call formation stay on the synchronous path.

### Replay rehydration

`rehydrateChatPanelFromTurns(panel, turns, options)` replays stored turns into a panel. `createChatPanel` and `rehydrateChatPanelFromTurns` are the two points the continuity test uses: it builds options with `withContinuityReplay`, passes `{ unboundedToolBodies: true, activeLeafTurnId: "m2" }`, renders the panel to lines, and then passes those lines to `renderSessionHtml`. Replayed continuity notes are labelled and escaped as described in the test section below.

### `/export`

The `/export` handler in `createInteractiveSlashRuntime` (`src/interactive/interactive-slash-runtime.ts`) does the following in order:

1. It reads the session's structured entries through `deps.readStructuredEntries(sessionId)`, then builds a throwaway chat panel with `unboundedToolBodies: true`, `bareCodeFences: true`, and `getOutputStyle: () => "detailed"`. It calls `rehydrateChatPanelFromTurns` with the turns and `withContinuityReplay`. The leaf is scoped to the session's current tree leaf (`deps.session?.tree(sessionId).leafId`) when one exists.
2. It renders the panel at `EXPORT_RENDER_WIDTH` (100) to get `ansiLines`.
3. The export timestamp comes from `deps.now` or the current time, and the calendar date is derived from it. The trimmed path argument is resolved against the working directory when given. Otherwise the target is `join(".clio-coder", "exports", `${sessionId}-${date}.html`)`, resolved against the working directory, and the parent directory is created with `mkdirSync`.
4. If the trimmed path argument ends in `.md` (case-insensitive), the lines are stripped of terminal sequences and written as a fenced `text` block under a `# Clio session <id>` header and an `Exported` line. The fence length is `max(3, longestBacktickRun(lines) + 1)`, so a body containing its own backtick fence cannot close the block early. Any other target receives `renderSessionHtml({ sessionId, exportedAt, ansiLines })`.
5. A success notice reports the line count and a workspace-relative path when the target lies inside the working directory, or the absolute target otherwise. Any thrown error is caught and surfaced as an error notice rather than propagated.

### HTML export sizing

`renderSessionHtml` enforces its budget as follows, read from `src/interactive/export-html/index.ts`:

- `maxBytes` defaults to `MAX_HTML_EXPORT_BYTES` (2 MiB). It throws when `maxBytes` is not a safe integer or is below `TEMPLATE_RESERVE_BYTES * 2` (16 KiB).
- The line budget is `maxBytes - TEMPLATE_RESERVE_BYTES`. Each input line is rendered on its own through `renderTranscriptHtml([line])`, its UTF-8 byte length plus one is added to a running total, and the loop stops at the first line that would exceed the budget, setting `truncated`.
- The selected lines are rendered once more as a whole transcript and passed to `htmlTemplate` with `sessionId`, `exportedAt`, and `truncated`.
- If the final document is still larger than `maxBytes`, the function throws rather than returning a partial document.

Because the per-line byte count is taken from a single-line render, whole rows are admitted and rows are never split. The selected-line render can differ slightly from the sum of single-line renders; the final size check is the guard for that.

## Relationships

**Callers.** `startInteractive` is imported by `src/entry/orchestrator.ts`. `renderSessionHtml` is called by `src/interactive/interactive-slash-runtime.ts` at the `/export` writer. `createCoalescingChatRenderer` and `createChatPanel` are consumed by the interactive application and slash runtime.

**Dependencies.** `createInteractiveApplication` imports from the core, domains (config, dispatch, extensions, memory, mux, providers, session, telemetry, and others), the engine TUI, and sibling interactive modules such as `src/interactive/application-controller.ts`, `src/interactive/chat-panel.ts`, and `src/interactive/dispatch-steering.ts`. `renderSessionHtml` depends on `src/interactive/export-html/template.ts`, `src/interactive/export-html/tool-renderer.ts`, and `src/interactive/export-html/ansi-to-html.ts`.

**Dependents of this page's files.** Tests that import `renderSessionHtml` include `tests/contracts/continuity-replay-fork.test.ts`, `tests/contracts/dogfood-cancellation.test.ts`, and `tests/contracts/replay-turn-outcome.test.ts`. Tests that import `src/interactive/interactive-application.ts` include `tests/extended/keyboard-routing.test.ts` and `tests/extended/library-keybindings.test.ts`.

## Focused test

`tests/contracts/continuity-replay-fork.test.ts` contains the case `labels the note in the transcript and escapes it in the HTML export`. Its input is a continuity handoff whose note is `note with <script>alert("x")</script>, a ``` fence and a & ampersand`, appended through the contract as a prepared, reducing, carrying, and committed sequence. The test builds options with `withContinuityReplay` and `activeLeafTurnId: "m2"`, rehydrates a panel, and renders it at width 100. It asserts that the plain text contains `Context handoff note` and `written by the assistant`, that `alert(` appears, and that the note is not rendered as an operator quote. It then passes the rendered lines to `renderSessionHtml` and asserts that the HTML does not contain `<script>alert`, does contain `&lt;script&gt;`, and does contain `&amp;`.

No focused test was found in this search for the `maxBytes` throw, the `truncated` branch, or the `.md` fence-sizing path of `/export`. The search covered `tests/` for `renderSessionHtml`, `MAX_HTML_EXPORT_BYTES`, `maxBytes`, `longestBacktickRun`, and `createCoalescingChatRenderer`. The behavior described for those paths comes from reading the source only.

## Things to watch when editing

- `renderSessionHtml` measures each line with a standalone render, then renders the selected set again. The final `maxBytes` check is what guarantees the size limit, so a change to the template or to per-line rendering must keep that check in place.
- The coalescer and the cost gate share `lastTextAppliedAt`. Text the gate holds is not yet in the panel, so a frame requested by a keystroke reuses the previous layout. Changes to `admitText` or `releaseGatedText` affect ordering against non-text events, which call `transaction` or `flush` boundaries.
- `dispatchInteractiveAction` relies on optional deps (`suspendProcess`, `toggleAutonomy`, `toggleMusic`) returning `false` when absent. A new action with an optional dep should follow the same pattern so the key is not consumed silently.
- `/export` passes `unboundedToolBodies: true` to its throwaway panel. That option is what makes the export complete; removing it changes the exported content to the bounded live view.
- `FocusBox.setBodyRows` forwards the row budget only to children that satisfy `RowBudgetedBody` (detected by a `setBodyRows` function). A body inside a focus box that does not implement that interface is not windowed by the frame.
