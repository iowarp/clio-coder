---
title: "Claude worker runtimes: SDK and CLI subprocess"
summary: "How Clio runs a dispatched worker on Claude, either through the optional Claude Agent SDK or through the official claude CLI as a subprocess, and how each path mediates tool calls, budgets, usage, and permissions. Read this before changing Claude worker behavior."
sources:
  - "src/engine/claude/sdk-runtime.ts"
  - "src/engine/claude/tool-safety.ts"
  - "src/engine/claude/subprocess-runtime.ts"
  - "src/engine/claude/sdk-models.ts"
  - "src/engine/claude/sdk-module.ts"
  - "src/engine/claude/session-id.ts"
  - "src/engine/claude/clio-tool-bridge.ts"
symbols:
  - "startClaudeSdkWorkerRun"
  - "startClaudeCodeWorkerRun"
  - "buildClaudeCodeArgs"
  - "buildClaudeCodePrompt"
  - "createClaudeWorkerBudgetGate"
  - "emitClaudeToolPermissionDecision"
  - "mapClaudeToolCall"
  - "claudeToolsOutsideProfile"
  - "listClaudeSdkModels"
  - "loadClaudeAgentSdk"
  - "isClaudeCodeSessionId"
  - "createClioToolBridge"
tests:
  - "tests/extended/claude-subprocess.test.ts"
  - "tests/contracts/claude-sdk-install.test.ts"
  - "tests/contracts/claude-sdk-clio-tools.test.ts"
invariants:
  - "The SDK module is imported only at run time through loadClaudeAgentSdk, so installs without the optional package still load this code."
  - "A worker run with onPermission set to escalate is refused by startClaudeSdkWorkerRun with an error; only deny and fail reach the SDK permission gate."
  - "In the SDK path, every tool call is decided once per tool-use id; a PreToolUse hook and canUseTool callback share the cached decision."
  - "In the CLI path, the user prompt is written to stdin and never placed in argv; the system prompt is passed with --append-system-prompt."
  - "In read-only runs the CLI path passes --permission-mode plan and --tools limited to Read, Grep, Glob, LS, WebFetch, WebSearch."
  - "A mapped Claude tool whose Clio builtin is outside the admitted allowedTools set is denied before the safety net runs, when the caller supplies allowedTools."
  - "The clio SDK MCP server registers only the bridged tools (context, artifact, verify) in the admitted surface, and each of its calls passes the same permission gate as a preset tool."
  - "Usage and cost from Claude runs are recorded as peer-report estimates, not billed amounts."
validate:
  - "pnpm run test:file -- tests/extended/claude-subprocess.test.ts"
  - "pnpm run test:file -- tests/contracts/claude-sdk-install.test.ts"
  - "pnpm run test:file -- tests/contracts/claude-sdk-clio-tools.test.ts"
---

# Claude worker runtimes: SDK and CLI subprocess

This area is the Claude-specific engine code for dispatched workers. A reader needs it when changing how a `claude-sdk` or `claude-code` worker starts, how its tool calls are mapped onto Clio builtins and permitted, how budgets are counted, or how its output and usage are turned into Clio messages. Two runtimes live here. `src/engine/claude/sdk-runtime.ts` drives the optional `@anthropic-ai/claude-agent-sdk` package. `src/engine/claude/subprocess-runtime.ts` spawns the operator's `claude` binary and reads its `stream-json` output. The shared helpers in `src/engine/claude/tool-safety.ts` decide each mapped call, and the remaining files load the SDK lazily, list its models, and validate session identifiers.

## What owns it

