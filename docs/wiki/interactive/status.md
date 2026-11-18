---
title: "Command-line status and footer state"
summary: "How the interactive session derives its live status (phase, watchdog tier, tool and dispatch overlays, end-of-turn summary) from chat and telemetry events, and how that status is rendered as footer verbs and reasoning chips. Read this before changing footer status text, watchdog timing, or turn summaries."
sources:
  - "src/interactive/status/index.ts"
  - "src/interactive/status/state-machine.ts"
  - "src/interactive/status/controller.ts"
  - "src/interactive/status/summary.ts"
  - "src/interactive/status/verbs.ts"
  - "src/interactive/status/reasoning.ts"
  - "src/interactive/status/watchdog.ts"
symbols:
  - "createStatusController"
  - "reduceStatus"
  - "resolveFooterVerb"
  - "computeWatchdogTier"
  - "buildSummary"
  - "summaryFromRunTally"
  - "foldMessageIntoRunTally"
  - "formatReasoningChip"
tests:
  - "tests/extended/output-styles.test.ts"
  - "tests/contracts/diffusion-frames.test.ts"
  - "tests/contracts/dogfood-cancellation.test.ts"
invariants:
  - "The watchdog tier is computed from the time since the last meaningful event; tier 4 moves an active turn to the stuck phase, and a tier below 4 returns it from stuck to its resume phase."
  - "A dispatch_progress event refreshes the watchdog only while the turn is awaiting a dispatch; it does not refresh an unrelated turn."
  - "A run tally folds the same messages through the same function on the normal path and the cancel path, so the two summaries agree for the same run."
  - "Footer status text for a finished turn is derived from the stop reason of the summary; a cancelled turn never renders as Done."
validate:
  - "pnpm run test:file -- tests/extended/output-styles.test.ts"
  - "pnpm run test:file -- tests/contracts/diffusion-frames.test.ts"
  - "pnpm run typecheck"
---

# Command-line status and footer state

The status subsystem under `src/interactive/status/` owns what the interactive footer says about a turn while it runs and after it ends. A reader needs this page when footer text, the stuck/no-output indicator, the watchdog timing, the reasoning chip, or the end-of-turn summary behaves unexpectedly. The subsystem is a pure reducer (`reduceStatus`) driven by a controller (`createStatusController`) that subscribes to chat and telemetry events, plus presentation helpers that turn the resulting `AgentStatus` into strings.

## What this area does

- Holds one `AgentStatus` value per session, starting from `INITIAL_STATUS` (types live in `src/session-control/status-types.ts`, re-exported by `src/interactive/status/index.ts`).
- Translates chat-loop events (`agent_start`, `turn_start`, `message_update`, `tool_execution_start`, `tool_execution_end`, `agent_end`, `retry_status`, `text_delta`, and similar) into phase transitions in `reduceStatus`.
- Runs a one-second tick (`TICK_INTERVAL_MS` in `src/interactive/status/controller.ts`) that feeds `watchdog_tick` events, which escalate the watchdog tier and may move the turn into `stuck`.
- Accumulates a run tally from settled messages, so a cancelled turn still reports its usage and tool counts.
- Renders footer verbs (`resolveFooterVerb`) and reasoning chips (`formatReasoningChip`).

## Ownership and key symbols

- `src/interactive/status/state-machine.ts`: `reduceStatus` is the single transition function. Event shapes are declared here (`StatusInputEvent`, `ReduceContext`, and the status-only event interfaces such as `DispatchProgressStatusEvent`, `SubmitAcceptedStatusEvent`). Phase sets are the module constants `OVERLAY_PHASES`, `CORE_ACTIVE_PHASES`, and `OVERLAY_PRECEDENCE`.
- `src/interactive/status/controller.ts`: `createStatusController` owns the mutable `status` variable, the listener set, the settle timer (`SETTLE_MS` = 5000), the abort ceiling timer, and the throttled `notify` path (`STATUS_EMIT_THROTTLE_MS` = 100). `StatusController` exposes `current`, `subscribe`, `reset`, and `dispose`.
- `src/interactive/status/watchdog.ts`: `TIER_THRESHOLDS_MS` (tier1 10s, tier2 30s, tier3 90s, tier4 and stuck 180s, postAbortCeiling 300s) and `computeWatchdogTier`. The stuck threshold can be overridden by the `CLIO_CODER_STATUS_STUCK_MS` environment variable when it parses to a positive finite number.
- `src/interactive/status/summary.ts`: `foldMessageIntoRunTally`, `emptyRunTally`, `summaryFromRunTally`, and `buildSummary`.
- `src/interactive/status/verbs.ts`: `resolveFooterVerb` and `spinnerFrame`. Elapsed formatting delegates to `formatCompactMs` from the theme module.
- `src/interactive/status/reasoning.ts`: `reasoningFromQuantity`, `compactReasoningTokens`, `formatReasoningChip`, and the `UNMEASURED_REASONING` constant.

