# Codex review notes: worker visibility

Review range: `d36616bd...65b99748`. No source changes were made. The tree was clean before this note, so no WIP stash was needed.

## Confirmed lifecycle bugs

### 1. A superseded attempt can settle the active attempt

References:

- `src/interactive/worker-stream.ts:307-315` maps every attempt run id to one mutable assignment entry, then reads the receipt using the entry's current `runId`.
- `src/interactive/worker-stream.ts:377-380` correctly rejects progress whose run id is not the current attempt.
- `src/interactive/worker-stream.ts:413-440` omits that current-attempt check for completed, failed, and aborted events.

Triggering sequence:

1. `started({ runId: "r1", assignmentId: "a1" })` creates the entry.
2. `started({ runId: "r2", assignmentId: "a1" })` changes the same entry's current run to `r2` but retains the `r1 -> a1` lookup.
3. A late `failed({ runId: "r1" })`, `completed({ runId: "r1" })`, or `aborted({ runId: "r1" })` resolves to the shared entry.
4. The late event marks `r2` terminal. The terminal path can also read `r2`'s receipt while handling `r1`'s event.

Correct fix: use one `currentEntryForRun` guard for progress and every terminal path. Require `entry.runId === payload.runId` before mutation. Keep abort provisional only for the current attempt so a later sealed terminal event for that same run may replace it.

### 2. Worker history and chat-panel history can diverge

References:

- `src/interactive/worker-stream.ts:121-129,286-305` gives the reducer an independent retention limit and removes settled entries from its maps.
- `src/interactive/chat-panel.ts:1292-1312` keeps every applied worker entry in the transcript and its own map.
- `src/interactive/chat-panel.ts:1411-1415` clears panel history on reset.
- `src/interactive/interactive-application.ts:526-528` makes `/share` read reducer history, not panel history.
- `src/interactive/interactive-application.ts:620-631` resets the panel but not the reducer.

Retention trigger:

1. Create and settle assignment `a` while applying it to the panel.
2. Add enough assignments to exceed `maxEntries`; `prune()` removes `a` only from the reducer.
3. The operator can still see `a`, but `/share a` cannot find it.

Reset trigger:

1. Create or settle assignment `a`.
2. Start a new session; `chatPanel.reset()` clears the visible entry, while `workers.entries()` still contains it.
3. Bare `/share` can select the previous session's result. A late old-session event can also apply the old block into the new transcript.

Correct fix: remove the disconnected retention option and add one session-reset operation that clears reducer routing/history with the panel. Prefer making the panel's worker entries the share-selection view, or expose a single coordinated transcript store. Tests should cover retention visibility, `/new`, late old-session events, and `/share` isolation.

## Baseline test defect

`tests/contracts/dispatch-worker-panel.test.ts:133-140` fails with `63 !== 1`. Under the test environment, `theme.fgSequence("action")` is an empty string, so `rendered.split("")` counts characters rather than action-color sequences.

Correct fix: do not infer semantic color by splitting an ANSI string when color may be disabled. Assert the presentation token directly through `dispatchOriginPresentation({ requestOrigin: "agent" })`, or run an explicit color-enabled theme fixture and first assert the escape sequence is nonempty. The direct token assertion is smaller and independent of terminal color policy.

Focused baseline result: 75 passed and this assertion was the only failure. Baseline `npm run typecheck` and `npm run lint` both passed.

## Planned simplifications

- Unify the terminal projection now duplicated by `src/interactive/worker-stream.ts:257-283`, `src/interactive/worker-receipts.ts:33-83`, and `src/interactive/worker-replay.ts:62-80`. One receipt-to-view projector should feed both live settlement and replay. Expected saving: 45 to 70 production lines while removing a live/replay drift point.
- Reuse the session runtime identity types from `src/domains/session/entries.ts:206-225` in `src/interactive/worker-stream.ts:35-59`, or move the canonical small identity type to the dispatch/session boundary. Expected saving: 15 to 25 lines.
- Remove `maxEntries` and `prune()` from `src/interactive/worker-stream.ts:121-129,286-305`; coordinate explicit session reset instead. Expected net saving after adding reset: 10 to 18 lines.
- Factor the repeated worker fold plus repaint sequence in `src/interactive/interactive-subscriptions.ts:54-102`. Expected saving: 15 to 25 lines.
- Let one terminal summary retain optional tokens and elapsed values instead of converting missing replay facts to zero in `src/interactive/worker-replay.ts:68-79`. This is both smaller and more truthful.

Estimated production reduction for the above work: roughly 85 to 135 lines before any test additions.

## UI and UX observations

- The live shape is readable and attributed, but `◇ you -> coder · target/model · run id` spends much of a 40-column row on grammar. The origin glyph already carries who asked. A shorter route-first header could preserve every fact while truncating less often.
- The folded card reserves status, elapsed, and `[Ctrl+O expand]` before fitting the identity. At narrow widths, the worker or route can disappear even though those are the facts needed to choose a card. Prefer a short dynamic hint such as `[Ctrl+O]` or `Ctrl+O open`, with identity taking priority over elapsed.
- The one-hint rule for a fan-out is good. Three folded cards remain three consecutive rows, and only the newest target advertises the key.
- The current method name and help language say "tool" while the action toggles the newest tool or worker. Operator wording should say "details" or "fold" so the behavior is discoverable and predictable without changing the shared binding.
- Expanded worker rails match streamed thinking and tool-body grammar well. The footer contains the right facts, but long failure text can dominate a narrow terminal. Keep the first failure line, placing wrapped detail on a rail line rather than making the receipt footer visually heavier than the body.
- ACP and native workers correctly share one visual grammar. Tool names are coalesced and worker tool arguments are excluded by the reducer's event whitelist.

## Changes not worth making

- Do not remove the first-class `workerRun` session entry. It is the typed, context-free identity needed for replay and is safer than an untyped custom entry.
- Do not persist streamed worker text. The sealed receipt must remain terminal truth.
- Do not merge worker lifecycle state into assistant tool segments. User-origin runs have no parent tool, and replay needs assignment-level failover identity. Reuse the existing fold controls and visual primitives instead.
- Do not show internal-origin runs in the transcript or implicitly share any worker answer with the model.
- Do not expose `tool_execution_start.args` to obtain richer tool labels. Names-only telemetry is the correct privacy boundary.
