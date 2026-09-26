---
title: "Engine"
summary: "The worker-subprocess engine boundary: the unified loop guard, the pi-agent worker runtime with its Claude SDK and external-CLI branches, per-provider request payload patches, the Claude tool-safety mediator, and the session JSONL ledger."
sources:
  - "src/engine/loop-guard.ts"
  - "src/engine/worker-runtime.ts"
  - "src/engine/claude/sdk-runtime.ts"
  - "src/engine/claude/tool-safety.ts"
  - "src/engine/antigravity/subprocess-runtime.ts"
  - "src/engine/codex/subprocess-runtime.ts"
  - "src/engine/provider-payload.ts"
  - "src/engine/session.ts"
symbols:
  - "createLoopGuardRegistration"
  - "startWorkerRun"
  - "startClaudeSdkWorkerRun"
  - "createClaudeWorkerBudgetGate"
  - "emitClaudeToolPermissionDecision"
  - "startAntigravityWorkerRun"
  - "patchWorkerRequestPayload"
tests:
  - "tests/contracts/read-only-research-synthesis-budget.test.ts"
  - "tests/contracts/worker-boundary.test.ts"
  - "tests/contracts/read-scope.test.ts"
  - "tests/contracts/antigravity-subprocess.test.ts"
  - "tests/extended/synthesis-lock.test.ts"
invariants:
  - "A worker run's tool calls are bounded by a hard lifetime cap in the loop guard, so a degenerate model cannot burn the run by spamming distinct calls past the ceiling."
  - "A synthesis-locked worker round ships no tool surface for non-Anthropic APIs, so a model that calls a tool anyway returns markup as text that is stripped to a fallback notice."
  - "Every Claude SDK tool call is mapped to a Clio builtin and denied before the safety net runs if that builtin is outside the worker's admitted surface."
  - "A Claude SDK run collapses the escalate permission posture to the non-stall deny fallback because the SDK path has no registry park loop."
validate:
  - "node --import tsx --test tests/contracts/read-only-research-synthesis-budget.test.ts tests/contracts/worker-boundary.test.ts"
---

# Engine

`src/engine/` is the worker-subprocess engine boundary. It owns the runtime that executes one
dispatched worker run: it builds the pi-agent-core `Agent` for a worker, installs the unified loop
guard as a `before_tool` middleware hook, composes the admitted tool surface, and forwards every
`AgentEvent` to the worker entry, which serializes events to NDJSON stdout. The same module family
also hosts the engine's artifact contract with the session domain (`session.ts`) and the per-provider
request payload patches used to force text-only rounds, require one named tool, or attach a JSON-schema
response constraint.

The boundary is deliberately thin. `src/engine/types.ts` re-exports the engine-boundary types
(`EngineModel`, `AgentMessage`, `AgentEvent`, `Usage`) so that domains never import pi-mono packages
directly; the comment in `types.ts` states that importing engine package types from anywhere else
violates the engine boundary.

## The loop guard: `src/engine/loop-guard.ts`

`createLoopGuardRegistration(options)` returns a middleware hook registration that carries the
loop-detector state for one run. It is registered on both the worker registry (`worker-runtime.ts`)
and the orchestrator registry (`src/entry/orchestrator.ts`), so admission and repetition detection share
one seam in both processes.

The guard's `before_tool` branch (`evaluate`) applies, in order:

1. **Turn loop-block budget.** `INTERACTIVE_LOOP_BLOCK_BUDGET = 2` for the orchestrator; the worker
   derives its own budget from `workerLoopBlockBudget(toolCalls)`. Once the budget is exhausted the guard
   emits a `lock_tools` effect for the rest of the turn and fires `onSynthesisLockout`.
2. **Repeat-call detector.** A turn-scoped key combines `turnKey`, a mutation epoch, and the call
   fingerprint (`callFingerprint` metadata). A repeated identical call inside the window is blocked as a
   loop. `loopBlockBaseReason` reports the count and prior successes.