## Callers and dependencies

Upstream, `src/interactive/interactive-presentation.ts` constructs the controller with `chat`, `providers`, `bus`, and `getSettings` (the call site is near the `factories.createStatusController({...})` invocation). The footer renderer `src/interactive/footer/dashboard.ts` calls `resolveFooterVerb(status, now, width)` and imports `spinnerFrame`, both through `src/interactive/status/index.ts`.

Downstream, the controller depends on the chat loop (`ChatLoop.onEvent`, `onTurnPreparation`, `getSessionId`), the telemetry hub (`bus.subscribe` for `approval.requested`, `approval.resolved`, `compaction.started`, `compaction.ended`, `context.activity_changed`, `run.progressed`, `run.aborted`, `turn.aborted`, and emission of `agent.status_changed`), the provider registry (`providers.list()` to decide `localRuntime` from `runtime.tier === "local-native"`), and the settings accessor for the current target and model. The reducer depends on `buildSummary` and the tally helpers in `src/interactive/status/summary.ts`, `computeWatchdogTier`, `effectiveToolCall` from `src/tools/surface.ts`, and `ToolNames`.

## Data and control flow

1. The controller wraps each `apply(event, force)` call with `reduceStatus(prev, event, ctx)`, where `ctx` carries `now`, `localRuntime`, `modelId`, `targetId`, and `runId` read at that moment.
2. If the reducer returns the same object, nothing changes. Otherwise the new status replaces `status`. An `agent_start` clears the settle timer. A transition into `ended` clears the abort ceiling and schedules a settle back to `INITIAL_STATUS` after five seconds.
3. `notify` emits an `agent.status_changed` telemetry event on any phase change. Listeners are called on phase change or when at least `STATUS_EMIT_THROTTLE_MS` has elapsed since the last notification. `force` bypasses the throttle; the controller passes `force = true` for most bus-driven events and for `agent_end`.
4. Worker stream evidence is filtered before it reaches the reducer. `run.progressed` payloads are checked by `isWorkerStreamEvidence`, which rejects heartbeat and heartbeat_status event types, and `dispatch_progress` is applied at most once per `DISPATCH_PROGRESS_COALESCE_MS` (1000 ms).

### Watchdog tiers and stuck handling

On `watchdog_tick`, an inactive phase is returned unchanged. A turn whose current tool is `ask_user` is treated as waiting for the operator: the phase is forced to `tool_running` with tier 0. Otherwise the elapsed time since `lastMeaningfulAt` is passed to `computeWatchdogTier`. A tier of 4 moves a non-stuck turn to `stuck`, recording the previous phase in `resumePhase`. A tier below 4 returns a stuck turn to its `resumePhase` (defaulting to `thinking`). Any other tick updates `watchdogTier` and `watchdogPeak` in place.

The `dispatch_progress` branch only refreshes `lastMeaningfulAt` when `isAwaitingDispatch` is true, which checks for a `tool_running` dispatch tool, a `dispatching` phase, or a `dispatching` overlay. A focused test in `tests/extended/output-styles.test.ts` (the test titled "fresh worker output clears the silence timer while waiting for dispatch") starts from a stuck status with `resumePhase: "tool_running"` and a `dispatch` tool at `since: 1`, applies `dispatch_progress` at `now: 600001`, and asserts that `lastMeaningfulAt` becomes `600001` and `watchdogTier` becomes 0. A following `watchdog_tick` at `now: 600002` leaves the phase as `tool_running`.

### Overlays

Overlays (`tool_blocked`, `retrying`, `compacting`, `dispatching`, `stuck`) are stacked. `pushOverlay` stores the current visible frame, records the new one, and makes the highest-precedence frame visible (`OVERLAY_PRECEDENCE`: stuck, tool_blocked, retrying, compacting, dispatching). `popOverlay` removes a frame and restores the next visible frame, or falls back to the base phase when none remain. Overlay push and pop are reached from the controller's bus subscriptions and from `retry_status` events.

### Turn summary and cancel path

