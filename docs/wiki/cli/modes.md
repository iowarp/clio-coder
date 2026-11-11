---
title: "Command-line headless modes and the run --json wire stream"
summary: "How `clio-coder run` executes a headless main-agent turn, settles its dispatched workers, and writes the --json frame stream. Read this when you change run output, exit codes, the JSON schema, or dispatch settlement."
sources:
  - "src/cli/modes/print.ts"
  - "src/cli/modes/run-json-schema.ts"
  - "src/cli/modes/json-stream.ts"
  - "src/cli/modes/headless-dispatched-runs.ts"
  - "src/cli/modes/jsonl.ts"
symbols:
  - "runHeadlessMainAgent"
  - "createHeadlessJsonProjector"
  - "projectHeadlessJsonEvent"
  - "settleDispatchedRuns"
  - "describeRuns"
  - "writeFrame"
  - "RUN_JSON_SCHEMA_VERSION"
  - "BLOCKED_ATTEMPTS_LIMIT"
tests:
  - "tests/contracts/headless-dispatched-runs.test.ts"
invariants:
  - "Each stdout line of a run --json stream is one compact JSON object written through writeFrame, with LF as the only record delimiter."
  - "The first frame of a main-agent --json stream is a session header carrying schemaVersion, or a pending header when admission refuses before a session exists."
  - "message_update events are dropped from the --json stream; assistant text and thinking arrive as text_delta and thinking_delta increments."
  - "A run that finishes its turn waits for every run it dispatched to seal before the run is recorded, and reports dispatched runs whose final outcome is failed, timed_out, stalled, canceled, denied_by_policy, or spawn_failed unless a later attempt superseded them."
  - "Once a shutdown has started, a run that was in flight is sealed with outcome canceled, or timed_out when the --timeout deadline expired."
validate:
  - "pnpm run test:file -- tests/contracts/headless-dispatched-runs.test.ts"
---

# Command-line headless modes and the run --json wire stream

This page covers the non-interactive side of `clio-coder run`: how a headless main-agent turn is driven to completion, how its stdout is shaped when `--json` is set, how dispatched worker runs are waited on, and how the failure line is produced. A reader needs it when changing exit codes, the JSON frame schema, or the settlement of detached workers. The interactive surfaces are documented in [interactive.md](../interactive.md), and the command-line argument parsing and `run` command dispatch are documented in [cli.md](../cli.md).

## What this area does

The five files in `src/cli/modes/` form one pipeline:

- `src/cli/modes/print.ts` owns `runHeadlessMainAgent`, which submits one prompt to a `ChatLoop`, observes its events, decides a terminal outcome, waits for dispatched workers, seals a run ledger row, and returns a process exit code.
- `src/cli/modes/json-stream.ts` projects chat-loop events into wire frames. It is the stateful projection used by the main-agent stream, and it has a separate projection for events that come from dispatched workers.
- `src/cli/modes/run-json-schema.ts` declares the wire types and `RUN_JSON_SCHEMA_VERSION`. It contains types and one constant only.
- `src/cli/modes/jsonl.ts` serializes one frame per line and writes it to stdout through the output guard.
- `src/cli/modes/headless-dispatched-runs.ts` waits for runs whose lineage root is the headless run, classifies undelivered outcomes, and formats the one-line failure description.

## Ownership and entry points

| Symbol | File | Role |
| --- | --- | --- |
| `runHeadlessMainAgent` | `src/cli/modes/print.ts` | Entry point for a main-agent headless turn. Returns the exit code. |
| `HeadlessMainAgentOptions` | `src/cli/modes/print.ts` | Input contract: prompt, `mode` (`text` or `json`), `jsonEvents` (`full` or `terminal`), `dispatch`, `deadline`, `shutdown`, `failOnNoop`, `costCap`, and the usage readers. |
| `createHeadlessJsonProjector` | `src/cli/modes/json-stream.ts` | Returns a stateful `project(event)` that yields zero or more frames per chat-loop event. |
| `projectHeadlessJsonEvent` | `src/cli/modes/json-stream.ts` | Stateless per-event projection used by the projector. |
| `projectDispatchJsonEvent` | `src/cli/modes/json-stream.ts` | Projection for events read from a worker's output. |
| `settleDispatchedRuns` | `src/cli/modes/headless-dispatched-runs.ts` | Waits for dispatched runs and returns `live` and `undelivered` sets. |
| `describeRuns`, `projectDispatchedRunOutcome` | `src/cli/modes/headless-dispatched-runs.ts` | Text and structured renderings of a settled run. |
| `writeFrame` | `src/cli/modes/jsonl.ts` | The only place a `run --json` frame reaches stdout. |
| `RUN_JSON_SCHEMA_VERSION` and the `RunJson*` types | `src/cli/modes/run-json-schema.ts` | Declared wire schema. |