3. **Result stagnation.** `RESULT_STAGNATION_THRESHOLD = 3`: when the incoming call has the same shape
   (size args ignored) as a streak of calls whose results hashed identical, the attempt is blocked.
4. **Worker budget phase.** `workerToolCallBudget` enforces the soft limit (`toolCallSoftLimit`), the
   hard lifetime cap (`toolCallCap`), and the read reserve. The `onSynthesisLockout` callback flips the
   runtime's `synthesisToolLock` so the next model round is forced text-only.

The guard exposes `extendWorkerToolCallPhase(budget)` for the result-contract revision window: it reopens
the budget only when the run has not already hit the hard cap or the repeated-call lock. The
`resolveDeliveryTools` helper returns `write`/`edit` (plus `code_nav` for the `orientation` product) as
the tools that stay admitted in the reserve window, because an agent whose product is files must still be
able to write them in its last calls; `isReserveAdmittedTool` returns true for `read` or a delivery tool.

`sanitizeLockedSynthesisMessage`, `stripDeadToolCallMarkup`, `isLockedSynthesisFallbackOnly`,
`lockedSynthesisSystemPrompt`, and `lockedSynthesisRepromptMessages` implement the synthesis-locked
message lifecycle: they strip tool-call markup from a locked reply, detect a markup-only fallback, and
compose the one-shot re-prompt that asks for the required terminal result format.

## The worker runtime: `src/engine/worker-runtime.ts`

`startWorkerRun(input, emit)` is the single entry point. It takes a `WorkerRunInput` (a `TargetDescriptor`
+ `RuntimeDescriptor` + wire model id, not a provider/model pair) and returns a `WorkerRunHandle` with a
promise, an `abort()`, an optional `steer()`, and an optional `resolvePermission()`.

The runtime branches before any model call:

- **Claude SDK** — when `input.runtime.id === "claude-sdk"`, it delegates to
  `startClaudeSdkWorkerRun` in `src/engine/claude/sdk-runtime.ts`.
- **External CLI** — when `input.runtime.kind === "subprocess"`, it delegates to
  `startExternalCliWorkerRun` in `src/engine/external-cli/connectors.ts`, which dispatches by runtime id to
  the managed connectors (`claude-code`, `codex-cli`, `opencode-cli`, `pi-cli`, `antigravity-code`).
- **Native pi-agent** — otherwise it builds the pi-agent-core `Agent` directly. It first registers the Clio
  API providers (the worker is a fresh process), reads the workspace's trusted settings layers to project
  output limits and guardrail policy, synthesizes the `EngineModel`, constructs the safety contract via
  `createWorkerSafety`, registers the loop guard on the tool registry, and subscribes an event sink that
  forwards every `AgentEvent` to `emit`.

The native path composes the admitted surface from `input.allowedTools`, applies the skill policy, and
builds the tool set with `resolveAgentTools`. It wires the synthesis lock through `onPayload` so that a
locked round calls `patchWorkerRequestPayload` with `toolSurfaceLocked: true`. Result-contract repair is
bounded by `RESULT_CONTRACT_REPAIR_LIMIT`, and observed read spans (`observedReadRanges`, `observedGrepLines`)
are recorded from the tool telemetry to ground the terminal result.

The worker's permission posture is non-stall by design: `onPermission` defaults to `"deny"`, `"fail"`
aborts the run, and `"escalate"` parks the call and hands the decision to the operator over the
event/stdin channels with a bounded timeout. `workerPermissionCacheKey` produces a byte-stable key from the
exact call and permission conditions so an identical re-issued call gets the same remembered answer
without a new escalation card.

## Provider payload patches: `src/engine/provider-payload.ts`

`patchWorkerRequestPayload(payload, model, options)` composes all worker-owned request mutations over one
payload in a stable order. The individual patches are dialect-aware:

