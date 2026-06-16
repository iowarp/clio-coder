# CODEX_PLAN

## Objective

Implement two explicit Claude Code subscription runtimes without changing the
existing Anthropic API-key runtime, Anthropic Max OAuth runtime, OpenAI Codex
runtime, or any default provider selection:

- `claude-code`: Path C, a worker runtime that drives the installed `claude`
  binary in `claude -p` print/streaming mode.
- `claude-sdk`: Path B, a worker runtime that uses
  `@anthropic-ai/claude-agent-sdk` and routes Claude tool permissions through
  Clio safety and autonomy.

Both runtimes must use the user's existing Claude Code login. Clio will not
store Claude Code credentials.

## Research Snapshot

### Live Claude CLI

`claude --help` confirms these relevant flags are available:

- `-p, --print`
- `--output-format <format>` with `text`, `json`, and `stream-json`
- `--input-format <format>` with `text` and `stream-json`
- `--include-partial-messages`
- `--permission-mode <mode>` with `acceptEdits`, `auto`,
  `bypassPermissions`, `default`, `dontAsk`, and `plan`
- `--append-system-prompt <prompt>`
- `--resume [value]`
- `--session-id <uuid>`
- `--model <model>`
- `--allowedTools` / `--allowed-tools`
- `--disallowedTools` / `--disallowed-tools`
- `--tools`
- `--no-session-persistence`
- `--max-budget-usd`
- `--allow-dangerously-skip-permissions`
- `--dangerously-skip-permissions`

The current help output does not advertise a `--permission-prompt-tool` flag.
That means the subprocess path cannot reliably receive every internal Claude
Code tool request as a Clio callback. Path C will therefore enforce Clio's
external-runtime posture through the Claude CLI permission mode and the
dangerous-bypass environment gate, and the final report will state this
limitation.

### Live Claude Agent SDK Package

`npm view @anthropic-ai/claude-agent-sdk` confirms the published current version
is `0.3.178`. The package exports `sdk.mjs` and `sdk.d.ts`, with peer
dependencies on `zod`, `@anthropic-ai/sdk`, and `@modelcontextprotocol/sdk`.

The SDK contract relevant to this work:

- `query({ prompt, options })` returns an async `Query`.
- `prompt` may be a string or an `AsyncIterable<SDKUserMessage>`.
- `Options` includes `canUseTool`, `abortController`, `cwd`, `model`,
  `pathToClaudeCodeExecutable`, `permissionMode`, `includePartialMessages`,
  `thinking`, `systemPrompt`, `tools`, `allowedTools`, `disallowedTools`,
  `stderr`, `resume`, `sessionId`, and `persistSession`.
- `CanUseTool` receives `(toolName, input, options)` and returns a
  `PermissionResult`.
- `PermissionResult` can only be `allow` or `deny`; it has no native `ask`
  result. Clio `ask` outcomes in a worker must therefore be represented as the
  same non-interactive denial flow Clio workers already use for parked
  permission requests.
- SDK result messages include `total_cost_usd`, `usage`, `modelUsage`,
  `permission_denials`, and a result/error subtype.

### Current Runtime and Worker Constraints

The current provider contract is intentionally HTTP-only:

- `RuntimeKind` is only `"http"`.
- `RuntimeApiFamily` has no Claude Code subprocess or Agent SDK family.
- `RuntimeAuth` has no "Claude Code CLI login" value.
- Runtime package validation and WorkerSpec validation duplicate those closed
  allowlists.
- `isTargetEligibleRuntime()` accepts only HTTP.
- `resolveRuntimeTarget()` rejects non-HTTP runtimes before capability/model
  resolution.
- Dispatch `RunKind` and evidence parsing currently only know `"http"` and
  `"acp-delegation"`.
- `startWorkerRun()` always enters the pi-agent-core path and calls
  `runtime.synthesizeModel()`.

The provider cleanup contract test currently asserts that Claude Code SDK, CLI,
and subprocess runtimes remain absent. That test must be updated from "removed
forever" to "old removed paths/ids remain gone, new sanctioned runtimes are
present and constrained".

### Current Safety Contract

Clio safety has two layers:

- `SafetyContract.evaluate()` classifies a tool call into `allow`, `ask`, or
  `block`.