- `src/engine/claude/sdk-runtime.ts`: `startClaudeSdkWorkerRun` is the SDK entry point. It also exports `createClaudeWorkerBudgetGate` and the `ClaudeWorkerBudgetGate` interface. The file keeps the streaming prompt iterator (`ClaudeSdkInput`), the permission and hook builders (`buildCanUseTool`, `buildPreToolUseHook`, `buildPostToolUseHook`), and the message normalizers.
- `src/engine/claude/subprocess-runtime.ts`: `startClaudeCodeWorkerRun` is the CLI entry point. It exports `buildClaudeCodeArgs`, `buildClaudeCodePrompt`, `ClaudeRuntimeDependencies`, `ClaudeSubprocessPermissionConfig`, and the stream byte limits `CLAUDE_MAX_STREAM_LINE_BYTES` and `CLAUDE_MAX_STREAM_BYTES`.
- `src/engine/claude/tool-safety.ts`: `mapClaudeToolCall`, `claudeToolsOutsideProfile`, `isClaudeSdkTool`, `emitClaudeToolPermissionDecision`, and `coerceToolInput`. It holds the static map from Claude preset tool names to Clio builtins (`CLAUDE_TOOL_TO_CLIO`) and the bridged tool set (`CLAUDE_SDK_BRIDGED_TOOLS`: `context`, `artifact`, `verify`) with the bridge server name (`CLAUDE_SDK_CLIO_SERVER`). `mapClaudeToolCall` maps `mcp__clio__<tool>` back to the Clio tool for those three only.
- `src/engine/claude/clio-tool-bridge.ts`: `createClioToolBridge` builds the in-process SDK MCP server named `clio` that carries the bridged tools a claude-sdk worker's admitted surface holds. Each handler invokes Clio's own implementation through a worker tool registry built with the run's safety contract and read-only flag, so the registry's admission is a second seam behind the SDK permission gate. Every bridged capability is attached under its own name, including gateway-placed `artifact`, because the SDK has no Clio gateway. The handler emits `tool_execution_start`/`tool_execution_end` and the registry emits `clio_coder_tool_start`/`clio_coder_tool_finish` with the real outcome, all keyed by the SDK tool-use id, so a failed `verify` never records as ok.
- `src/engine/claude/sdk-module.ts`: `loadClaudeAgentSdk` performs the dynamic import of the SDK entry. `ClaudeAgentSdkUnavailableError` and the install constants are re-exported from `src/domains/lifecycle/claude-sdk-install.ts`.
- `src/engine/claude/sdk-models.ts`: `listClaudeSdkModels` asks the SDK for its supported models without submitting a prompt.
- `src/engine/claude/session-id.ts`: `isClaudeCodeSessionId` accepts only RFC 4122-shaped UUIDs (versions 1 to 5) before they are passed as `--session-id` or as the SDK `sessionId` option.

## Callers and dependencies

Upstream, the worker runtime dispatches to these functions. `src/engine/worker-runtime.ts` and `src/engine/worker-tools.ts` both reference the Claude engine path (found by symbol search). The Claude runtime descriptor `src/domains/providers/runtimes/claude/claude-sdk.ts` and the ACP and external-CLI connectors also reference it. The `claude-code` runtime descriptor is imported by the subprocess test. Those upstream files were located by search; this page traced the calls from the runtime entry points, not from each caller.

Downstream, both runtimes depend on:

- `src/core/claude-environment.ts` (`withClaudeCredential`, `claudeAuthEnvironment`) for credential placement in the child environment.
- `src/domains/providers/auth/index.ts` (`resolveClaudeLaunchCredential`) for the subscription token.
- `src/domains/safety/admission.ts` (`evaluateAdmission`) through `src/engine/claude/tool-safety.ts`, which is the shared decision function also used by native and ACP paths.
- `src/engine/worker-tools.ts` (`createWorkerSafety`) for the safety contract passed into permission decisions.
- `src/engine/loop-guard.ts` (`isReserveAdmittedTool`, `resolveDeliveryTools`) for the budget reserve rules.
- `src/engine/external-subprocess.ts` and `src/engine/external-call-telemetry.ts` for the CLI process tree and usage binding.
- `src/domains/lifecycle/claude-sdk-install.ts` for SDK entry resolution.

## Data and control flow: the SDK path

`startClaudeSdkWorkerRun(input, emit)` begins by refusing `onPermission: "escalate"`, because the SDK permission callback cannot park a call. It then builds the first user message from `buildClaudeSdkPrompt`, which joins dynamic prompt messages with the task. The streaming prompt is a `ClaudeSdkInput` queue, so later `steer` calls can push more user turns while the query is open.

The run builds a `PermissionGateInput` and a `ClaudeWorkerBudgetGate` when `input.budget` is set. The gate is created by `createClaudeWorkerBudgetGate(budget, onBoundary, onHardCap, deliveryTools)`. Its `attempt` method counts every logical tool attempt and denies once `attempts > budget.hardCap` for non-advisory budgets, calling `onHardCap` and aborting the run. Its `admit` method runs after a call passes profile, autonomy and safety evaluation, increments the admitted count, and locks the phase when the soft `toolCalls` limit is reached. Advisory budgets use `ceiling` instead. Delivery tools (`resolveDeliveryTools`) can continue past the soft limit; the read reserve window admits only `read` plus delivery tools.