- **`patchToolSurfaceLockedPayload`** removes the tool surface entirely for a synthesis-locked round. This
  is the hard variant used for a worker's locked rounds (the loop-guard lockout and the terminal
  result-contract repair), because `tool_choice: "none"` alone is not enough on llama.cpp: the chat template
  still renders the tool schema, so a local model that calls a tool anyway hands its markup back as
  content. Anthropic keeps the `tool_choice` knob instead, because its API rejects a history carrying
  `tool_use` blocks unless tools are defined.
- **`patchToolChoiceNonePayload`** is the softer variant for a middleware lock or the interactive synthesis
  lockout: it sets `tool_choice: { type: "none" }` on Anthropic and `tool_choice: "none"` elsewhere, leaving
  the schema surface byte-stable.
- **`patchToolChoiceNamedPayload`** requires one named tool for the next round, preserving the full schema
  surface on Anthropic (it disables adaptive thinking for that request only) and narrowing to the single
  definition on the others.
- **`patchTerminalToolPayload`** exposes one handoff tool, never the work surface, for a terminal protocol
  round.
- **`patchProviderThinkingPayload`** sets the OpenAI Responses reasoning summary to `"concise"` or
  `"detailed"` based on the effective thinking level; Anthropic thinking is pi-owned and left untouched.
- **`patchResponseSchemaPayloadForDialect`** attaches the admitted runtime's JSON-schema constraint in the
  dialect the runtime takes (`llamacpp-json-object` or a strict `json_schema` response format).

`supportsNamedToolChoice(api)` lists the APIs whose named-tool request dialect is implemented. The
`WorkerPayloadPatchOptions` interface carries `runtimeId`, `thinkingLevel`, `responseSchema`,
`toolChoiceNone`, `toolChoiceName`, `toolSurfaceLocked`, and `terminalToolName`.

## Claude SDK tool safety: `src/engine/claude/tool-safety.ts`

The Claude SDK path has no registry park loop and cannot mediate per-tool calls through the native safety
net, so it maps Claude preset tool names to Clio builtins and evaluates each call itself.
`emitClaudeToolPermissionDecision(input)` is the mediation seam, called from both the SDK's `canUseTool`
callback and the `PreToolUse` hook so that one logical decision is shared across the pair
(`decideClaudeSdkToolUseOnce`).

`CLAUDE_TOOL_TO_CLIO` is the single source of truth mapping Claude preset names to Clio builtins:
`Bash`→`bash`, `Read`/`NotebookRead`→`read`, `Edit`/`MultiEdit`→`edit`, `Write`→`write`,
`Grep`→`grep`, `Glob`→`find`, `LS`/`Ls`→`ls`, `WebFetch`/`WebSearch`→`web_fetch`, `Task`→`dispatch`,
`TodoWrite`→`tasks`. `mapClaudeToolCall` performs the forward mapping per call, translating argument shapes
(`pathArgs`, `searchArgs`, `commandArgs`) into the Clio builtin's expected keys. `claudeToolsOutsideProfile`
reverses the map to produce the SDK's `disallowedTools` list — the Claude preset tools whose Clio builtin is
not in the worker's allowed surface.

`evaluateClaudeToolPermission` applies the gates in order: (1) the budget gate's `attempt()`, (2) the
admitted-surface gate — an out-of-profile mapped tool is denied before the safety net runs, (3) the safety
net's `evaluate`, (4) the read-only dispatch restriction, and (5) the autonomy mapping via `mapAutonomy` at
`DEFAULT_AUTONYM_LEVEL`, with the budget gate's `admit()` running on the allow path. `emitClaudeToolPermissionDecision`
wraps the decision with telemetry: it emits `clio_coder_tool_start` and `clio_coder_tool_finish` (the same
event shapes the native registry uses) and, on a permission-required decision, emits a
`clio_coder_permission_resolved` event reflecting the run's `onPermission` posture.

## Claude SDK runtime: `src/engine/claude/sdk-runtime.ts`

