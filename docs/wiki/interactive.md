---
title: "Interactive"
summary: "The terminal user interface that hosts the chat loop, the streaming transcript, the status footer, the theme, and the export/view surfaces, and how events flow through its composition root."
sources:
  - "src/interactive/index.ts"
  - "src/interactive/interactive-application.ts"
  - "src/session-control/chat-loop.ts"
  - "src/interactive/chat-panel.ts"
  - "src/session-control/turn-context.ts"
  - "src/interactive/status/index.ts"
  - "src/interactive/status/controller.ts"
  - "src/interactive/status/state-machine.ts"
  - "src/interactive/theme/index.ts"
  - "src/interactive/theme/tokens.ts"
  - "src/interactive/export-html/index.ts"
  - "src/interactive/interactive-event-projection.ts"
symbols:
  - "startInteractive"
  - "createInteractiveApplication"
  - "createChatLoop"
  - "createChatPanel"
  - "createTurnContext"
  - "createStatusController"
  - "reduceStatus"
  - "createClioTheme"
  - "renderSessionHtml"
  - "createInteractiveEventProjection"
tests:
  - "tests/contracts/footer-active-statuses.test.ts"
  - "tests/contracts/context-live-budget.test.ts"
invariants:
  - "An ended turn settles back to idle five seconds later, so a session started inside that window never reports work it never did."
  - "The transcript never cuts an ANSI sequence or a tool section: HTML export admits whole rendered rows until its byte budget is full."
validate:
  - "pnpm test:file tests/contracts/footer-active-statuses.test.ts"
  - "pnpm test:file tests/contracts/context-live-budget.test.ts"
---

# Interactive

The `src/interactive` area is the process-boundary terminal user interface (TUI). It owns the
terminal lifecycle, the streaming transcript the operator reads, the status footer, the
shared color theme, and the HTML-export and `/view` surfaces. Its collaborators are
independently testable modules; the application root composes them and wires the event flow
between the chat loop and the rendered surfaces.

This page documents the composition root, the chat-loop/turn-context/turn-runtime core, the
chat-panel transcript, the status controller and its state machine, the theme tokens, and the
export-html and view submodules. It distinguishes the terminal lifecycle owned here from the
provider and engine concerns delegated to the domains.

## Ownership and entry points

The public entry point is `startInteractive` in `src/interactive/index.ts`. It is a thin
process-boundary wrapper that calls `createInteractiveApplication` and returns the process
exit code. The module also re-exports the application surface (`interactive-application.ts`)
so consumers import the interactive API from one path.

`createInteractiveApplication` in `src/interactive/interactive-application.ts` is the
composition root. It accepts `InteractiveDeps`, which bundles the contracts it composes:
`providers`, `dispatch`, `agents`, `observability`, the `chat` loop, `bus`, optional
`resources`, `extensions`, `interop`, `share`, `mux`, `session`, a `toolRegistry`, and a long
list of operator-facing callbacks (`onNewSession`, `onResumeSession`, `onForkSession`,
`onCompact`, `onInit`, `onSetThinkingLevel`, and the pane factories). The function returns the
process exit code after `applicationController.run` settles.

The root builds, in order, the terminal shell, a workspace-facts probe, the session transcript,
the presentation (which owns the editor, chat panel, status controller, footer, dispatch board,
and notification center), the event projection, the slash-command runtime, the editor-submit
controller, the tickers, the interactive subscriptions, the overlay lifecycle, the dispatch
steering, and finally the input-runtime application controller that owns the keyboard loop and
shutdown. Each collaborator receives the closures it needs (`requestRender`, `refreshFooter`,
`notify`, etc.) rather than a shared mutable handle.

## What each submodule does

### Chat loop (`chat-loop.ts`)