The file `src/cli/modes/run-json-schema.ts` states the versioning rule: bump `RUN_JSON_SCHEMA_VERSION` when a frame loses a field, a field changes meaning or type, or a frame type is removed. Adding an optional field or a new frame type does not bump it.

## Callers and dependencies

Upstream, `runHeadlessMainAgent` is called from two places. `src/cli/run.ts` builds the options from parsed arguments, including `failOnNoop` at the `parsed.failOnNoop` branch, and `src/entry/orchestrator.ts` calls it with `options.headless` at the call near line 5685, forwarding `failOnNoop` when it is `true`. Both pass a `ChatLoop` and the options object, and receive the numeric exit code.

Downstream, `src/cli/modes/print.ts` imports `writeFrame` from `src/cli/modes/jsonl.ts`, `createHeadlessJsonProjector` and the dispatch projections from `src/cli/modes/json-stream.ts`, and `settleDispatchedRuns` from `src/cli/modes/headless-dispatched-runs.ts`. `src/cli/modes/jsonl.ts` writes through `writeRawStdout` in `src/cli/output-guard.ts`. The dependents list for `src/cli/modes/jsonl.ts` also names `src/cli/run-failure.ts` and `src/cli/run.ts`.

## Main-agent flow

The control flow inside `runHeadlessMainAgent` is:

1. A `runId` is created before submit, so that dispatched children can name the parent. Each `submit` call passes `hostRun` with that `runId` and a lineage whose `rootRunId` equals it.
2. `chat.onEvent` is subscribed. For each event in `--json` mode, `jsonProjector.project(event)` produces frames, and each frame is queued through `writeMainFrame`. In `text` mode, only `notice` events with `surface === "transcript"` are written, to stderr.
3. Usage is accrued on each `message_end` for assistant messages. Calls whose `disposition` is `never_sent` are excluded, and attempts are deduplicated through `seenAttempts`.
4. `chat.submit` runs inside `withRunOverrides`, which carries sampling overrides for the turn.
5. After `submit` resolves, the code waits on dispatched runs through `settleDispatchedRuns`. It polls every 500 ms (`SETTLE_POLL_MS`) and stops early when `termination.isShuttingDown()` returns true.
6. A terminal outcome is chosen by a fixed branch order: shutdown (`timed_out` if the deadline expired, otherwise `canceled`); then `abortReason` (`canceled`, exit 1); then `error` (`failed`, exit 1, or `SESSION_COST_CEILING_EXIT_CODE` when the error begins with the cost-ceiling reason); then output exhaustion without a terminating tool result (`failed`); then empty text (the branch continues past this excerpt). The no-op branch with `failOnNoop` appears at the `limited || blockedWithoutChange || (options.failOnNoop === true && headlessNoop(runStats))` check.
7. The run is sealed through `recordRun`, which is registered as a drain hook through `termination.onDrain`. Whichever caller arrives first seals the run; the other awaits the same promise.

The shutdown and seal ordering is a deliberate contract, documented in source comments in `src/cli/modes/print.ts`: a signal handler exits the process from within shutdown before the awaited submit resumes, so the drain hook is the path that seals an interrupted run.

## Frame projection

`projectHeadlessJsonEvent` applies these rules, as written in the module header of `src/cli/modes/json-stream.ts`:

- `message_update` returns `null` and is dropped.
- `text_delta` and `thinking_delta` keep only `contentIndex` and `delta`.
- `message_end` replaces assistant `text` and `thinking` blocks with `streamed: true` markers carrying `textLength` or `thinkingLength`. Signatures (`textSignature`, `thinkingSignature`) are removed. `user` and `toolResult` messages pass through unchanged.
- `agent_end` becomes a `segmentSummary`: `messageCount` and a `usage` object summed by `sumRunUsage`, with no message array.
- `turn_end` keeps assistant text (`keepText` is true), so a reader can take the answer from one event, and drops `toolResults`.
- Tool events whose capability ran through the gateway are rewritten to the capability name with `via: "gateway"`.

`createHeadlessJsonProjector` adds state. It records the capability named on a gateway `tool_execution_start`, so that the matching end frame keeps the name even when its result lacks `details.capability`. For a gateway chain, each settled step becomes its own start and end frame pair through `chainStepFrames`, with `toolCallId` set to the parent id joined with the step id and `parentToolCallId` set to the parent.

`projectDispatchJsonEvent` handles events read from worker output. A value that is not a record with a string `type` is wrapped as `{ type: "worker_event", event }`. An `agent_end` loses its `messages` array and gains the same segment summary.

## Dispatch settlement

