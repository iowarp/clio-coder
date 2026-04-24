# Changelog

All notable changes to Clio Coder are tracked here.

No public release has shipped yet. Treat every entry below as pre-release
development history until `0.1.0` is tagged.

Format: compact Keep a Changelog style, with source ranges included so agents
can audit the git history without expanding every commit.

## Unreleased

Target: `0.1.0-exp`

Source range: `main..v0.2/parity` (`747f71c..9c59275`) as of 2026-04-24.

### Added

- Interactive worker profiles for non-interactive dispatch and `/run`, with
  per-profile target, model, thinking, and permission settings.
- CLI-backed runtimes for Codex CLI, Claude Code CLI, Gemini CLI, OpenCode CLI,
  Copilot CLI, plus a Claude Agent SDK worker path.
- `clio targets`, `clio models`, `clio auth`, `clio configure`, `clio reset`,
  and `clio uninstall` as the current lifecycle surface.
- Self-development mode with hot-reload/restart signals, shell environment
  isolation, and tool guards for editing Clio Coder from inside Clio Coder.
- Session retry helpers, branch summary rendering, compaction summary
  rendering, resume/fork replay coverage, and populated-session compaction
  detection.
- Configurable TUI keybindings, searchable resume picker, markdown chat
  rendering, live token counters, and corrected cost overlay math.
- Model reference resolver and `/model <pattern>` selection path.
- Protocol/runtime tier split for cloud, local-native, protocol, and CLI-stub
  providers.
- Local development model knowledge base for Clio self-dev targets.

### Changed

- Runtime catalog upgraded to pi-mono `0.69.0`.
- Provider model knowledge was narrowed to the active development catalog.
- CLI lifecycle naming moved from install/setup/providers/list-models toward
  configure/targets/models/auth.
- Documentation was pruned from long phase plans toward current status,
  specs, and source-of-truth repo files.
- Shutdown now caps domain stop time to avoid TUI exit stalls.

### Fixed

- API key overrides are scoped to the active endpoint.
- Super-confirmed bash dispatch now routes through tool-registry parking.
- Chat panel resume/fork rehydrates consistently and resets active loops.
- TUI tool calls render in turn order and filter thinking text.
- Tree delete errors and keybinding validation are user-facing and tested.
- List-models search filtering and dispatch-board closing behavior were
  corrected.
- Bash child processes no longer inherit unsafe local runtime environment.

### Removed

- Dead local runtime descriptors and legacy provider command files.
- Large transient phase/design docs from tracked source. Use current docs and
  git history for audit context.

### Verification

- Current gate: `npm run ci`.
- Additional live smoke: `npm run smoke:workers:live` when local/CLI runtimes
  are configured.

## 0.1.0-dev History

No `0.1.0` tag has been released. This section records the pre-release base
that `main` currently points at (`747f71c`).

### Phase 11 TUI selector suite

- Added `/thinking`, `/model`, `/scoped-models`, `/settings`, `/resume`,
  `/new`, and `/hotkeys`.
- Added footer scope/reasoning segments and a single slash-command registry.
- Added unit and pty e2e coverage for selector overlays and keybindings.

### Phase 10 Observability and scheduling

- Added observability metrics, session cost accounting, budget verdicts,
  concurrency gates, and disabled-by-default intelligence scaffolding.

### Phase 9 Interactive TUI scaffold

- Added the first interactive terminal UI, footer, editor, mode routing, and
  shutdown handling.

### Phase 8 Provider adapters

- Added Claude SDK subprocess adapter with graceful fallback.

### Phase 7 CLI adapter fleet

- Added CLI adapter stubs and capability tiers.

### Phase 6 Dispatch and native worker

- Added `clio run`, native worker subprocess, NDJSON events, heartbeat,
  receipts, ledger persistence, validation, backoff, and worker tests.

### Phase 5 Core tools

- Added read/write/edit/bash/search/web/plan/review tools with mode gating and
  registry metadata.

### Phase 4 Providers and agents

- Added provider catalog, credential storage, provider health, agent recipes,
  and builtin agent discovery.

### Phase 3 Prompts and session

- Added prompt fragments, prompt compiler, session JSONL, checkpoints, and
  hot-reload support.

### Phase 2 Safety and modes

- Added safety classifier, mode matrix, damage-control rules, audit logging,
  and super-mode confirmation.

### Phase 1 Foundation

- Added config/lifecycle domains, CLI dispatcher, engine boundary wrappers,
  XDG-aware bootstrap, event bus, bus tracing, pre-commit hooks, CI, and
  boundary checks.