`createChatLoop` owns the turn state machine and the public `ChatLoop` surface. Its doc block
states it composes single-owner turn modules: `turn-runtime.ts` (target resolution, hot-swap,
agent + event pipeline), `turn-context.ts` (prompt compile cache, snapshots, compaction),
`turn-persistence.ts` (session-ledger appends), `turn-queues.ts` (steer/follow-up mirror),
`turn-recovery.ts` (overflow compact-and-retry, transient retry chain), and `turn-middleware.ts`
(turn hooks and the reminder buffer). `createChatLoop` wires these together through the shared
`ChatTurnState` and owns the `submit`/`cancel` state machine.

The `submit` path runs target resolution and capability probing, runs the pre-submit
auto-compaction trigger, compiles the session prompt, then admits the turn into the engine.
`cancel` accepts an optional `reason` and `source` so a system-initiated stop (loop guard,
operator interrupt-with-message) persists a durable visible assistant turn rather than an empty
aborted message. Out-of-turn rounds (`/btw`, `/draft`, `/handoff`) are refused while a turn is
in flight rather than queued, because they read the compiled history the next turn would see
without mutating it.

### Turn context (`turn-context.ts`)

`createTurnContext` owns the session-prompt compile cache, context-snapshot accounting,
prompt-cache accounting, and compaction. Its doc block states `runAutoCompact` is the one
compaction entry point; the pre-submit trigger, the preflight overflow guard, overflow
recovery, `/context compact`, and the post-tool continuation guard all flow through it. It
publishes the live budget view through `refreshLiveBudget` and `liveBudget` (delegating to the [context budget producer](domains/context.md) in `domains/context/budget/live-view.ts`), tracks a
reconciled provider-attested anchor (`reconciledAnchor`) so the estimate never falls below
provider-attested usage, and accumulates expected-cold-cache reasons (`ExpectedColdReason`)
that the Detailed receipt states when nothing was reused from the prompt cache.

### Chat panel (`chat-panel.ts`)

`createChatPanel` renders the transcript (see [Interactive renderers](interactive/renderers.md) for the renderer modules it calls into). A turn is a sequence of segments interleaved in
engine event order: `TextSegment`, `ToolSegment`, `ErrorSegment`, and `ThinkingSegment`. The
comment explains that storing a flat text buffer plus a tools array collapsed stream order; the
segment list preserves it so tool calls sit between pre-tool narration and the post-tool
summary. Only finalized text is piped through the Markdown renderer, because partial markdown
(unclosed fence, half-typed bullet) would paint garbage at streaming rates. The panel caches
per-entry renders keyed by layout (width, height budget, output style), holds a settled-prefix
/tail split so a frame with nothing new returns the same object, and offers `warmTranscriptRender`
to pay the first-use Markdown/code-ink cost between the hydrated frame and the first answer.

### Status (`status/`)

`status/index.ts` re-exports the status module. `createStatusController` in `status/controller.ts`
owns a single `AgentStatus` and a watchdog. It subscribes to the chat loop's events, to the bus
channels for permission/compaction/dispatch progress, and to `runPreparation` transitions. A
`setInterval` fires `watchdog_tick` every 1000 ms, and an `ended` phase settles back to idle five
seconds later (`SETTLE_MS = 5000`). `reduceStatus` in `status/state-machine.ts` is the pure
reducer that maps an event plus context into the next status. The status types in `status/types.ts`
define `AgentStatus`, `TurnSummary`, `RunTally`, and the overlay precedence constants.

### Theme (`theme/`)

`theme/index.ts` holds a process-wide shared theme (`clioTheme()`) and re-exports the token
components, glyphs, labels, rules, segments, and tokens. `createClioTheme` in `theme/tokens.ts`
builds the `ClioTheme` with truecolor detection, a per-background token palette, and an
`NO_COLOR` guard. `fgSequence` emits a foreground SGR code for a named token, falling back to
the xterm-256 cube when truecolor is unavailable. The token semantics are documented in the
source: `action` is orange for Clio's signature actions, `warning` stays amber, `error` is the
critical token, and `reason` is the reasoning rail.

### Export HTML (`export-html/`)