Clio tools with no Claude preset alias (`context`, `artifact`, `verify`) reach the worker through the `clio` SDK MCP server, which is set as `options.mcpServers` after the SDK loads and only when the admitted surface holds one of them. The SDK names those calls `mcp__clio__<tool>`; they take the same permission path below as preset tools, so read-only runs deny `artifact` and `verify` there. Dispatch admission counts them as carried (`isClaudeSdkTool`), which lets `architect`, `coder --read-only`, `debugger` and `verifier` run on `claude-sdk`. With the bridge attached the run sets `strictMcpConfig`, so user, project and plugin MCP configs never join a worker's surface. The gate emits no telemetry for an allowed bridged call (the bridge reports it), and the `PostToolUse` hook skips bridged calls. The run's recipe-bound skill policy is one object shared by the bridge and the permission gate: a skill the bridged `context` loads narrows every later call, preset tool or bridged.

Each SDK tool use reaches `decideToolUseOnce`, which caches the decision by tool-use id in `handledToolDecisions`, so the `PreToolUse` hook and the `canUseTool` callback see one decision. `decideToolUse` calls `emitClaudeToolPermissionDecision`, which in order:

1. Calls `evaluateClaudeToolPermission`. It maps the Claude name with `mapClaudeToolCall`, consults the budget gate's `attempt`, and calls `evaluateAdmission`. An allow result still consults `budgetGate.admit`. An ask result becomes a `permissionRequired` denial with `approvalAuthority`. Other denials are classified by `deniedDecision` into `safety_net`, `read_only`, `tool_scope` (tool profile), or other admission codes.
2. Records the decision with `safety.decisions.recordToolCall`, then emits `clio_coder_tool_start`, then either `clio_coder_permission_resolved` (for permission-required denials) and `clio_coder_tool_finish`.

`permissionResultForDecision` maps the result for the SDK. An allow returns `behavior: "allow"`. A deny returns `behavior: "deny"` with `interrupt` set when `endsPermissionRun` holds: a permission-required denial where `onPermission` is `"fail"` or where the action class is `execute`. That path calls `onPermissionFailure`, which sets `permissionFailure` and aborts. The run then returns exit code `WORKER_EXIT_PERMISSION_REQUIRED`.

Streamed output is read from the `for await` loop over the query. `system` `init` messages set the model and response id. `stream_event` messages feed `captureCall` (per-model-call usage and stop reason), and text deltas go through `emitTextDelta`. `assistant` and `result` messages set the final text and terminal result. The loop closes the prompt when `pendingTurns` drops to zero or a result carries an error. The final assistant message is built by `buildAssistantMessage`, which binds external usage with `costEstimateMethod: "peer-report"`. A `finally` block closes the query and the prompt and stops the credential-expiry watch.

The returned `WorkerRunHandle` exposes `promise`, `abort`, and `steer`. `steer` returns `false` once the run is finished or aborted.

## Data and control flow: the CLI subprocess path

`startClaudeCodeWorkerRun(input, emit, dependencies)` checks `input.signal` first, then calls `buildClaudeCodeArgs`. That function calls `assertToolProfileEnforceable(input.toolProfile, "claude-code")` and produces `-p --output-format stream-json --verbose --include-partial-messages --no-session-persistence --permission-mode <mode>`. Read-only runs use mode `plan` plus `--tools Read,Grep,Glob,LS,WebFetch,WebSearch`; other runs use `acceptEdits`. `--model`, `--append-system-prompt` and `--session-id` (only when `isClaudeCodeSessionId` accepts the value) are added as configured.

The prompt is written to the child's stdin with `child.stdin.end(prompt)`, from `buildClaudeCodePrompt`, so it never appears in argv. The child is spawned with `resolveSafeCwd(input.cwd, workspaceRoot)`, which throws `cwd escapes workspace root` for a path outside the workspace (the subprocess test asserts this before any spawn). The environment comes from `buildSafeToolEnv(claudeAuthEnvironment(sourceEnv), sourceEnv)` with the credential placed by `withClaudeCredential`.

