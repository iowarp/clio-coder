# Changelog

Public release notes for Clio Coder are documented here. This file is kept
intentionally short for users, operators, and community contributors. The full
developer-facing history, including implementation detail and verification
notes, lives in [DEVLOG.md](DEVLOG.md).

Versions follow semantic versioning for a pre-1.0 project: minor versions may
still change interfaces.

## 0.2.8 - 2026-07-07

- Redesigned the tool surface into seven planes with consolidated observe,
  execute, orchestrate, retrieve, interact, mutate, and artifact tools.
- Added session task tracking with the `tasks` tool, `/tasks`, open-task
  continuation nudges, and receipt-backed task evidence.
- Added richer dispatch controls: `monitor`, `steer`, pipeline dispatch,
  ad-hoc specialist personas, and worker permission escalation.
- Rebuilt context indexing around codewiki schema v4, a separate
  agent-authored wiki layer, `/context refresh`, worker context injection, and
  one ignore policy for grep/find visibility.
- Added prompt manifests, eval provenance, public benchmark manifests, unified
  observation truncation envelopes, `/export`, and deeper per-tool usage docs.
- Improved the interactive UI with a shared TUI design system, slash-command
  argument completion, a `/context` hub, clearer permission queues, and better
  skill-loading guidance.
- Fixed safety and autonomy edge cases around approval denials, symlink path
  checks, loop-guard recovery, external worker tool profiles, reasoning-off
  models, and source-tree awareness in nested repositories.
- Reworked local model residency: local inference targets are treated as
  multi-model servers with finite VRAM, one shared reconciler drives llama.cpp
  routers, LM Studio, and Ollama, co-resident models such as a scout beside
  the main coder are protected symmetrically, residency mutations against one
  server are serialized across processes, and the `CLIO_RESIDENCY=observe`
  and `lifecycle: user-managed` opt-outs now work on every runtime path.
- Added native shadow-agent fleet routing: `/agents` lists shadow agents and
  `/fleet` binds native agents to target/model worker profiles, including
  changing a bound profile's model from the bindings tab.
- Enforced loop-guard synthesis lockouts mechanically for the main agent and
  dispatched workers: locked turns can only answer (request-level
  `tool_choice: none`), dead tool-call markup is sanitized out of locked
  answers, and a result-stagnation detector blocks byte-identical retry
  escalations that evaded the verbatim detector.
- Conditioned the harness for local models with measured fixes: a
  deterministic tool-routing order in the system prompt, task-board reminders
  on enumerated multi-step requests, a validation nudge on successful edits,
  recovery guidance with sanctioned pivots on blocked calls and denials,
  ask_user gated to genuine decisions, bundled-docs retrieval repairs, and
  observation-budget stubs that end retry traps.
- Made the TUI truthful under pressure: context meters draw the autocompact
  reserve with its own glyph, the dispatch board renders at the terminal's
  real width, overflowing rows drop whole facts behind an ellipsis instead of
  clipping mid-number, permission overlays show the parked call's target
  (including worker escalations, sanitized at the trust boundary), and
  blocked or aborted tool calls settle instead of spinning forever.
- Fixed accounting: aborted turns keep their real token usage, headless run
  receipts sum usage across all agent segments, guard blocks are recorded as
  blocked safety decisions, and worker tool-call caps count blocked attempts.
- Fixed session integrity across `/tree`, `/fork`, resume, and compaction so
  abandoned sibling turns are never replayed, copied, or summarized.
- Hardened worker IPC: subprocesses drain stdout before exit, streaming no
  longer amplifies quadratically, and internal generator dispatches (wiki
  update, context bootstrap) get a wall-clock deadline with progress output.
- Updated the model catalog: the Qwopus3.6 Coder entries carry the upstream
  presence-penalty sampler default, and reasoning-never model families no
  longer receive or replay thinking fields.
- Aligned the documentation corpus with v0.2.8, added worker-dispatch and
  provider-adapter guides, and refreshed the HTML docs viewer with new
  interactive blueprints.
- Breaking: legacy tool names such as `glob`, `workspace_context`,
  `docs_search`, `run_task`, `validate_frontend`, `write_plan`,
  `write_review`, `create_skill`, and `dispatch_batch` were removed in favor of
  the consolidated tool surface.

## 0.2.7 - 2026-07-02

- Added five reviewed marketplace skills: `scientific-debugging`,
  `experiment-protocol`, `design-council`, `credentials`, and
  `workflow-distiller`.
- Added executable skill evals, enforced skill tool surfaces, and registry
  integrity pins for catalog skills.