`renderSessionHtml` in `export-html/index.ts` builds the bounded, self-contained document used by
`/export` (the transcript it renders comes from the [session](domains/session.md) domain's ledger entries). `MAX_HTML_EXPORT_BYTES` is 2 MiB and `TEMPLATE_RESERVE_BYTES` is 8 KiB. It admits whole
rendered rows until the byte budget is full so the result never cuts an ANSI sequence, Unicode
scalar, span, or tool section, and it throws if the final HTML exceeds the budget. The document
itself is a static template in `export-html/template.ts` with no scripts, fonts, stylesheets, or
remote URLs; `export-html/ansi-to-html.ts` and `export-html/tool-renderer.ts` convert the rendered
ANSI lines and tool sections into HTML.

### View overlay (`view/`)

`view/view-overlay.ts` is the `/view` surface for durable evidence bundles. It lays out a left
list pane and a detail pane, collapsing to a single pane below `TWO_PANE_MIN_WIDTH`. It reads
artifacts from the session transcript and the `dataDir` evidence directory, and it verifies
receipts against a seal, reporting `ok`, `fail`, or `retired`.

## How data and control flow

The composition root wires the event flow through `createInteractiveEventProjection` in
`src/interactive/interactive-event-projection.ts`. This is the caller that turns chat-loop and
bus events into rendering decisions. Its primary subscriber calls `onChatEventIngress` (the
canonical synchronous ingress hook) before any branch consumes the event, then routes:

- `notice` events on the `transcript` surface go to `applyChatEvent` (the chat panel);
  `footer` notices go to the notification center.
- `queue_update` sets the follow-up queue panel messages.
- `tool_execution_start`/`tool_execution_end` for a `dispatch` call go straight to the chat
  panel; other tools record start/end on the presentation and refresh the footer.
- `agent_end` closes the ask-user session and refreshes the footer and workspace git.

A second primary subscriber listens to the status controller and, when a phase is `ended` with a
summary, calls `setLastTurnSummary` and refreshes the footer. The remaining subscribers handle
progress, bus context warnings, pruned notices, runtime notices, loop-guard blocks, tool-budget
exceeded, config hot-reload, and safety-blocked notices.

The chat panel is driven by the presentation's `chatRenderer.applyEvent`, which the event
projection calls through `applyChatEvent`. The status controller, built by the presentation,
subscribes to the same `chat.onEvent` and emits `AgentStatusChanged` payloads on the bus when a
phase transitions. The footer dashboard reads `AgentStatus`, the context ledger, dispatch rows,
and the last-turn summary to render its compact and expanded pages.

The data flow from operator to model is: the editor-submit controller expands the submitted text
(`expandInteractiveSubmitAsync` parses skill requests, prompt templates, and inline file
references), then calls `chat.submit`. The chat loop resolves the target, compiles the prompt,
runs pre-submit compaction if the threshold is crossed, and admits the turn into the [engine](engine.md) agent. The engine emits
`AgentEvent`s back through `chat.onEvent`, which the event projection routes to the chat panel
(transcript) and the status controller (footer).

## Boundaries and lifecycle ordering

The chat loop owns the submit/cancel state machine and the shared `ChatTurnState`. It composes
its collaborators and owns the `emit` and `emitNotice` closures, which are the only paths into
the event bus and the transcript notice surface. `submit` is refused for constrained turns while
a run is in flight; an interrupt is refused while an attached dispatch is running or a permission
ask is parked, and degrades to `next-slot` in both cases.

The status controller enforces the settle ordering: a turn only returns to idle five seconds
after `ended`, which is why `reset()` exists to drop the previous session's status. The watchdog
tier is computed from elapsed time since the last meaningful event, and a tier-4 reading moves an
active phase to `stuck` (with the prior phase stored as `resumePhase`). The overlay precedence is
fixed: `stuck > tool_blocked > retrying > compacting > dispatching`, so a stuck watchdog always
beats a pending permission ask.

The turn-context compaction is ordered non-destructively first: a working-set eviction runs before
the LLM summary, and the destructive observation mask is only reachable when
`CLIO_CODER_LEGACY_MASK=1`. A forced compaction (`/context compact`, overflow recovery) skips the
pressure check and runs the summary directly.

The HTML export enforces its byte boundary in two passes: it admits whole rows until the budget is
full, then throws if the assembled HTML still exceeds `maxBytes`. The view overlay enforces its
width boundary by collapsing to a single pane below `TWO_PANE_MIN_WIDTH`.

## Extension seams

- `InteractiveDeps` is the composition seam: a host adds a domain contract (e.g. `resources`,
  `extensions`, `interop`) or an operator callback (e.g. `onCompact`, `onForkSession`) and the
  root wires it through.
- `CreateChatLoopDeps` is the chat-loop seam: it accepts injected `createAgent`, `runSideQuestion`,
  `runHandoffRound`, `runDraftRound`, `autoCompact`, and `planEviction`, so contracts test turn
  behavior without standing up a provider or a reducer.
- `StatusControllerDeps` accepts injected `now`, `setInterval`, `setTimeout`, and `getSettings`
  so the watchdog timing is deterministic in tests.
- The theme tokens are the color seam: adding a named token means adding a column to `XTERM` in
  `theme/tokens.ts` and a hex entry in `core/theme-token-hex.ts`, after which every surface can
  reference it by name through `fgSequence` or `clioTheme().fg`.
- The export-html renderer is the export seam: `renderTranscriptHtml` in `tool-renderer.ts`
  decides how a tool section renders as HTML, and `ansi-to-html.ts` decides how an ANSI line maps
  to a span.

## Focused tests

`tests/contracts/footer-active-statuses.test.ts` demonstrates that retrying and cancelling
workers count as active on every footer surface. It builds a `footerState` fixture, sets two
dispatch rows with `status: "retrying"` and `status: "cancelling"`, and asserts that both the
compact dashboard and the expanded `Status` page report `2 active` at widths 60, 80, 120, and
200. It also asserts that every rendered line's visible width does not exceed the requested width
and that every ANSI tail after the first is a well-formed SGR sequence.

`tests/contracts/context-live-budget.test.ts` exercises the live budget producer that
`createTurnContext` publishes through. It constructs `LiveBudgetInput` rows with a 32768-token
window and a model max of 8192, feeds them through `createLiveBudgetProducer`, and asserts the
reduction policy, the effective window, and the input accounting. It imports `resolveTurnOutputReserve`
from `src/session-control/output-reserve.ts` and `createTurnContext` from `src/session-control/turn-context.ts`,
confirming the turn-context is the owner of the budget publication the footer meter reads.

## Things to watch when editing

- The chat panel's per-entry render cache (`entryRenderCache`) holds up to `REN
DERS_PER_ENTRY = 3` layouts per entry. Adding a fourth output style or a new width dimension
  without increasing that count re-renders the whole transcript on every style switch.
- The status controller coalesces dispatch progress to one refresh per second
  (`DISPATCH_PROGRESS_COALESCE_MS`); lowering it to stream-rate puts the reducer and the provider
  lookup on every worker event.
- The HTML export throws rather than truncates when the template plus the admitted rows exceed
  `maxBytes`; a caller that shrinks the budget below `TEMPLATE_RESERVE_BYTES * 2` gets a clear
  error, not a silent document.
- The theme's `NO_COLOR` guard drops color but keeps bold, dim, italic, and underline; editing a
  surface to hardcode a hex color bypasses that guard, which is why `paintHex` is the only other
  path that emits a literal color.
- The event projection's handler statement order is the rendering contract: `onChatEventIngress`
  runs before any branch, and `applyChatEvent` for a dispatch call returns early so the dispatch
  tool does not also record start/end on the presentation. Reordering those branches changes what
  the footer and the transcript show on the same event.