`settleDispatchedRuns` selects runs whose `lineage.rootRunId` equals the headless run id and whose id differs from it (`dispatchedBy`). It loops while any of them is non-terminal and shutdown has not started, then re-reads the list. A run counts as undelivered when it is terminal, its outcome is one of `failed`, `timed_out`, `stalled`, `canceled`, `denied_by_policy`, or `spawn_failed`, and no later run has it as `parentRunId` with `attempt > 0`. Runs still non-terminal are returned in `live`.

`describeRuns` writes one entry per run in the form `id (agent, code-or-outcome): detail`. The detail comes from `outcomeDetail`, sanitized by `sanitizeCallTargetText` and capped at 600 characters with an ellipsis (`OUTCOME_DETAIL_MAX_CHARS`). The focused test `tests/contracts/headless-dispatched-runs.test.ts` asserts this format. For a run with `outcomeCode: "merge_withheld"`, it matches `withheld (coder, merge_withheld)`, the preserved branch line, and a `clio-coder fleet land` recovery command, and checks that a detail not produced by `mergeWithheldDetail` does not gain that command. A second case, with `attempt` set to 1 on a retry whose `parentRunId` is the failed run, shows the failed attempt being excluded from `undelivered` while an unretried failure and a `running` run appear in the result.

## Enforced boundaries and failure conditions

- Output frames: `writeFrame` is documented as the single write point for `run --json` frames, so every frame type must be declared in `RunJsonFrame`. A frame whose write fails is reported to stderr as `clio-coder run: json frame write failed` and does not stop the stream.
- Session header ordering: in `--json` mode, frames queued before the session header exists are held in `pendingJsonFrames` until `writeJsonHeader` writes the header. A header with no session id is written as `pending: true` with `id: null`.
- Shutdown precedence: once `termination.isShuttingDown()` is true, the terminal outcome is taken from `interruptedTerminal`, not from the turn's own result.
- No-op failure: `failOnNoop` changes the failure message only through `noopFailureMessage`. The `runStats` fields `mutatingSucceeded`, `blockedAttempts`, `unresolvedBlocks`, and `changeAsked` feed the decision (`changeAsked` is false only for `constraints.mode` `answer` or `proposal`, which never seals a no-op), and the blocked-attempt list is capped at `BLOCKED_ATTEMPTS_LIMIT` (50) with each reason clipped at 500 characters, with overflow counted in `blockedAttemptsTruncated`.

The page does not establish the full logic of `headlessNoop`, `noopFailureMessage`, the remaining terminal branches after line 1109 of `src/cli/modes/print.ts`, or the `SESSION_COST_CEILING_*` constants. Those are read only at the call sites shown above.

## Extension seams

- A new frame type is added to `src/cli/modes/run-json-schema.ts` and produced from `projectHeadlessJsonEvent` or a branch in `runHeadlessMainAgent`. Per the schema comment, an optional field or a new frame type does not bump the version.
- A new terminal outcome is added to `HeadlessTerminalOutcome` handling in `src/cli/modes/print.ts`. Any new value in `UNDELIVERED_OUTCOMES` changes which dispatched runs `settleDispatchedRuns` reports.
- Options reach the function through `HeadlessMainAgentOptions`. Callers that must pass a new option wire it through `src/cli/run.ts` or `src/entry/orchestrator.ts`.

## Focused test relationships

The one focused test found in `tests/` for this area is `tests/contracts/headless-dispatched-runs.test.ts`. Its cases are described in the settlement section above. A repository-wide search by module and symbol name (`headless-dispatched-runs`, `settleDispatchedRuns`, `projectHeadlessJsonEvent`, `runHeadlessMainAgent`) also returned other consumers, including `tests/contracts/headless-failure-framing.test.ts`, `tests/contracts/metering-integrity.test.ts`, `tests/contracts/gateway-capability-naming.test.ts`, `tests/extended/headless-artifact.test.ts`, and `tests/extended/dogfood-headless-denial.test.ts`. Those files were not opened for this page, so their assertions are not described here.

## Things to watch when editing

- Keep the frame schema and its version in step. Removing or retyping a field requires a `RUN_JSON_SCHEMA_VERSION` bump, per the comment at the top of `src/cli/modes/run-json-schema.ts`.
- `projectHeadlessJsonEvent` must keep assistant content from crossing the stream twice. The projection relies on `message_end` blocks carrying `streamed: true` in place of text that the deltas already sent.
- `recordRun` must remain idempotent. The `sealed` promise is the guard that makes the drain hook and the completion path safe to race.
- `settleDispatchedRuns` takes `isShuttingDown` as a callback, so a change to the termination coordinator changes how long a run waits for children.
- `describeRuns` output is consumed by stderr readers and by the JSON settlement frame. The sanitizer and length cap are applied in `boundedOutcomeDetail`; a new path that writes `outcomeDetail` without it would bypass them.