- The tool registry applies autonomy with `mapAutonomy()`:
  - `read-only` allows reads and denies non-reads.
  - `suggest` asks for non-read actions.
  - `auto-edit` allows writes and recognized executes, asks on unknown/system
    modifying actions.
  - `full-auto` additionally allows unrecognized executes but still asks on
    unknown/system-modifying actions.

The SDK bridge must use the same safety plus autonomy mapping, not the old
recovered bridge's direct `safety.evaluate()` call alone. Worker permission
requests are non-stalling today: depending on `workers.onPermission`, they are
converted into a denial or a fail-fast worker abort. The Claude SDK bridge will
mirror that behavior for SDK `canUseTool`.

## Implementation Plan

### 1. Runtime descriptors and contracts

- Add `RuntimeKind` values for external Claude Code execution:
  - `"sdk"` for `claude-sdk`
  - `"subprocess"` for `claude-code`
- Add `RuntimeApiFamily` values:
  - `"claude-agent-sdk"`
  - `"claude-code-subprocess"`
- Add `RuntimeAuth` value:
  - `"claude-cli"`
- Add built-in runtime descriptors:
  - `src/domains/providers/runtimes/claude/claude-sdk.ts`
  - `src/domains/providers/runtimes/claude/claude-code.ts`
- Register both in `BUILTIN_RUNTIMES`.
- Keep both non-default and explicit: no default orchestrator, no automatic
  target migration, and no change to `anthropic`, `anthropic-max`, or
  `openai-codex`.
- Treat `"claude-cli"` as no stored Clio credential. Auth status should explain
  that users authenticate through `claude`, not through `clio auth login`.
- Update support/configuration grouping so these are visible as subscription
  runtimes rather than local HTTP runtimes.

### 2. Eligibility and target use

- Keep HTTP runtimes eligible for existing orchestrator, print, and dispatch
  paths.
- Allow `sdk` and `subprocess` descriptors as dispatch worker targets.
- Avoid silently sending interactive/chat pi-agent flows into external Claude
  runtimes unless that flow is explicitly implemented. If a non-HTTP Claude
  runtime is selected for an unsupported use, resolution should return a clear
  unsupported-use diagnostic instead of trying to synthesize a pi-agent model.
- Mark both new runtime kinds as streaming-capable for worker dispatch:
  - `claude-sdk` streams through the SDK async query.
  - `claude-code` streams through `--output-format stream-json`.

### 3. Worker spec and dispatch contracts

- Update WorkerSpec serialized runtime validation to admit the new kind,
  API-family, and auth values.
- Bump `WORKER_RUNTIME_DESCRIPTOR_VERSION` because the runtime descriptor shape
  accepted across the worker boundary is changing.
- Update dispatch `RunKind` and evidence parsing so receipts can contain the new
  runtime kinds.
- Keep existing worker-spawn transport: first stdin line is WorkerSpec, later
  stdin lines are steering messages.

### 4. Worker execution split

- Add a runtime dispatch branch at the top of `startWorkerRun()`:
  - `input.runtime.id === "claude-sdk"` enters the SDK runner.
  - `input.runtime.id === "claude-code"` enters the subprocess runner.
  - everything else keeps the existing pi-agent-core path unchanged.
- Preserve `WorkerRunHandle` semantics for all runners:
  - `promise`
  - `abort()`
  - `steer(text)`
- Preserve existing Clio worker events where possible:
  - `agent_start`
  - streamed/terminal assistant message events
  - `message_end`
  - `agent_end`
  - `clio_steer_received`
  - `clio_tool_finish`
  - `clio_permission_resolved`

### 5. Path B: Claude Agent SDK runtime

- Add dependency `@anthropic-ai/claude-agent-sdk@0.3.178`.
- Implement a new SDK runner under a new path, not one of the removed paths,
  for example `src/engine/claude/sdk-runtime.ts`.
- Use `query({ prompt: AsyncIterable<SDKUserMessage>, options })`.
- Feed the initial worker task plus later `steer()` messages through the async
  prompt iterable.
- Wire cancellation through an `AbortController`, `query.interrupt()`, and
  `query.close()` where available.
- Set `cwd` to the worker cwd and `model` to the resolved wire model id.
- Use Claude Code auth implicitly through the installed Claude Code environment;
  do not pass or store API keys.
- Normalize SDK assistant/result messages into Clio worker events, including
  usage and `total_cost_usd` when present.