`startClaudeSdkWorkerRun(input, emit)` runs the worker through the `@anthropic-ai/claude-agent-sdk`
optional dependency, loaded lazily from `./sdk-module.ts` at run time. It collapses the escalate posture to
the non-stall `deny` fallback because the SDK path has neither the registry park loop nor an operator on
the worker's stdin. The permission gate is built from `createWorkerSafety`, the admitted tool set, and a
`ClaudeWorkerBudgetGate` created by `createClaudeWorkerBudgetGate(budget, onBoundary, onHardCap, deliveryTools)`.

`createClaudeWorkerBudgetGate` is the canonical call counter shared by the SDK's `PreToolUse`/`canUseTool`
mediation seam. Its `attempt()` counts one logical SDK tool attempt and applies the hard-cap check; its
`admit()` rechecks phase policy at the execution boundary and increments the admitted count, locking the
run at the soft budget when the agent has no delivery tools. `phaseReached()` reports the locked state,
which the `PostToolBatch` hook reads to end the tool phase. `permissionResultForDecision` converts a
`ClaudeToolPermissionDecision` into the SDK's `PermissionResult`, honoring the `fail` posture by setting
`interrupt: true`.

The run forwards SDK messages to `emit`: `stream_event` messages become `message_update` text deltas via
`emitTextDelta`, `assistant` messages update the running text and model, and the `result` message
determines the final `stopReason`. Usage is normalized from the SDK's cost fields by `normalizeUsage`.

## Claude Code CLI subprocess: `src/engine/claude/subprocess-runtime.ts`

`startClaudeCodeWorkerRun(input, emit)` spawns the `claude` CLI (`CLAUDE_BINARY = "claude"`) as a
one-shot subprocess. `buildClaudeCodeArgs` sets the permission mode: read-only dispatches run in
`--permission-mode plan` with the read-only tool allowlist `READ_ONLY_CLAUDE_TOOLS = ["Read", "Grep",
"Glob", "LS", "WebFetch", "WebSearch"]`; otherwise they run in `--permission-mode acceptEdits`. The prompt is
fed on stdin (`-p` reads it from stdin when no positional prompt is given), so the prompt never appears in
argv; the system prompt rides on `--append-system-prompt`. `buildClaudeCodePrompt` joins the dynamic prompt
messages and the task. `readJsonLines` parses the `stream-json` output: `system` records set the model,
`result` records capture usage, and `assistant`/delta records feed `emitTextDelta`.

## Antigravity subprocess: `src/engine/antigravity/subprocess-runtime.ts`

`startAntigravityWorkerRun(input, emit, dependencies)` spawns the official `agy` CLI
(`ANTIGRAVITY_BINARY = "agy"`). `buildAgyArgs` enforces the tool profile via
`assertToolProfileEnforceable(input.toolProfile, "antigravity-code")` and selects the peer's permission mode
through `antigravitySubprocessConfig(readOnly)`: read-only dispatches pass `--mode plan --sandbox`
(external mode `plan+sandbox`), others pass `--mode accept-edits`. The run uses `--input-format stream-json
--output-format stream-json --disable-slash-commands`.

`buildAgyStdinLine` emits a single one-turn `stream-json` stdin record
(`{ event: "user", message: { content } }`), bounded by `ANTIGRAVITY_MAX_PROMPT_BYTES` (4 MiB). The
byte caps are explicit: `ANTIGRAVITY_MAX_STREAM_LINE_BYTES = 1 MiB`,
`ANTIGRAVITY_MAX_STREAM_BYTES = 8 MiB`, `ANTIGRAVITY_MAX_RESPONSE_BYTES = 4 MiB`,
`ANTIGRAVITY_MAX_CONVERSATION_ID_BYTES = 4 KiB`. `parseAntigravityStreamLine` parses the peer's
newline-delimited events into `init` / `step_update` (text delta) / `result` / `other`. `readStream` drives a
state machine that flags protocol violations (duplicate init, text before init, event after terminal
result) in `protocolDiagnostics`, and `resultDiagnostic` composes the terminal error from spawn error,
stream error, protocol diagnostics, and the peer's `status` field.

## Codex and the external-CLI registry: `src/engine/codex/`, `src/engine/external-cli/`

