# Changelog

All notable changes to Clio Coder are tracked here. Format loosely follows
Keep a Changelog.

## 0.1.2 — Unreleased

### Added

- Interactive chat now retries transient provider and stream failures using
  session retry settings. Retry boundaries, cancellation, exhaustion, and
  recovery are visible in the transcript and persisted for resume/fork replay.
- Tool and bash transcript lines now show clearer running/success/error status,
  with bash command previews in live and replayed transcripts.

### Fixed

- Retrying a transient failure now continues from the existing user turn instead
  of adding a duplicate user message to model context.
- Cancelling an interactive run now also cancels a pending retry countdown and
  forwards abort signals into bash tool subprocesses.

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
