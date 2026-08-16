# Worker visibility: one attributed stream for human, agent, and ACP runs

Status: approved design, implementation pending. Owner decisions captured
2026-08-16 (see "Decisions").

## Problem

Today a worker's answer reaches nobody in the TUI unless the main agent
chooses to repeat it.

- `/run <agent> <task>` (`src/interactive/slash-commands.ts:136` `handleRun`)
  dispatches with `requestOrigin: "user"`, forwards every non-heartbeat worker
  event onto `BusChannels.DispatchProgress`, awaits the receipt, and on
  success does nothing. Only failure produces a notice. The subscriber in
  `src/interactive/interactive-subscriptions.ts:36` refreshes the footer and
  the task island. The dispatch board (`src/interactive/dispatch-board.ts`)
  renders telemetry, current tool, and an outcome `detail`, never the answer.
  `/run` also bypasses the model, so the main agent receives nothing either.
  `/run coder "say hello"` produces a footer flicker, a board row, and a
  receipt on disk. The hello is reachable only through `/view
  dispatch:<runId>` or `clio-coder trace`.
- `/delegate <acp-agent> <task>` (`handleDelegate`, same file) has the same
  shape.
- Agent-driven dispatch (`src/tools/dispatch.ts:822`) hands
  `receipt.output.text` back to the model as the tool result. The human sees
  a collapsed tool segment and whatever the model summarizes.
- The origin distinction already exists as data (`DispatchRequestOrigin =
  "user" | "agent" | "internal"`, `src/domains/dispatch/types.ts:277`), is
  carried into board rows (`dispatch-board.ts:962`), and is never rendered or
  acted on.

## Decisions (owner, 2026-08-16)

1. Human-origin runs (`/run`, `/delegate`) render in the transcript as a
   streamed, attributed worker block. The answer does not enter the main
   agent's model context unless the operator opts in (`--share` on the
   command, or `/share <runId>` afterwards).
2. Agent-origin runs (model called `dispatch`, `dispatch_scout`, review
   gates, compete candidates) render as a compact worker card with the answer
   folded, expandable, using a distinct glyph from human-origin runs.
3. Internal-origin runs (wiki documenter, bootstrap scout, speculation
   observer, judges) stay off the transcript. Board only.
4. Clio workers, claude-sdk/claude-code subprocess workers, and ACP delegation
   peers (codex, opencode, copilot, and anything under `delegation.agents`)
   share one entry shape. The header names the runtime so the operator can
   tell them apart; the body and lifecycle are identical.

## Target rendering

Human origin, live:

```
◇ you → coder · mini/Nemo-3.5-Lightning · run 2mkas6s
│ Hello! I'm the coder worker.
│ …streams as text_delta arrives…
│ ⚙ read src/math.ts · ⚙ artifact PLAN.md          (tools: names only, one line, coalesced)
└ ok · 4.8k tok · 9.6s · contract pass
```

Human origin, ACP peer:

```
◇ you → codex (acp) · run 7hq2ab
│ …
└ ok · 41s · 3 mediated tool calls
```

Agent origin, folded (default), rendered directly under the tool segment that
spawned it, one card per run, fan-out gives N cards:

```
◆ agent → scout · zbook/gemma-4-26b · run 3nc18jo   ✓ 41s  [Ctrl+O expand]
◆ agent → scout · mini/Nemo-3.5    · run 8k1zzq0   ✗ result_contract_exhausted  [expand]
```

Expanded agent card shows the same body as a human block: full final text
(bounded), coalesced tool line, receipt footer.

Failover and retries: the entry is keyed by assignment id, not attempt run
id. A failover appends one rail line `↻ failed over → attempt 2 on
dynamo/qwen3` and keeps streaming into the same entry. The footer reports the
terminal attempt's receipt and the attempt count.

Failure: `└ ✗ exit=1 · <failureMessage first line>` and, for user origin,
the existing error notice stays.

Glyphs: `◇` human origin, `◆` agent origin. Board rows and the footer worker
count use the same two glyphs, so a running `◇` in the board is the
operator's own run.

## Architecture

### Sources of truth (do not add new ones)

- Live events: `BusChannels.DispatchProgress` already carries every worker
  event (`text_delta`, `message_end`, `tool_execution_start/end`,
  `clio_*`) with `runId` and `agentId`. `DispatchEnqueued/Started/
  Completed/Failed` and `RunAborted` bracket lifecycle.
- Terminal truth: the sealed receipt (`RunReceipt`), which the dispatch
  contract returns from `handle.finalPromise` and which is durable under
  `<state>/receipts/<runId>.json`. `output.text`, `tokenCount`, `outcome`,
  `outcomeCode`, `quality.resultContract.conformance`, `lineage.attempt`,
  `targetId`, `wireModelId`, `runtimeId`.
- ACP: `src/engine/acp/adapter.ts` / `event-mapper.ts` already emit
  `text_delta` and `message_end` AgentEvents through the same dispatch
  event stream, so ACP peers ride the same channel. No ACP-specific UI path.

### Bus payload enrichment (small, first)