- Added credential damage control with zero-access credential storage,
  secret-value redaction in evidence bundles, and a read-only
  `credential_present` tool.
- Added `clio usage report`, headless main-agent receipts, dispatch evidence
  bundles, high-rigor validation prompts, and evidence-linked change manifests.
- Reduced package size, tightened the release workflow, refreshed
  documentation, and fixed several dispatch, lifecycle, skill, and loop-guard
  reliability issues.

## 0.2.6 - 2026-06-24

- Added VRAM-aware local model residency so interactive, headless, and worker
  runs reconcile model load/evict behavior through one path.
- Added first-class customization surfaces: layered project settings,
  path-scoped rules, operator profiles, user hooks, and `clio config inspect`.
- Added self-orientation through the `docs_search` tool and `clio docs`
  viewer.
- Added SciCode benchmark support, coverage gates, deterministic repeat lanes,
  and refreshed guides and HTML blueprints.
- Fixed a dispatched-run residency gap that could leave Ollama models resident
  and overflow VRAM.

## 0.2.5 - 2026-06-23

- Added the `alcf` runtime for Argonne ALCF Sophia/Metis inference targets over
  Globus OAuth.
- Added ALCF model metadata, gateway-specific documentation, authenticated
  provider discovery, and strict OpenAI-compatible payload handling.
- Added contract coverage for ALCF OAuth selection, runtime discovery, and
  strict reasoning-payload behavior.

## 0.2.4 - 2026-06-23

- Added agent fleet management with agent-to-profile bindings, profile CRUD,
  fault-tolerant dispatch, and a `/fleet` overlay.
- Isolated dispatch tests from the real run ledger and pinned several dispatch
  invariants with regression coverage.
- Made receipt digests deterministic across hosts and refreshed the pi engine,
  Claude SDK, Anthropic SDK, Biome, TypeBox, undici, uuid, and tsx
  dependencies.

## 0.2.3 - 2026-06-17

- Rebuilt the interactive command surface around a declarative slash-command
  registry and full-screen hubs for help, agents, prompts, extensions, targets,
  skills, settings, and receipts.
- Introduced the enforced autonomy model with an always-on safety net, clearer
  approval and safety notices, and stricter tool admission across chat,
  workers, headless runs, and ACP delegations.
- Added subscription and delegation runtimes including `anthropic-max`,
  `claude-code`, `claude-sdk`, Claude Code over ACP, and `antigravity-code`
  workers.
- Added `clio context-index`, deterministic multi-language codewiki indexing,
  `code_nav`, scratch offloading for large tool results, middleware hooks, live
  agent steering, and richer receipt tool activity.
- Reworked Clio's on-disk roots, settings ownership, lifecycle commands,
  model-target vocabulary, and observability workflows.
- Removed several legacy slash commands; their workflows moved into `/skill`,
  `/targets`, `/help`, `/view`, and related hubs.

## 0.2.2 - 2026-06-11

- Retired built-in CLI-subprocess runtimes in favor of direct HTTP/native/pi-ai
  targets and ACP delegation for external coding agents.
- Added the context engine, single-threshold compaction, bounded tool results,
  prompt-cache telemetry, and session-owned live routing.
- Added `clio acp`, ACP delegation support, a curated skills marketplace,
  richer skill activation, and local source install/uninstall scripts.
- Upgraded `CLIO.md` into a project rulebook with custom sections and better
  source-tree awareness.
- Improved prompt-prefix stability, session-ledger append behavior, permission
  overlays, and release verification.

## 0.2.1 - 2026-06-05

- Added live token-throughput telemetry, a larger context fill bar, hashed
  prompt-envelope delivery, and prompt diagnostics in `clio run --json`.
- Narrowed per-turn tool exposure and bounded long tool outputs to reduce
  context pressure.
- Retuned the footer dashboard for smaller terminals and refreshed README and
  operator documentation.
- Fixed headless `clio run` argument handling, unknown-agent failures,
  dashboard layout, and prompt-diagnostic visibility.

## 0.2.0 - 2026-06-03

- First community alpha release for source-checkout users.
- Added JIT skills, stronger prompt compaction, `clio init` / `/init`
  adoption of existing project instruction files, and centralized runtime
  target resolution.
- Added runtime diagnostics, command-output routing, durable session JSONL
  coverage, expanded user docs, and a portable `Ctrl+G` leader-key fallback.
- Hardened path policy handling, headless `clio run`, prompt cache boundaries,
  overlay rendering, session persistence, fork replay, and TUI startup.

