# Changelog

All notable changes to Clio Coder are tracked here. Format loosely follows
Keep a Changelog.

## Unreleased

## 0.1.2 — 2026-04-25

### Added

- Interactive chat now retries transient provider and stream failures using
  session retry settings. Retry boundaries, cancellation, exhaustion, and
  recovery are visible in the transcript and persisted for resume/fork replay.
- Tool and bash transcript lines now show clearer running/success/error status
  with bash command previews and elapsed time in live and replayed transcripts.
  Tool segments collapse by default with per-tool sublines, and `Ctrl+O`
  toggles full-output expansion through the keybindings manager.
- Edit-tool results render a unified diff preview alongside the structured
  tool-execution block.
- Settings overlay exposes retry controls (`retry.enabled`, `retry.maxRetries`,
  `retry.baseDelayMs`, `retry.maxDelayMs`) so users can tune retry behavior
  without hand-editing `settings.yaml`.
- The interactive TUI now opens with a Clio Coder dashboard showing target,
  model registry, context, latency, and worker-profile status. Interactive
  startup no longer prints a separate legacy banner above the dashboard.
- `/hotkeys` supports row selection, a read-only keybinding detail panel, and
  legacy-terminal warnings when user bindings require CSI-u support.
- Editor prompt rails reflect the active mode: default uses the terminal
  foreground, advise uses amber, super uses red.
- Slash-command autocomplete: typing `/` opens a filtered dropdown of every
  built-in command, and Tab accepts the selected entry.
- `/resume` picker now shows a one-line conversation preview, message count,
  and relative time per session.
- Prompt assembly auto-loads project context files (`AGENTS.md`, `CODEX.md`,
  `CLAUDE.md`) walking from the working directory upward; pass
  `--no-context-files` (alias `-nc`) to disable.
- Run receipts now carry per-tool stats (loops, errors, blocked attempts,
  parallel batches) emitted by worker telemetry hooks.
- `clio targets --json` exposes `detectedReasoning` and
  `reasoningCandidateModelId` so the `/thinking` probe state is observable
  from the CLI.
- Compaction summaries persist `triggerReason` and `tokensAfter` in the
  session entry stream, leaving a queryable trail for every `/compact`.
- Audit JSONL is now a five-arm discriminated union over `kind`: `tool_call`,
  `mode_change`, `abort` (sources `dispatch_abort`, `dispatch_drain`,
  `stream_cancel`), `session_park`, `session_resume`. Safety subscribes on
  start, unhooks on stop, and fsyncs every row. Integration coverage lives
  in `tests/integration/audit-{mode-transitions,run-aborts,session-lifecycle}.test.ts`.
- `tools.web_fetch` honors the abort signal end-to-end; bash abort coverage
  now includes a success-then-abort guard.

### Changed

- Slash-command help and autocomplete present only canonical commands:
  `/model`, `/quit`, and `/receipts [verify <runId>]` replace duplicate
  spellings such as `/models`, `/exit`, and `/receipt verify <runId>`.
- Provider catalog and cloud defaults realign with `pi-ai` 0.70.2; the
  `@mariozechner/pi-*` line is pinned to 0.70.x with a current lock at 0.70.2.
- Worker tool-call path validates once and threads telemetry hooks so the
  agent loop, dispatch board, and receipts share one source of truth.
- Mode fragments must now enumerate the matrix tool set; a new regression
  test pins per-mode tool resolution and toggle re-resolution so future drift
  between `MODE_MATRIX` and the chat-loop fails fast.

### Fixed

- Retrying a transient failure continues from the existing user turn instead
  of duplicating it in model context.
- Cancelling an interactive run cancels any pending retry countdown and
  forwards abort signals into bash tool subprocesses.
- The last failed assistant message is pruned from live model context on
  every terminal exit of the retry chain so live state matches what
  `/resume` and `/fork` rebuild from the persisted transcript.
- A retryable error thrown from `agent.prompt` persists the original error
  as a visible failed assistant entry instead of surfacing only as a
  `[retry]` status line.
- Bash subprocess abort escalates to `SIGKILL` after a 5-second `SIGTERM`
  grace period so commands that trap or ignore `SIGTERM` no longer hang
  the chat-loop.
- Bash commands that exceed the 2 MB output cap report
  `command output exceeded N bytes` instead of a generic `SIGTERM`
  termination.
- `/resume`, `/fork`, and `/new` abort an in-flight agent run before
  reseating context so a pending retry-chain `agent.continue()` cannot race
  the new session's messages.
- Retry status lines render byte-identically in the live transcript and
  after `/resume` by sharing a single formatter.
- Streamed responses that emitted partial text before failing render both
  the partial output and the terminal error indicator together.
- Failed turns with empty usage no longer write zero-token rows to the
  observability ledger.
- User-facing product labels consistently say Clio Coder instead of mixing
  lowercase command-name branding into headers, prompts, and status text.