`DispatchStarted` (and the board's lifecycle projection) must carry enough
to draw the header without waiting for the receipt: `runId`, `assignmentId`,
`agentId`, `requestOrigin`, `targetId`, `wireModelId`, `runtimeId`,
`runtimeKind` (`http|sdk|acp|subprocess`), `attempt`, and for agent origin
the parent `toolCallId` so the card can nest under the right tool segment.
Most of these exist on the lifecycle record in
`src/domains/dispatch/extension.ts` (`requestOrigin` at 1222/1249, route
decision at spawn). Extend the payload type in `src/core/bus-events.ts` and
keep `DispatchProgressPayload` unchanged.

### Chat panel: a new transcript entry

`src/interactive/chat-panel.ts` `TranscriptEntry` gains:

```ts
| {
    role: "worker";
    assignmentId: string;
    runId: string;               // current attempt
    origin: "user" | "agent";    // internal never reaches the panel
    agentId: string;
    runtime: { kind: "clio" | "acp" | "claude-sdk" | "claude-code"; targetId?: string; wireModelId?: string; peerId?: string };
    text: string;                // streamed, bounded (tail while live, full-bounded on completion)
    tools: string[];             // coalesced names, bounded
    attempts: Array<{ runId: string; targetLabel: string; outcome?: string }>;
    pending: boolean;
    folded: boolean;             // default: origin === "agent"
    receipt?: { outcome; outcomeCode?; tokens; elapsedMs; contract?: "pass"|"fail"|"not-reached"|"unmeasured"; exitCode?; failureMessage? };
    parentToolCallId?: string;   // agent origin: nest under this tool segment
  }
```

Placement: user-origin entries append at the point of `/run` in the
transcript (after the operator's slash line). Agent-origin entries render
inside/under the assistant segment whose tool call spawned them
(`parentToolCallId`); when the parent cannot be found (detached collect in a
later turn) fall back to appending after the current assistant entry.

Feed: a `worker-stream` reducer module (`src/interactive/worker-stream.ts`,
pure, tested) consumes `DispatchStarted/Progress/Completed/Failed/
RunAborted` payloads and produces entry mutations. Chat panel wires it in
`interactive-subscriptions.ts` alongside the existing subscriptions.
Bounds: keep the last 40 lines while live; on completion keep up to
`perRunOutputBytes` equivalent (reuse the dispatch tool's constant) and fold
the rest with a `… N more lines, /view dispatch:<runId>` tail. Never keep
raw tool arguments (they must not cross the stdout seam; names only, same
rule as the board).

Fold toggle: reuse the existing tool-segment expand key (whatever
`chat-panel` binds today; check `keybinding-manager.ts` before adding a
binding). Ctrl+O toggles the most recent worker entry; when the cursor
selection model exists, the selected one.

### Slash commands

`handleRun`/`handleDelegate`: keep the dispatch call. Add `--share` flag
(`/run --share coder …`, `/delegate --share codex …`). On receipt with
`share`, or on `/share <runId|assignmentId>` later, append an operator note
into the session through the same path operator text enters the model
context (the chat loop's user-turn path, not a system message), shaped:

```
[worker result] coder · run 2mkas6s · ok
<bounded output.text>
```

It is persisted as a normal session entry so replay and compaction treat it
as operator-provided text. Sharing never happens implicitly. `/share`
without a run id shares the most recent completed user-origin run.

Success path of `handleRun` stays silent in the notice bar; the transcript
entry is the success signal. Failure keeps the notice.

### Dispatch board and footer

- Origin glyph on every row (`◇`/`◆`, internal `·`).
- Footer worker chip: `◇1 ◆3` when both kinds are running; unchanged shape
  otherwise.

### Persistence and replay

Add a session entry `{ type: "worker-run", assignmentId, runId, origin,
agentId, runtime, startedAt, parentToolCallId? }` written at
`DispatchStarted` for user/agent origins. On replay, reconstruct the worker
entry from the entry plus the durable receipt (`receipts/<runId>.json`,
`output.text`) so a resumed session shows the same block. Missing receipt
renders `└ receipt unavailable`. Compaction treats these entries like
notices (droppable, never summarized as model context). Do not persist
streamed text.

### Non-goals

- No change to dispatch admission, routing, receipts, or the worker
  protocol.
- Agent-origin output never enters the model context through this feature
  (it already does through the tool result).
- No new bus channels. No new state files beyond the session entry.
- Internal-origin runs stay invisible in the transcript.

## Delivery order (each step ships green: typecheck, biome, `npm test`)

1. Bus payload enrichment for `DispatchStarted` (+ contract test).
2. `worker-stream.ts` reducer + tests (event sequences → entry states,
   including failover, abort, ACP `message_end` without deltas, bounded
   text, tool-name coalescing, no-arguments guarantee).
3. Chat panel `worker` entry rendering + golden tests for the four shapes
   above (human live, human ACP, agent folded, agent expanded, failure).
4. Wire subscriptions; `/run` and `/delegate` stream; receipt footer.
5. Agent-origin cards nested under the spawning tool segment; fold/expand
   key.
6. `--share` and `/share`, session persistence of the shared note; test that
   nothing enters model context without it.
7. Board and footer glyphs.
8. `worker-run` session entry + replay reconstruction from receipts + test.
9. Docs: `docs/commands-and-modes.md` (`/run`, `/delegate`, `/share`),
   `docs/fleet-dispatch.md` "Operator visibility", `docs/acp.md` note that
   delegation peers render as workers.
10. Live check on the fleet: `/run coder "say hello"` shows the hello;
    `/run --share coder …` followed by a question the main agent can answer
    only from the shared note; `/delegate` against a configured ACP peer if
    one is configured (otherwise document the manual step).

## Acceptance

- `/run coder "say hello"` shows `◇ you → coder …` with "hello" in the
  transcript within the same turn, and the main agent's next reply proves it
  never saw it unless `--share` was given.
- An agent-driven fan-out of 3 scouts shows 3 folded `◆` cards under the
  dispatch tool segment; expanding one shows the raw worker answer.
- A run that fails over shows one entry with an `↻` line, not two entries.
- Session resume redraws the worker blocks from the receipts.
- No worker tool arguments appear anywhere in the transcript.
