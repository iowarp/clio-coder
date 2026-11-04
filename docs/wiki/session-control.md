---
title: "Session control: chat loop, turns, slash commands and replay"
summary: "How Clio drives one conversation: the chat loop state machine, per-turn runtime and context, slash-command parsing and dispatch, the /loop grammar, and rebuilding model messages from the session ledger. Read this before changing turn admission, command routing, or replay."
sources:
  - "src/session-control/index.ts"
  - "src/session-control/chat-loop.ts"
  - "src/session-control/turn-runtime.ts"
  - "src/session-control/turn-context.ts"
  - "src/session-control/slash-commands.ts"
  - "src/session-control/loop-command.ts"
  - "src/session-control/session-replay-messages.ts"
  - "src/session-control/chat-loop-messages.ts"
symbols:
  - "createChatLoop"
  - "ChatLoop"
  - "ChatSubmitOptions"
  - "ChatCancelOptions"
  - "createTurnRuntime"
  - "TurnAdmissionError"
  - "createTurnContext"
  - "parseSlashCommand"
  - "dispatchSlashCommand"
  - "parseLoopLine"
  - "parseLoopArgv"
  - "selectReplayEntries"
tests:
  - "tests/extended/slash-autocomplete.test.ts"
  - "tests/extended/extension-reload-slash.test.ts"
invariants:
  - "A slash-shaped single word that no active command or prompt template claims is rejected as an unknown command rather than sent to the model as prose; a leading backslash before the slash sends the line to the model as text."
  - "parseLoopArgv rejects an empty line, more than the token limit, and any word longer than the byte limit before any create or control parsing."
  - "selectReplayEntries replays from the current compaction cut onward; an older native compaction cut inside the retained suffix does not own replay."
  - "A turn that cannot be admitted is reported with a TurnAdmissionError carrying a machine-readable reason, separate from the operator-facing message."
validate:
  - "pnpm exec vitest run tests/extended/slash-autocomplete.test.ts"
  - "pnpm exec vitest run tests/extended/extension-reload-slash.test.ts"
---

# Session control: chat loop, turns, slash commands and replay

`src/session-control` is the layer between an operator's input (typed text, a slash command, a queued steering message, or a machine-submitted turn) and the engine that calls the model. A reader needs this page when changing how a turn is admitted or cancelled, how a line is classified as a command, how `/loop` is parsed, or how a resumed session rebuilds its model messages from the ledger.

## What the area does

- `src/session-control/chat-loop.ts` owns the `ChatLoop` public surface and the submit and cancel state machine. Its module comment names the sibling modules it composes: `src/session-control/turn-runtime.ts` (target resolution, hot-swap, agent and event pipeline), `src/session-control/turn-context.ts` (prompt compile cache, snapshots, compaction), and others for persistence, queues, recovery and middleware. Only the modules that were inspected for this page are described in detail below.
- `src/session-control/turn-runtime.ts` resolves the orchestrator target and model for a turn, and builds the live agent.
- `src/session-control/turn-context.ts` owns context accounting and compaction triggers.
- `src/session-control/slash-commands.ts` parses a typed line into a `SlashCommand` and dispatches it.
- `src/session-control/loop-command.ts` is the pure grammar for `/loop`.
- `src/session-control/session-replay-messages.ts` converts session-ledger entries into agent messages when a session is replayed.
- `src/session-control/index.ts` is a re-export surface. It exports `clampThinkingLevel`, `selectModel`, `resolvePermission`, `replayCurrentSession` and `restoreSession` from sibling modules, and it is imported by `src/engine/acp/server.ts`, `src/entry/orchestrator.ts`, and the overlay lifecycle modules under `src/interactive/`.

## Chat loop: submit and cancel

`createChatLoop(deps: CreateChatLoopDeps): ChatLoop` in `src/session-control/chat-loop.ts` is the factory. It creates a listener set, the turn state (`createTurnState`), the operator tool limits, and a conversation-eggs helper, then returns the `ChatLoop` object. Callers reach it through the entry layer: `src/entry/orchestrator.ts`, `src/entry/job-host.ts` and `src/entry/job-runtime.ts` appear among its importers, as do the interactive modules `src/interactive/chat-panel.ts` and `src/interactive/interactive-application.ts`, and the print and JSON-stream modes under `src/cli/modes/`. These are import edges; this page did not trace each call site.

The public submit entry is `ChatLoop.submit(text, options?: ChatSubmitOptions)`. The options type documents the cases the loop distinguishes:

- `steering` selects delivery when a run is active. The option documentation says it defaults to `next-slot`, and that `interrupt` cancels the run, waits for it to settle, then submits the text as a fresh prompt. The loop also exposes `interruptRefusal()`, which returns a reason string when an interrupt would be refused, such as an attached dispatch or a parked permission ask, in which case the text is queued for the next slot.
- `queueFront` places a queued message at the head of the steering queue instead of the tail.
- `constraints` carries an explicit host-owned task scope. The option comment states it is never parsed from the prompt text.
- `machineTurn` is a host-only fresh delivery whose text never enters the steering or editor queues.
- `onAdmitted` fires once the submit owns the live turn, and `isAdmissionCurrent` is rechecked after admission awaits.

