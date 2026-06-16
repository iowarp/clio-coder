# Claude Code Runtime Implementation Report

## Built

- Added two sanctioned Claude Code worker runtimes:
  - `claude-sdk`: `kind: sdk`, `apiFamily: claude-agent-sdk`, `auth: claude-cli`
  - `claude-code`: `kind: subprocess`, `apiFamily: claude-code-subprocess`, `auth: claude-cli`
- Extended the provider runtime descriptor, registry validation, target eligibility, dispatch evidence, worker spec contract, runtime resolution, provider support UI, and docs to recognize `sdk`, `subprocess`, and `claude-cli` without changing the existing `anthropic`, `anthropic-max`, or `openai-codex` behavior.
- Added `@anthropic-ai/claude-agent-sdk` at exact version `0.3.178`.
- Added a Claude SDK worker runtime that uses `query()` with:
  - Clio system prompt appended to the Claude Code preset.
  - streaming input support for initial prompts and runtime steering.
  - cancellation through `AbortController`, query interrupt, and query close.
  - `PreToolUse` routed through Clio's safety contract and autonomy matrix for every observed tool execution.
  - `canUseTool` routed through the same Clio gate for SDK permission-prompt paths.
  - noninteractive permission handling aligned with `workers.onPermission`.
- Added a Claude subprocess worker runtime that uses:
  - `claude -p --output-format stream-json`
  - stream-json parsing into Clio worker events.
  - cancellation through process termination.
  - Claude CLI permission modes mapped from Clio autonomy.
  - dangerous bypass only when autonomy is `full-auto` and `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1`.
- Updated the runtime-cleanup contract test to reverse the old blanket rejection of Claude Code runtimes while still forbidding the removed legacy CLI/runtime paths.

## Live Tool Research