`src/engine/external-cli/connectors.ts` holds the registry of managed CLI connectors.
`startExternalCliWorkerRun(input, emit)` looks up the connector by `input.runtime.id` and delegates;
`externalCliConnector(runtimeId)` returns the matching connector or null. The connectors map to
`startClaudeCodeWorkerRun` (`claude-code`), `startCodexCliWorkerRun` (`codex-cli`), `startJsonlCliRun`
(`opencode-cli`, `pi-cli`), and `startAntigravityWorkerRun` (`antigravity-code`).

`src/engine/codex/subprocess-runtime.ts` spawns `codex exec -` (`CODEX_BINARY = "codex"`), which reads the
work order from stdin so prompt text never enters argv. `buildCodexExecArgs` selects the sandbox via
`codexSubprocessPermissionConfig(readOnly)` and passes `--json --ephemeral --skip-git-repo-check`. The run
parses the `codex exec` JSONL event stream into a state machine that tracks thread/turn start, terminal
`completed`/`failed`, and usage.

All subprocess runtimes share the helpers in `src/engine/external-subprocess.ts`: `readBoundedLines`
streams lines with a hard per-line and cumulative byte cap, `readStderr` tails the last 8 KiB of stderr,
and `createProcessTreeTerminator` kills the whole process tree on abort after a grace period.

## Session ledger: `src/engine/session.ts`

`session.ts` is the engine's artifact contract with the session domain. It is pure Node (fs, path, crypto)
and imports no pi-mono packages. `createSession` / `openSession` / `resumeSession` manage the on-disk layout
under `clioStateDir()`: `sessions/<cwdHash>/<sessionId>/` holds `meta.json`, `current.jsonl` (append-only
structured entries), and `tree.json` (turn tree nodes). `CURRENT_SESSION_FORMAT_VERSION = 5` stamps every new
session; readers reject earlier versions and future versions.

Append-only writes use an `O_APPEND` fd held for the writer's lifetime; `writeAll`/`appendAll` loop over
`writeSync` to guarantee complete byte writes, and `appendAll` rolls back a failed append with
`ftruncateSync` so a retry cannot fuse onto a partial record. fsync is debounced (`APPEND_FSYNC_DEBOUNCE_MS`)
after appends and forced on `persistTree` (checkpoint) and `close`. `writeJsonlFileAtomic` rewrites
`current.jsonl` through a `.tmp` + fsync + rename, and `recoverJsonlTargetIfMissing` promotes a leftover
`.tmp` when the target is absent. Torn final lines from a crash are tolerated by the reader (skipped with a
warning). `readSessionTailTurns` reads only the last `maxTurns` non-header entries by scanning backward from
EOF, with cost bounded by `maxTurns` rather than file size.

## Extension seams

- **Adding an external CLI runtime**: register a new `ExternalCliConnector` in the `CONNECTORS` array in
  `src/engine/external-cli/connectors.ts`, pointing at a `start...WorkerRun` function that follows the
  spawn/parse/emit pattern of the existing runtimes. The runtime id must match a runtime descriptor's `id`.
- **Adding a Claude preset tool to the safety map**: add the mapping to `CLAUDE_TOOL_TO_CLIO` in
  `src/engine/claude/tool-safety.ts` and the corresponding case to the `mapClaudeToolCall` switch, keeping
  the two in lockstep as the comment requires. `claudeToolsOutsideProfile` picks up the new entry
  automatically for the `disallowedTools` list.
- **Adding a provider payload dialect**: add the api string to `supportsNamedToolChoice` and a branch in the
  relevant patcher (`patchToolChoiceNamedPayload`, `patchToolChoiceNonePayload`) in
  `src/engine/provider-payload.ts`.
- **Adding a loop-guard budget knob**: the guard reads `toolCallCap`, `toolCallSoftLimit`,
  `toolCallReserve`, `toolCallSoftReadReserve`, `deliveryTools`, and `turnBlockBudget` from
  `CreateLoopGuardRegistrationOptions`; the worker computes these from `WorkerBudget` and passes them when
  registering the guard in `worker-runtime.ts`.