`agent_end` rebuilds a summary with `buildSummary` from the event's messages. When the live `runTally` has folded at least as many settled messages as the event's window holds, the summary is instead built with `summaryFromRunTally` from that tally. The comment in `src/interactive/status/state-machine.ts` explains why: on the abort path the engine replaces the run's window with a synthetic zero-usage failure message, so a rebuild from the window would undo the abort summary. `run_aborted` and `force_cancelled` both end the turn through `cancelledSummary`, which uses the live tally. The stop reason in `buildSummary` maps an assistant `stopReason` of `aborted` with a tool argument generation source to `generation_guard`.

`foldMessageIntoRunTally` is the shared fold: tool results increment `toolCount` and, when `isError` is true, `toolErrorCount`; assistant messages increment `settledMessages` and record the response model observation from usage.

### Footer rendering

`resolveFooterVerb` returns `null` for `idle`. For `ended` it returns the core verb with a status glyph: `generation_guard` renders as "Generation stopped", `cancelled` or `aborted` as "Cancelled", `error` as "Failed", `length` as "Output limit", and anything else as "Done", each with the elapsed summary time. For `stuck`, the text is "No output" with an appended elapsed time and "Esc to cancel" when the terminal is at least 60 columns wide. Otherwise the core verb gains an elapsed suffix from `formatLiveElapsed`, which shows nothing under one second, whole seconds below ten, and `formatCompactMs` above that. A running tool counts from `toolStartedAt`, not turn start.

Reasoning chips: `reasoningFromQuantity` converts a `Quantity` into a `ReasoningUsageView`. `formatReasoningChip` returns `r<count>` for a provider-measured count, `r≈<count>` for an estimated or mixed count, and `null` when the view is unmeasured or a non-provider zero.

## Tests

- `tests/extended/output-styles.test.ts` exercises the footer through the reducer. Its turn sequence (`agent_start`, `turn_start`, a tool-call start, `text_delta`, then a `tool_execution_start` for `read`) is checked by `resolveFooterVerb` at several `now` values. The assertions include `"Preparing tool call · 2s"` at 3400 ms after the turn began, `"Writing · 2s"` after streamed text, and `"Running read · 12s"` at 13400 ms. The dispatch-progress case described above is in the same file.
- `tests/contracts/diffusion-frames.test.ts` reduces a `text_frame` sequence after `agent_start` and `turn_start` and checks the footer text from `resolveFooterVerb(state, 1000, 100)`.
- `tests/contracts/dogfood-cancellation.test.ts` builds an `ended` status with a summary and asserts that `resolveFooterVerb` renders "Generation stopped" for the `generation_guard` stop reason.
- `tests/extended/welcome-boot-header.test.ts` and `tests/extended/slash-autocomplete.test.ts` replace `createStatusController` with stubs; they do not exercise its behavior.

These tests were located by searching `tests/**` for the status symbols and paths. Their execution is not verified in this page; the validate list above names the commands to run them.

## Extension seams

- New footer text for a phase belongs in `coreVerb` in `src/interactive/status/verbs.ts`, which is the only place a phase becomes display text.
- New stop reasons need an entry in `TurnStopReason` (in `src/session-control/status-types.ts`), a branch in `coreVerb`, and handling in `assistantStopReason` in `src/interactive/status/summary.ts` if they come from assistant messages.
- New chat or bus events that should change status are added as a case in `reduceStatus` and, for bus events, as a subscription in `createStatusController`.
- Watchdog thresholds change in `TIER_THRESHOLDS_MS`; the environment override applies only to the stuck threshold.

## Things to watch when editing

- `reduceStatus` returns `prev` unchanged for events it does not handle, and the controller skips notification when the reference is unchanged. Returning a new object for a no-op event causes extra notifications.
- `agent_end` prefers the live tally only when `settledMessages` is positive and at least the window's settled count. Changing how messages are folded in `foldMessageIntoRunTally` changes both the normal and cancel paths together, which is intended.
- `dispatch_progress` is gated by `isAwaitingDispatch`. A change to the dispatch overlay or tool name needs to keep that check in step with the phase it reads.
- The controller's `reset` and the five-second settle both return the status to `INITIAL_STATUS`; a `reset` during an active turn discards the in-progress state.
- The stuck threshold reads `CLIO_CODER_STATUS_STUCK_MS` at each call of `computeWatchdogTier` with its default argument, so the value is read per tick, not once at startup.

## Coverage notes

The reducer's `ask_user` operator-wait exemption, the overlay push/pop sequencing, and the `compacting`, `approval`, and `run.aborted` controller subscriptions were read in source. Focused test cases exist for the footer timing, the dispatch-progress refresh, the diffusion text frames, and the generation-guard footer. Overlay precedence and the abort-path summary are described from source reads without a dedicated focused test case in the files listed above.