- Provider hot-swap on a same-endpoint model switch now updates the live
  agent without rebuilding the chat-loop, and stale model state is hardened
  on every swap surface.
- `lmstudio-native` preserves reasoning content, drops `<think>` tags, and
  forces `toolUse` on tool calls so `/thinking` and `clio run` behave on
  LM Studio backends.
- `openai-compat` tool schemas and reasoning probe align so `/thinking`
  and `clio run` work against local llama.cpp / vLLM / SGLang servers.
- Dismissing the Alt+S super-mode overlay emits a `request_cancelled`
  `mode_change` audit row instead of dropping the transition silently.

## 0.1.1 — 2026-04-24

### Added

- Interactive prompt compilation now loads project context files from the
  current working directory upward. `AGENTS.md` and `CODEX.md` are injected in
  deterministic parent-to-child order when present.

### Fixed

- Session resume, fork, and tree-switch replay now read the rich session entry
  stream instead of only legacy user/assistant turns, so compaction summaries,
  branch summaries, bash/tool entries, custom display entries, system notes,
  and checkpoints are visible when present.
- Interactive tool calls and results are now written as durable session entries
  so tool work remains visible after resume and fork.
- Resuming a session whose JSONL tail is metadata no longer resets the next
  turn parent to `null`; the interactive loop now derives the resumed leaf
  from the persisted tree.
- CLI-backed subprocess runtimes now dispatch through the native worker entry
  instead of running inline in the orchestrator process.
- Out-of-tree SDK runtime plugins now pass runtime descriptor validation and
  rehydrate correctly inside native worker subprocesses.
- `/receipt verify <runId>` now verifies a SHA-256 integrity field against the
  persisted run ledger entry instead of accepting schema-valid receipt JSON.
- Dispatch heartbeats now promote stale/dead worker states into run state and
  the live dispatch board instead of leaving silent workers marked running.
- `npm run check:boundaries` now exists for the boundary command documented in
  contributor guidance.

## 0.1.0-exp — 2026-04-24

First public release. Experimental. Expect moving surfaces; pin the tag if
you need a stable target.

### What ships

- **Interactive TUI.** Terminal chat with target and model controls, session
  navigation, resume/fork, markdown-rendered replies, configurable
  keybindings, a searchable resume picker, scoped-model cycling, a
  live-updating dispatch board, and receipts/cost overlays.
- **CLI lifecycle.** `clio`, `clio configure`, `clio targets`, `clio models`,
  `clio auth`, `clio doctor`, `clio reset`, `clio uninstall`, `clio agents`,
  `clio run`, `clio upgrade`, `clio --version`.
- **Target-first configuration.** Local HTTP engines, cloud APIs,
  OAuth/subscription runtimes, and CLI-backed runtimes all live in
  `targets[]`; `orchestrator` and `workers` point at those ids. Known and
  discovered models are surfaced through `clio models` and the TUI model
  selector.
- **Runtime coverage.** Native subprocess worker; protocol adapters for
  openai-compat, llamacpp, Ollama, vLLM, SGLang, LM Studio, Lemonade;
  cloud adapters for Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter,
  Bedrock; OAuth path for openai-codex (ChatGPT Plus/Pro via Codex);
  CLI-backed runtimes for Codex CLI, Claude Code CLI, Gemini CLI, Copilot
  CLI, OpenCode CLI; and a Claude Agent SDK worker path.
- **Seven builtin agents.** `scout`, `planner`, `researcher`, `reviewer`,
  `delegate`, `context-builder`, `worker`. Plain Markdown specs with
  frontmatter in `src/domains/agents/builtins/`.
- **Dispatch and workers.** `clio run` spawns OS-isolated worker
  subprocesses with NDJSON IPC and heartbeats. Named worker profiles
  let the interactive session fan out across multiple runtimes.
- **Self-development mode.** Hot-reload and restart-required signals for
  developers editing Clio from inside Clio, with shell environment isolation
  and tool guards.
- **Receipts and audit.** Every run writes a receipt under
  `<dataDir>/receipts/<runId>.json` with token counts and USD cost.
- **Safety model.** Three modes (`default`, `advise`, `super`) gate tool
  visibility at the registry. Hardcoded Bash kill-switches live in
  `damage-control-rules.yaml`.
- **State layout.** XDG-aware, with `CLIO_HOME` plus `CLIO_CONFIG_DIR` /
  `CLIO_DATA_DIR` / `CLIO_CACHE_DIR` overrides for sandboxed installs.

### Known limits

- Windows is best-effort until a later release.
- The self-dev harness is a developer convenience, not a polished public
  surface.
- Some runtime slots (remote fan-out, broader MCP) are scaffolded but not
  admitted by dispatch yet.

### Verification

- `npm run ci` gates typecheck, lint, unit/integration/boundary tests,
  production build, and e2e spawn + pty tests.