## 0.1.9 - 2026-05-17

- Added `dispatch` as a first-class fleet-agent handoff tool.
- Added `validate_frontend` for HTML/CSS/JavaScript artifacts and finish
  evidence for typed validation tools.
- Improved local model capability handling, GPT-OSS/Harmony parsing, active-run
  follow-ups, and cancellation behavior.
- Fixed reasoning replay, Harmony stream parsing, OpenAI Codex file-tool
  schema aliases, lifecycle metadata repair, and duplicate model-capability
  paths.

## 0.1.8 - 2026-05-11

- Added extensions, share archives, extension and share CLI/TUI workflows, and
  a redesigned welcome dashboard.
- Added model and context-window validation to `clio configure`.
- Added a Claude Code SDK safety bridge, supervised approval IPC, a TUI
  approval overlay, and receipt accounting for SDK safety decisions.
- Fixed Gemini CLI token accounting and expanded tests for extensions, share
  archives, configure validation, and supervised SDK decisions.

## 0.1.7 - 2026-05-11

- Added a shared safety policy engine for orchestrator and native workers.
- Added strict project command policy parsing, typed execution tools, and
  receipt safety summaries.
- Changed default-mode Bash to default-deny ordinary execution unless allowed
  by curated commands or project policy.
- Hardened dispatch scope, external-runtime permission mapping, audit rows,
  and worker safety parity.

## 0.1.6 - 2026-05-04

- Added `clio --print` / `clio -p` for one non-interactive orchestrator turn.
- Added stdin plus argv prompt composition and stdout guarding for scriptable
  print-mode use.
- Reserved future JSON/RPC modes behind explicit errors and added focused CLI
  coverage.

## 0.1.5 - 2026-05-03

- Public alpha release for developers and research-software teams testing a
  terminal-first coding agent from source.
- Shipped the interactive TUI, target-first configuration, built-in coding
  agents, persistent sessions, project context, receipts, audit logs, evidence,
  evals, memory, and safety modes as an integrated product surface.
- Added `clio init`, CLIO.md parsing, codewiki indexing, clearer `/cost`
  accounting, a redesigned `/model` popup, and CLIO-branded popup frames.
- Documented alpha limits: source install remained the supported path, model
  behavior varied by target, and operators were expected to review privileged
  actions.

## 0.1.4 - 2026-04-30

- Added the evolution plane: component inventory, typed change manifests,
  deterministic evidence building, local eval runs, memory records, middleware
  hooks, protected-artifact safety, and finish-contract checks.
- Added workspace orientation, a `workspace_context` tool, eight specialist
  agent recipes, and a scientific-validation pack.
- Unified llama.cpp runtime handling, improved the TUI, expanded compaction and
  context accounting, and hardened protected-artifact behavior.

## 0.1.3 - 2026-04-27

- Added live tool output, bash command echo, `Ctrl+T` thinking expansion, and a
  git-branch footer slot in the TUI.
- Made `CLIO.md` the canonical project instruction file and improved local
  runtime detection for LM Studio and Ollama.
- Aligned Clio Coder's identity with IOWarp's CLIO ecosystem, updated package
  docs, reorganized safety rule packs, and added a clean-clone smoke CI job.
- Fixed slash autocomplete on Debian/Ubuntu, stabilized JSON envelopes for
  `doctor` and `targets`, and improved partial tool-output rendering.

## 0.1.2 - 2026-04-25

- Added visible retry handling for transient provider and stream failures.
- Improved tool, bash, edit, dashboard, hotkey, resume, prompt, receipt,
  compaction, audit, and abort behavior in the interactive TUI.
- Fixed retry duplication, cancellation races, oversized Bash output handling,
  resume/fork/new behavior during active runs, provider hot-swaps, and local
  OpenAI-compatible reasoning/tool schemas.

## 0.1.1 - 2026-04-24

- Added deterministic loading of project context files from the current working
  directory upward.
- Fixed resume, fork, and tree-switch replay for rich session entries and
  durable tool records.
- Fixed subprocess worker dispatch, out-of-tree SDK runtime rehydration,
  receipt verification, dispatch heartbeat state, and the documented boundary
  check command.

## 0.1.0-exp - 2026-04-24

- Initial experimental public release.
- Shipped the interactive TUI, CLI lifecycle commands, target-first
  configuration, runtime coverage, seven built-in agents, dispatch workers,
  receipts, audit logs, safety modes, and XDG-aware state layout.
- Known limits: Windows was best effort, and some remote fan-out and MCP
  surfaces were scaffolded but not yet admitted by dispatch.
