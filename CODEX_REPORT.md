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
  - `canUseTool` routed through Clio's safety contract and autonomy matrix.
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
- The SDK path is the strong safety path. Claude tool permission requests are mapped into Clio tool/action classes, evaluated by the existing safety contract, then interpreted through Clio autonomy. SDK permission asks are noninteractive inside workers: `workers.onPermission=deny` denies the tool and `workers.onPermission=fail` aborts the run with the permission-required worker exit code.
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
tests 687
suites 134
pass 687
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 39404.920683
```

## Suggested Claude Code Verification

- Configure `claude-sdk` and run a dispatch that performs read-only inspection under `read-only`; confirm reads succeed and edits are denied.
- Configure `claude-sdk` under `auto-edit`; confirm ordinary edits are allowed while unrecognized shell commands require permission and follow `workers.onPermission`.
- Configure `claude-code` under `full-auto` without `CLIO_ALLOW_EXTERNAL_FULL_ACCESS`; confirm no dangerous bypass flag is sent.
- Re-run `claude-code` with `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1` only when intentionally testing the bypass posture, and confirm the command uses `--allow-dangerously-skip-permissions`.