- `claude --help` supports `-p/--print`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--include-partial-messages`, `--permission-mode acceptEdits|auto|bypassPermissions|default|dontAsk|plan`, `--allowedTools`, `--disallowedTools`, `--tools`, `--model`, `--append-system-prompt`, `--session-id`, `--resume`, `--no-session-persistence`, `--max-budget-usd`, and `--allow-dangerously-skip-permissions`.
- This installed CLI help does not expose a `--permission-prompt-tool` flag, so the subprocess runtime cannot delegate per-tool decisions directly back into Clio.
- `npm view @anthropic-ai/claude-agent-sdk version` resolves to `0.3.178`.
- The SDK exposes `query({ prompt, options })`; `options.canUseTool` returns allow or deny permission results, and supports `abortController`, `cwd`, `model`, `pathToClaudeCodeExecutable`, `permissionMode`, `includePartialMessages`, `systemPrompt`, `tools`, `allowedTools`, `disallowedTools`, `env`, and `persistSession`.

## Key Design Decisions

- `claude-sdk` and `claude-code` are worker-only targets. Dispatch can resolve and run them, but chat orchestration, `print`, and `targets use` continue to require orchestrator-capable HTTP/native runtimes.
- `claude-cli` auth is represented as a runtime auth class instead of Clio-managed credentials. Clio stores no Claude subscription credential; users authenticate with the installed `claude` CLI.
- The SDK path is the strong safety path. Claude tool executions and permission requests are mapped into Clio tool/action classes, evaluated by the existing safety contract, then interpreted through Clio autonomy. Current SDK `canUseTool` does not fire for every auto-allowed read, so Clio now installs a `PreToolUse` hook as the all-tool gate and keeps `canUseTool` wired to the same decision cache for permission-prompt paths. SDK permission asks are noninteractive inside workers: `workers.onPermission=deny` denies the tool and `workers.onPermission=fail` aborts the run with the permission-required worker exit code.
- The subprocess path follows what the current CLI can enforce: permission mode, tool allowlists where useful, and the full-access bypass gate. It intentionally never passes the deprecated `--dangerously-skip-permissions` alias.
- Runtime descriptor version moved from `1` to `2` so worker specs can explicitly carry `sdk` and `subprocess` runtimes.

## How To Drive It

Authenticate outside Clio:

```bash
claude auth login
```

Configure the SDK worker target:

```bash
clio configure --id claude-sdk-worker --runtime claude-sdk --model sonnet --set-fleet-default
```

Configure the subprocess worker target:

```bash
clio configure --id claude-code-worker --runtime claude-code --model sonnet --set-fleet-default
```

Use a named worker profile instead of changing the orchestrator target:

```bash
clio targets profile claude-sdk claude-sdk-worker --model sonnet
clio targets profile claude-code claude-code-worker --model sonnet
```

Run dispatch through the selected fleet default or worker profile:

```bash
clio run --agent coder "Inspect the provider runtime contracts and summarize the supported runtime kinds."
```

Keep chat orchestration on an orchestrator-capable target:

```bash
clio targets use <http-or-native-target-id>
```

## Known Gaps

- `claude-code` cannot perform per-tool Clio permission callbacks because the current `claude --help` surface does not include a permission-prompt hook. It is still constrained by permission modes and the explicit full-access environment gate.
- `claude-code` uses one-shot `claude -p` prompting. It supports cancellation, but live steering is not wired through `--input-format stream-json` yet.
- `claude-sdk` preserves assistant text, usage, cost, and safety events in Clio's worker stream, but it does not yet persist a fully normalized Claude tool-call transcript beyond the emitted telemetry/events.
- `claude-sdk` uses `PreToolUse` rather than `canUseTool` as the all-tool gate because the current SDK auto-executes reads without calling `canUseTool`. `canUseTool` remains wired for permission-prompt paths.
- The runtime model aliases are intentionally simple (`sonnet`, `opus`, `haiku`, plus Claude-style ids) because Claude Code resolves subscription model aliases itself.

## Verification

Focused checks:

```text
npm run typecheck
npm run test:file -- tests/contracts/providers.test.ts tests/contracts/claude-runtimes.test.ts
npm run lint
npm run build
```

Full gate:

```text
npm run ci
tests 689
suites 134
pass 689
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 37748.934354
```

## Suggested Claude Code Verification

- Configure `claude-sdk` and run a dispatch that performs read-only inspection under `read-only`; confirm reads succeed and edits are denied.
- Configure `claude-sdk` under `auto-edit`; confirm ordinary edits are allowed while unrecognized shell commands require permission and follow `workers.onPermission`.
- Configure `claude-code` under `full-auto` without `CLIO_ALLOW_EXTERNAL_FULL_ACCESS`; confirm no dangerous bypass flag is sent.
- Re-run `claude-code` with `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` only when intentionally testing the bypass posture, and confirm the command uses `--allow-dangerously-skip-permissions`.

## Live Verification

All live commands were run from `/home/akougkas/iowarp/clio-coder-codex` with the inherited Claude Code nesting markers stripped:

```bash
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_EXECPATH <command>
```

Auth check:

```bash
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_EXECPATH claude auth status
```

Observed: `loggedIn: true`, `authMethod: claude.ai`, `apiProvider: firstParty`, `subscriptionType: pro`.

The live worker harnesses used the shipped integration path, not direct SDK calls:

```bash
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_EXECPATH node --import tsx --input-type=module -
```

The harness imported `startWorkerRun` from `src/engine/worker-runtime.ts`, the registered runtime descriptors from `src/domains/providers/runtimes/claude/`, and collected `AgentEvent` / `ClioWorkerEvent` payloads from the worker event callback.

### Path B: `claude-sdk`

Current SDK deviations discovered while live testing:

- `settingSources` omitted means "load all filesystem settings" in `@anthropic-ai/claude-agent-sdk@0.3.178`; isolation requires `settingSources: []`.
- `permissionMode: plan` means no tool execution, so SDK read-only cannot use `plan` if Clio is expected to make tool decisions.
- `canUseTool` did not fire for auto-allowed `Read` executions. `PreToolUse` did fire for `Read`, so Path B now uses `PreToolUse` as the all-tool Clio gate and keeps `canUseTool` attached to the same safety decision cache for permission-prompt paths.
- The SDK async prompt stream stays open until the iterable closes. Path B now sends the initial worker prompt as a string and uses `queryHandle.streamInput()` for steering.
- Claude Code `sessionId` must be UUID-shaped; Path B/C now forward only UUID-shaped session ids.

Allowed read under `read-only`:

- Prompt: `Use the Read tool to read tmp/clio-live-read-proof.txt and report its exact marker value only. Do not guess.`
- Nested markers inside the spawning process: all five requested keys were `null`.
- Result: exit code `0`, stop reason `stop`, model `claude-sonnet-4-6`.
- Clio decision: `tool=read`, `actionClass=read`, `decision=allowed`, `outcome=ok`, `reasonCode=allowed`, `policySource=none`.
- Output included the hidden marker: `codex-bc-path-read-20260616`.
- Usage: input `4`, output `107`, cache read `27229`, cache write `6438`, total tokens `33778`, reported cost `$0.0490187`.
- Latency: `7862ms`.

Denied write under `read-only`:

- Prompt: `Use the Write tool to create tmp/claude-sdk-live-denied-1781617138923.txt containing CLIO_WRITE_SHOULD_BE_DENIED. Do not ask; just try the Write tool, then report whether the write was allowed.`
- Result: exit code `0`, stop reason `stop`, model `claude-sonnet-4-6`.
- Clio decision: `tool=write`, `actionClass=write`, `decision=blocked`, `outcome=blocked`, reason `write denied: autonomy level is read-only`.
- Filesystem check: `fileExistsAfterRun: false`.
- Usage: input `4`, output `155`, cache read `27256`, cache write `6491`, total tokens `33906`, reported cost `$0.0500918`.
- Latency: `5964ms`.

Steering:

- Prompt: read the same marker file and include any live follow-up instruction received during the run.
- Steer sent through `WorkerRunHandle.steer("LIVE_STEER_MARKER=codex-steer-ok")`.
- Clio event: `clio_steer_received` with `chars: 32`.
- Result text included `LIVE_STEER_MARKER=codex-steer-ok`.
- Usage: input `4`, output `161`, cache read `27240`, cache write `6516`, total tokens `33921`, reported cost `$0.0503110`.
- Latency: `7144ms`.

Cancellation:

- Prompt: long no-tool response; `WorkerRunHandle.abort()` called after `700ms`.
- Result: stop reason `aborted`, latency `860ms`. Current `WorkerRunResult.exitCode` remained `0`; consumers should inspect `stopReason` for SDK cancellation until/unless the worker exit convention is tightened.

### Path C: `claude-code`

Permission mapping check used the exported subprocess helpers:

```bash
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_EXECPATH node --import tsx --input-type=module -
```

Observed:

- `read-only` -> `permissionMode: plan`, `--tools Read,Grep,Glob,LS,WebFetch,WebSearch`, no dangerous bypass.
- default autonomy -> `permissionMode: default`, no extra args, no dangerous bypass.
- `full-auto` without env -> `permissionMode: default`, no dangerous bypass.
- `full-auto` with `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` -> `permissionMode: bypassPermissions`, `--allow-dangerously-skip-permissions`, `dangerousBypass: true`.
- The deprecated `--dangerously-skip-permissions` alias was not emitted.

Live subprocess worker run:

- Prompt: `Reply exactly CLIO_SUBPROCESS_LIVE_OK`.
- Nested markers inside the spawning process: all five requested keys were `null`.
- Result: exit code `0`, stop reason `stop`, model `claude-sonnet-4-6`, output `CLIO_SUBPROCESS_LIVE_OK`.
- Usage: input `3`, output `14`, cache read `0`, cache write `16135`, total tokens `16152`, reported cost `$0.097029`.
- Latency: `2391ms`.

Rate-limit notes:

- Direct raw SDK/CLI probes emitted `rate_limit_event` with `status: allowed`, `rateLimitType: five_hour`, `overageStatus: allowed`, and `isUsingOverage: false`.
- No live integrated B/C run failed due to rate limiting.