Cancellation is `ChatLoop.cancel(options?: ChatCancelOptions)`. The option documentation distinguishes a bare cancel from an explained one. A bare cancel is an operator Esc or Ctrl+C that ends the in-flight turn as an empty aborted message. Passing `reason` marks an explained interrupt: the loop persists a visible assistant turn carrying that reason and tags the `turn.aborted` event with `source`. The interrupt text used on the transcript is the constant `INTERRUPT_CANCEL_REASON` in `src/session-control/chat-loop.ts`.

Transcript and footer notices are emitted as `notice` events through `emitNotice` and `emitFooterNotice`, not as fake assistant messages. The code comment on `emitNotice` states that a notice cannot become a headless turn's answer, carries no usage, and does not end a run.

Preparation state is tracked with a refcount. `enterPreparation` and `leavePreparation` maintain `preparingSubmits`, and the phase is set to `idle` only when the last submit leaves. `endPreparationCompaction` restores `preparing` only while a submit is still inside the window. The comments on these functions explain the two-submit overlap case that motivates the refcount.

### Runtime target resolution

`createTurnRuntime(deps: TurnRuntimeDeps): TurnRuntime` in `src/session-control/turn-runtime.ts` owns target resolution. Its inner `readTarget()` reads `settings.chat.target` and `settings.chat.model`, returns `null` when either is missing, and otherwise calls `resolveRuntimeTarget` with `use: "orchestrator"`, `requireOutputBudget: true`, and `requestedThinkingLevel` from settings. When resolution fails, it throws a `TurnAdmissionError`, using the first error diagnostic's message and code as the machine-readable `reason`, falling back to `"admission-failed"`. The class `TurnAdmissionError` in the same file carries that `reason` as a readonly field, and its documentation says the ACP server needs the reason so it does not parse the prose.

Resolution warnings are announced once per target, model and message key, held in `announcedResolutionWarnings`, so the same warning does not print on every submit.

The turn runtime's `TurnRuntime` interface exposes `ensureRuntime`, `dispose`, `cancelRunWatchdog`, `cleanupSessionResources`, `toolTelemetry`, and `takeSettledCalls`. The `toolTelemetry` object is installed on the session tool surface so that the authoritative admission verdict per tool call reaches the runtime, keyed by the engine's `toolCallId`. The inline comment says the engine's `tool_execution_end` event carries only `isError` and text and cannot distinguish a permission block from a non-zero exit.

Two other behaviors are documented in `src/session-control/turn-runtime.ts` and were read in source only. A stream stall is reported by `stallAbortReason`, which names the target and the seconds without output, and a cold-model notice from `coldModelNotice` warns that the first request will load a model that the discovery view reports as not resident or still loading. The notice never blocks the request.

### Turn context

`createTurnContext(deps: TurnContextDeps): TurnContext` in `src/session-control/turn-context.ts` owns context accounting and compaction. It constructs an `AutoCompactionTrigger` and reads a `middleware` dependency. The module-level constant `AUTO_COMPACT_FAILURE_LIMIT` bounds repeated automatic compaction failures. The file header summary in the code map describes `runAutoCompact` as the single compaction path, but this page did not read that function, so its behavior is not described here.

## Slash commands

`parseSlashCommand(input: string): SlashCommand` in `src/session-control/slash-commands.ts` is pure: it has no I/O. Its special cases are visible in the source: a bare `/rename` with trailing whitespace returns a `usage-error`, and a leading slash followed by a token is classified as `unknown-command` when the token matches `COMMAND_SHAPED_TOKEN` (`/^[A-Za-z][A-Za-z0-9:-]*$/u`) or when `isExtensionCommandToken` accepts it. The code comment on `COMMAND_SHAPED_TOKEN` explains that a token shaped like a command must not fall through to the model, because the model would invent a result. A token that contains a separator, such as an absolute path, is not command-shaped and reaches the model unchanged.

`COMMAND_ESCAPE` is the two-character prefix `\/`. Its comment states that the escape survives trimming and is only meaningful before a slash, so a backslash in other positions remains ordinary text.

`dispatchSlashCommand(command: SlashCommand, ctx: SlashCommandContext): SlashCommandDispatchResult` returns `"accepted"` or `"rejected"`. The editor uses that value to decide whether to clear the draft. Its branches, read in source:

- `empty` returns `"rejected"`.
- `unknown` submits the text to the chat loop through `ctx.submitChat` and returns `"accepted"`.
- `unknown-command` first checks the operator-extension runtime for a prompt takeover whose invocation matches the token. A takeover that is still restarting produces a warning notice and returns `"rejected"`, so a restart does not send the prompt to the model. Otherwise prompt-template expansion is tried. A display-only template is answered on the operator's side without a model turn.
- Any other kind is looked up in `HANDLER_BY_KIND` and dispatched to that entry's `handle`, returning `"rejected"` only when the handler does.