## Focused tests

- **`tests/contracts/read-only-research-synthesis-budget.test.ts`** — the loop-guard contract test. It builds
  a `createLoopGuardRegistration` with `toolCallSoftLimit: 36`, `toolCallCap: 150`, and
  `turnSynthesisLockout: true`, then asserts that 36 `Read` calls are all admitted, that the synthesis lock
  flips only on the 36th call, and that the 37th call is blocked. It also checks the budget envelope for a
  `coder` recipe stays advisory and the receipt integrity for native scout/provenance runs.
- **`tests/contracts/worker-boundary.test.ts`** — exercises `workerPermissionCacheKey` from
  `worker-runtime.ts`: the same key for reordered args (`command`/`cwd`), a different answer for a different
  axis, action class, or args; and the strict recipe/tool-envelope/capability/admission boundary.
- **`tests/contracts/read-scope.test.ts`** — the Claude tool-safety test. Its
  `"uses default permission mapping for Claude SDK and ACP peers and enforces read-only"` case calls
  `emitClaudeToolPermissionDecision` with `safety: createWorkerSafety({ cwd: root })` and asserts a `Read` of
  an inside path is `allow`, a `Read` of an outside path is `deny`, and search tools that reach outside the
  workspace are denied under the default permission mapping.
- **`tests/contracts/antigravity-subprocess.test.ts`** — exercises the Antigravity subprocess arg building,
  stdin line, stream parsing, and byte caps.
- **`tests/extended/synthesis-lock.test.ts`** — exercises the loop-guard synthesis lock and the payload
  patches. It asserts `patchWorkerRequestPayload` with `toolSurfaceLocked: true` removes `tools` and
  `tool_choice` for a `llamacpp` model but keeps `tools` and sets `tool_choice: { type: "none" }` for an
  `anthropic-messages` model, and that `sanitizeLockedSynthesisMessage` / `isLockedSynthesisFallbackOnly`
  detect a markup-only locked reply and `lockedSynthesisRepromptMessages` shapes one paired re-prompt.

## Things to watch when editing

- The loop guard and the worker share the synthesis-lock contract: the guard's `onSynthesisLockout` callback
  flips `worker-runtime.ts`'s `synthesisToolLock`, which `onPayload` reads to pass `toolSurfaceLocked: true`
  to `patchWorkerRequestPayload`. A change that locks the tools in one place but not the payload patch
  leaves the model able to call tools on a locked round.
- `patchToolSurfaceLockedPayload` and `patchToolChoiceNonePayload` are deliberately different: the former
  removes the tool surface (hard lock, for synthesis), the latter sets `tool_choice: "none"` (soft lock,
  for middleware). They must stay distinct; conflating them breaks the interactive synthesis lockout on
  llama.cpp.
- The Claude SDK permission path must keep `decideClaudeSdkToolUseOnce` as the single decision point, called
  from both `buildCanUseTool` and `buildPreToolUseHook`, or the SDK hook/callback pair can diverge on the
  same tool use.
- The subprocess runtimes enforce the tool profile via `assertToolProfileEnforceable(input.toolProfile,
  "antigravity-code" | "claude-code" | "codex-cli")` in their arg builders; a new runtime must call the
  matching assertion or a narrowing profile is silently ignored.
- The session ledger's `O_APPEND` writer and the `.tmp` recovery rely on the torn-tail tolerance in the
  reader; changing `writeJsonlFileAtomic` or `recoverJsonlTargetIfMissing` must preserve that the reader
  skips exactly one invalid final line with a warning.
- `session.ts` is pure Node and imports no pi-mono packages; keep it that way. It is the engine's artifact
  contract with the session domain.
- `CLAUDE_TOOL_TO_CLIO` and the `mapClaudeToolCall` switch must stay in lockstep; the former feeds the
  reverse `claudeToolsOutsideProfile` list and the latter feeds the forward mapping, so a tool added to one
  but not the other leaves a gap in either the mediation or the disallow list.
