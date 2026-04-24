# Changelog

All notable changes to Clio Coder are tracked here.

No public release has shipped yet. Treat every entry below as pre-release
development history until `0.1.0` is tagged.

Format: compact Keep a Changelog style, with source ranges included so agents
can audit git history without expanding every commit.

## Unreleased

Target: `0.1.0-dev`

Current `main` is the pre-release baseline. The online repository is being
prepared for community development, CI gates, and maintainer-owned review.

### Added

- Contributor, governance, security, code-of-conduct, status, and agent guide
  files for a public contributor workflow.
- GitHub CODEOWNERS, issue templates, pull request template, Dependabot config,
  repository metadata record, and desired branch-protection record.
- NOTICE attribution for IOWarp, iowarp.ai, Gnosis Research Center, and Anthony
  Kougkas.

### Changed

- README now points contributors and agents to status, governance, and review
  rules.
- Package metadata now carries agentic-coding keywords, lab attribution, and
  package-file inclusion for the governance docs.
- CI now has explicit read-only permissions, workflow dispatch, concurrency,
  named matrix jobs, and disabled checkout credential persistence.

### Verification

- Required local gate: `npm run ci`.

## 0.1.0-dev History

No `0.1.0` tag has been released. This section records the pre-release base
through `747f71c`.

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