`HANDLER_BY_KIND` and `COMMAND_NAMES` are built from `BUILTIN_SLASH_COMMANDS` at module load. The loop throws if one command name or one `kind` is claimed by two entries, so kind ownership is enforced at startup. `BUILTIN_SLASH_COMMANDS` is `CANONICAL_SLASH_COMMANDS` plus a `/compact` alias that is built from the `/context` entry and routes to `{ kind: "compact", instructions }`.

Focused test evidence for the slash surface:

- `tests/extended/slash-autocomplete.test.ts` checks that `parseSlashCommand("/compact retain all task constraints")` deep-equals `parseSlashCommand("/context compact retain all task constraints")`, and that the alias dispatches to the same `runCompact` handler with the instructions string. The same file asserts that `/context init --propose --rewrite` (with `--adopt`, `--apply`, `--rewrite` each tried) returns `kind: "usage-error"`, and that `/context init --unknown` also returns `usage-error`.
- `tests/extended/extension-reload-slash.test.ts` runs `parseSlashCommand` over a set of inputs and asserts the `kind` of each, and runs `dispatchSlashCommand` on `/extensions reload` against success, failure and absent-runtime contexts.

The test suite does not, in the files read here, assert the exact `COMMAND_ESCAPE` behavior or the `unknown-command` fall-through for a single-token typo. Those statements are based on the source comments and branches above and were not tested by a focused case read.

## `/loop` grammar

`src/session-control/loop-command.ts` is documented in its module summary as pure: no I/O, no clock, no registry import. `parseLoopLine(text)` tokenizes the line with `tokenizeLoopLine` and then calls `parseLoopArgv(tokens)`.

`parseLoopArgv` applies three guards before any verb is recognized: an empty token list is rejected, a token count over `MAX_TOKENS` is rejected, and any token whose UTF-8 byte length exceeds `MAX_TOKEN_BYTES` is rejected. The verbs `list`, `status`, and the control actions from `LOOP_CONTROL_ACTIONS` (including `cancel`, which accepts a bare form with no id) are handled by their own branches. Any other first word goes to `parseCreate`.

`parseCreate` reads an interval, which must match `parseLoopDuration` such as `30s`, `5m` or `2h`, before or after the options, and then a task. Options come from `VALUE_FLAGS` and `DURATION_FLAGS`, and a repeated flag is refused. `--command` must come after the interval, because its trailing words are taken as argv. `--` ends option parsing and makes the rest the task text. The `--until` option is parsed by `parseLoopPredicate`, and `--on-match` accepts `notice` or `main_turn`.

No focused test for `parseLoopLine` or `parseCreate` was located. The repository-wide search for `parseLoopLine(` returned no test in the tests directory that was reviewed, so the `/loop` grammar is described from source only. A related contract file exists at `tests/contracts/loop-cancel.test.ts`, but it was not read, so this page makes no claim about its assertions.

## Replay from the session ledger

`selectReplayEntries(turns, options)` in `src/session-control/session-replay-messages.ts` chooses which ledger entries a replay uses. Its steps, read in source:

1. Filter the entries to the active path for `activeLeafTurnId` or `uptoTurnId`.
2. Truncate at `uptoTurnId` with `truncateAtTurn`.
3. Compute the current compaction cut with `compactionCut(entries)`.
4. If there is no compaction (`cut.compactionIndex < 0`), return the entries with legacy tool-result assistant duplicates dropped.
5. Otherwise, return the compaction summary followed by the visible entries after the cut, excluding any native `providerCheckpoint` compaction summary, then repair orphaned tool results against the cut index and drop legacy duplicates.

The inline comment on step 5 states that a retained suffix can contain an older native cut, and only the current cut owns replay. No focused test of `selectReplayEntries` was located in the test directories searched, so this behavior is described from source only.

`src/session-control/session-restore.ts` is the module that the index re-exports as `restoreSession` and `replayCurrentSession`. This page did not read it, so the callers of `selectReplayEntries` beyond the file itself are not described.

## Things to watch when editing

- Command-shaped detection is a deliberate fail-closed rule: a single word that matches `COMMAND_SHAPED_TOKEN` is treated as a command even when it is prose, and a sentence that must begin with such a word needs the `\/` escape. Changing the regular expression changes which lines reach the model.
- `HANDLER_BY_KIND` enforces one owning entry per `kind` at module load. A new command must not reuse a kind that another entry already claims, or the module throws on import.
- `dispatchSlashCommand` returns `"rejected"` to keep the operator's draft. A new handler that returns `"accepted"` for a refused action will clear the draft.
- `TurnAdmissionError.reason` is a wire contract for the ACP server and is not prose. Change the reason strings only together with their consumers, which were not traced.
- The replay cut rule in `selectReplayEntries` depends on `compactionCut`, which lives in another module. Changing the cut definition alters replay for every resumed session.
- `src/session-control/chat-loop.ts` and `src/session-control/turn-context.ts` are large single-owner modules. The chat-loop header lists the sibling modules that own persistence, queues, recovery and middleware. Those modules were not read for this page, so changes that cross them are not described here.