- Implement `canUseTool` with a shared Claude tool safety bridge:
  - map Claude tool names such as `Bash`, `Read`, `Edit`, `MultiEdit`, `Write`,
    `Grep`, `Glob`, `LS`, `WebFetch`, `WebSearch`, and `Task` to Clio tool
    names and action arguments;
  - call `SafetyContract.evaluate()`;
  - apply `mapAutonomy()` with the worker `autonomy`;
  - return SDK `allow` only for Clio-allowed calls;
  - return SDK `deny` for Clio `block`, autonomy `deny`, or non-interactive
    Clio `ask`;
  - emit Clio tool/permission telemetry so dispatch safety summaries remain
    meaningful.

### 6. Path C: Claude subprocess runtime

- Implement a new subprocess runner under a new path, for example
  `src/engine/claude/subprocess-runtime.ts`.
- Spawn `claude` with:
  - `--print`
  - `--output-format stream-json`
  - `--include-partial-messages`
  - `--model <wireModelId>` when available
  - `--append-system-prompt <system prompt>` when available
  - `--permission-mode <mapped mode>`
- Parse stdout line-delimited JSON and normalize assistant text, result status,
  usage, and cost into Clio worker events.
- Route abort to process termination.
- Report steering as received, but do not claim full live follow-up support for
  Path C unless `--input-format stream-json` can be safely wired during the
  implementation.
- Map safety posture conservatively through Claude CLI permission modes:
  - `read-only` -> `plan` plus read-only available tools where practical.
  - `suggest` and `auto-edit` -> non-bypass modes.
  - dangerous bypass posture is available only when worker autonomy is
    `full-auto` and `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1`.
- Never pass `--dangerously-skip-permissions` or bypass-equivalent settings
  outside that explicit gate.

### 7. Tests

Update and add contract tests under the existing CI suite:

- `tests/contracts/providers.test.ts`
  - assert `claude-sdk` and `claude-code` are present with the new sanctioned
    ids, kinds, API families, auth, and non-default status;
  - keep asserting old removed ids and old removed file paths stay absent;
  - update runtime cleanup expectations from all-builtins-are-HTTP to
    HTTP-plus-sanctioned-external-runtimes;
  - assert worker spec validation accepts the new descriptor shapes and still
    rejects unknown kinds/families/auth values.
- Add or extend contract tests for the Claude safety bridge:
  - read-only allows read tools and denies writes/executes;
  - auto-edit allows writes and recognized executes;
  - auto-edit asks/denies unrecognized executes and system-modifying actions in
    the non-interactive SDK permission path;
  - full-auto allows unrecognized executes but still does not bypass
    system-modifying actions.
- Add a permission-gate matrix analogous to the historical external-runtime
  tests:
  - no Claude runtime may use dangerous/bypass posture by default;
  - full-access subprocess bypass flags only appear for `full-auto` plus
    `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1`;
  - SDK tool access remains mediated by `canUseTool`.
- Add parser/runner tests with mocked SDK/child-process surfaces rather than
  requiring a real Claude account in CI.

### 8. Documentation and report

- Update user-facing docs where provider/runtime lists currently forbid Claude
  Code support.
- Explain that these runtimes use the user's Claude Code login and do not store
  credentials in Clio.
- Explain the difference between:
  - `anthropic`: API-key Anthropic runtime;
  - `anthropic-max`: OAuth/subscription Anthropic Messages runtime;
  - `claude-sdk`: Claude Agent SDK delegated worker runtime;
  - `claude-code`: Claude CLI subprocess worker runtime.
- Finish with `CODEX_REPORT.md` documenting:
  - implemented files and behavior;
  - safety behavior and limitations;
  - live tool facts used;
  - tests run;
  - known follow-ups.

## Verification Plan

Before implementation commit:

- Commit this plan by itself after CI confirms the starting tree remains green.

During implementation:

- Run focused contract tests for providers, worker spec, dispatch/worker
  steering, and Claude runtime bridge logic as they are added or changed.

Before final response:

- Run `npm run ci`.
- Inspect `git status --short` to confirm only intended tracked changes are
  staged/committed and user-provided untracked artifacts remain untouched.
- Write `CODEX_REPORT.md`.
- Do not push, tag, publish, or force-add ignored artifacts.