`readJsonLines` reads stdout through `readBoundedLines` with the line and total byte limits. An oversized line throws, which becomes a transport error. Each parsed JSON object updates the model, the final `result`, assistant text, or a text delta. Non-JSON lines are skipped. Termination goes through `createProcessTreeTerminator`; the final message's `stopReason` is `aborted`, `error`, or `stop`, and the run exit code is `0` only for a `stop` result. A missing binary yields the message "Claude Code CLI (`claude`) is not installed or not on PATH."

## Tool mapping

`mapClaudeToolCall` translates each preset name to a Clio builtin: `Bash`, `Read` (also `NotebookRead`), `Edit` and `MultiEdit`, `Write`, `Grep`, `Glob` to `find`, `LS` and `Ls`, `WebFetch` and `WebSearch`, `Task` to dispatch, and `TodoWrite` to tasks. Unknown names become `claude:<name>` with `known: false`, and those are left to the safety net. `searchArgs` moves a glob that is absolute or contains `..` into a search path prefix, so the policy judges the directory the search actually reaches. `claudeToolsOutsideProfile` produces the list passed as `disallowedTools` to the SDK, so the model is not offered out-of-profile tools. The mediation gate remains the authoritative check.

## Tests

- `tests/extended/claude-subprocess.test.ts` drives `startClaudeCodeWorkerRun` against a fake `claude` script. Its test `"sends the prompt on stdin, keeps it out of argv, and passes only allowlisted environment values"` asserts that the observed argv equals `buildClaudeCodeArgs(input)`, that `--append-system-prompt` is present, that no argument contains the prompt text, that the stdin equals `buildClaudeCodePrompt(input)`, that `FAKE_API_SECRET` is not passed through, and that the result's `api` is `claude-code-subprocess`. Another case asserts that a missing binary gives exit code `1` with a not-installed message, and that a cwd outside the workspace throws `cwd escapes workspace root` before spawn.
- The same file runs a credential-placement case for two modes (`shared` and external profile). With a Clio token, `CLAUDE_CODE_OAUTH_TOKEN` is set and `ANTHROPIC_API_KEY` is absent. With an external profile, the external key is preserved and no OAuth token is set. It also asserts that `--setting-sources` and `--strict-mcp-config` are not in argv.
- `tests/extended/claude-subprocess.test.ts` also covers the SDK path. `tests/contracts/claude-sdk-install.test.ts` imports `startClaudeSdkWorkerRun` and `loadClaudeAgentSdk` and uses a fake `@anthropic-ai/claude-agent-sdk` package in a temporary directory. Those cases exercise the install and load behavior and the steering path. The subset read for this page was the credential test and the subprocess argv and stdin case; the SDK permission and budget cases were not read in detail.
- Search for `startClaudeSdkWorkerRun`, `startClaudeCodeWorkerRun`, `evaluateClaudeToolPermission` and related symbols found references in `tests/contracts/peer-default-readonly.test.ts`, `tests/contracts/safety-gates.test.ts`, `tests/contracts/worker-readonly-dispatch.test.ts`, `tests/contracts/read-scope.test.ts`, and `tests/extended/advisory-dispatch-budgets.test.ts`. These were identified by search only and were not read for this page.

## Things to watch when editing

- `src/engine/claude/sdk-module.ts` must not gain a module-scope import of the SDK. The file comment and `src/engine/claude/sdk-runtime.ts` both rely on the optional package being absent from ordinary boots. Type-only imports from `@anthropic-ai/claude-agent-sdk` are allowed.
- The SDK path refuses `escalate` at its entry, and dispatch admission is said to refuse it earlier. Keep both in agreement if the permission modes change.
- `CLAUDE_TOOL_TO_CLIO` and the `switch` in `mapClaudeToolCall` must stay in step; the source comment says so explicitly. `claudeToolsOutsideProfile` reads the map, so an entry added only to the switch would be missing from the disallow list.
- The CLI read-only argument list (`READ_ONLY_CLAUDE_TOOLS`) is independent of the SDK allow surface. Changes to one do not change the other.
- Usage from both runtimes is labeled `costEstimateMethod: "peer-report"`. The source comments state that the SDK and CLI price calls from client-side tables, so these totals are estimates. Downstream code that presents cost should keep that label.
- The budget gate's `attempt` counter increments before the phase check, so a denied call still consumes one hard-cap attempt. This is what the code does; no focused test was read to confirm the exact count.

For the broader tool surface and profiles these files consume, see [Tools](../tools.md). The worker runtime that dispatches to these functions is described in [Worker](../worker.md), and the engine overview is [Engine](../engine.md).
