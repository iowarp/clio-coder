# Clio-Coder v0.1 Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each phase plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Clio-Coder v0.1 per `docs/specs/2026-04-16-clio-coder-design.md` as a Level-3 custom harness on pi-mono, rebuilt clean from PanCode IP, with 13 manifest-driven domains and 8 worker adapters.

**Architecture:** Single-package TypeScript 5.7 strict project. `src/engine/**` is the sole pi-mono import boundary. `src/worker/**` is physically isolated from `src/domains/**`. Composition root at `src/entry/orchestrator.ts`. All domains load via topological sort from manifests.

**Tech Stack:** Node ≥20, TypeScript 5.7, tsup, Biome, `@mariozechner/pi-agent-core@0.67.4`, `@mariozechner/pi-ai@0.67.4`, `@mariozechner/pi-tui@0.67.4`, `@sinclair/typebox`, `yaml`, `chalk`, `undici`.

---

## Why this is a roadmap, not one plan

The spec defines ~29KLOC of target output across 13 domains, 8 worker adapters, a full TUI, a custom session format, fragment-based prompt compilation, and multi-tier dispatch. A single plan at bite-sized granularity (2-5 minute steps, full code in every step) runs to thousands of tasks and is unreadable before it is useful.

The work breaks cleanly into 10 phases along dependency lines. Each phase produces working, verifiable software on its own, and each phase has a dedicated detailed plan document written when that phase begins. This roadmap is the spine: phase goals, dependencies, exit criteria, and the estimated task count so we can track burn-down across v0.1.

**Phase plans live next to this document:**
- `2026-04-16-clio-coder-phase-1-foundation.md` — written up front (ready to execute)
- `2026-04-16-clio-coder-phase-2-safety-modes.md` — written when Phase 1 lands
- (and so on through Phase 10)

Writing phase plans just-in-time lets each plan reference the concrete file contents produced by prior phases rather than speculating about interfaces.

---

## Pre-Phase-1 gate — pi-mono 0.67.4 public-API audit

Before Phase 1 Part A runs, an engineer must produce `docs/architecture/pi-mono-boundary-0.67.4.md` documenting the exact public surface the engine layer will re-export. The audit freezes:

- `@mariozechner/pi-agent-core`: `Agent` class, `AgentOptions` interface, `AgentState` interface, lifecycle methods, event callback signatures
- `@mariozechner/pi-ai`: `registerBuiltInApiProviders()`, `getProviders()`, `getModel()`, `getModels()`, cost helpers, provider option types
- `@mariozechner/pi-tui`: `TUI` class, layout primitives, component exports, keybinding constants

This audit exists because the first version of this roadmap (and Phase 1 plan) inlined guessed symbol names that diverged from the real 0.67.4 API. Phase 1 Part 0 (newly inserted) carries this audit as Task 0 before any code is written against pi-mono.

Scope rule: if a new pi-mono primitive is needed mid-phase, update the audit document and add a task to extend `src/engine/types.ts` accordingly. No ad-hoc imports anywhere else.

---

## Platform scope for v0.1

**Supported in CI:** Linux (ubuntu-latest) and macOS (macos-14). Both exercise the `npm run ci` chain (typecheck, lint, boundaries, prompts, build, verify) on every push.

**Best-effort:** Windows. The `xdg.ts` module includes a Windows branch for `APPDATA`/`LOCALAPPDATA` paths because XDG is a Linux concept that shouldn't bleed onto other platforms, but the verify script and CI matrix are not Windows-hardened in v0.1. Windows CI job and shell-agnostic verification land in v0.2.

**Out of scope:** WSL1, 32-bit platforms, Node < 20.

Claiming Linux-only would be a regression from PanCode's cross-platform posture. Claiming full Windows support without a CI job exercising it would be a lie. The middle path — code that compiles on Windows, a non-hardened verify script, and an explicit deferral — is the honest position.

---

## Phase dependency graph

```
Phase 1 Foundation
  ├── Phase 2 Safety & Modes
  │     └── Phase 3 Prompts & Session
  │           └── Phase 4 Providers & Agents
  │                 └── Phase 5 Core Tools
  │                       └── Phase 6 Dispatch & Native Worker (headless)
  │                             ├── Phase 7 CLI Adapter Fleet
  │                             └── Phase 8 Claude SDK Subprocess
  │                                   └── Phase 9 Interactive TUI
  │                                         └── Phase 10 Observability, Scheduling, Polish
```

Phases 7 and 8 can run in parallel after Phase 6.

**Critical-path rationale (post-Codex-review, 2026-04-16):** the first roadmap version sequenced TUI before dispatch, which hid the product's highest-risk plumbing (worker spawn, NDJSON streaming, heartbeat, receipts, shutdown) behind 90 tasks of UI work. For a subprocess-orchestration product, dispatch is the critical path. Phase 6 now lands a headless `clio run <agent> <task>` CLI surface that exercises the full native-worker lifecycle. The TUI (Phase 9) then builds on a working orchestration core with real data to render.

---

## Phase 1 — Foundation

**Depends on:** —

**Produces:**
- `package.json`, `tsconfig.json`, `biome.json`, `tsup.config.ts`, `.gitignore`, CI workflow
- `scripts/check-boundaries.ts`, `scripts/check-prompts.ts` (skeleton), `scripts/verify.ts`
- `src/core/` — xdg, package-root, event-bus, shared-bus, bus-events, startup-timer, termination, concurrency, domain-loader, tool-names, agent-profiles, config, defaults, init
- `src/engine/` — types, ai, agent, tui, session (stub), tools, index
- `src/domains/config/` and `src/domains/lifecycle/` — both fully loading via manifest
- `src/cli/` — index, shared, version, doctor, install, clio (interactive placeholder)
- `src/entry/orchestrator.ts`

**Exit criteria:**
- `npm run typecheck` green
- `npm run build` produces a working `dist/cli/index.js`
- `clio --version` prints package version
- `clio doctor` prints Node version, Clio version, pi-mono version, and the resolved XDG/Clio paths
- `clio install` bootstraps the resolved config/data/cache tree (`sessions/`, `audit/`, `state/`, `cache/`, `agents/`, `prompts/`, `receipts/`, `install.json`, `settings.yaml` from defaults)
- `clio` (no args) boots orchestrator, shows banner, exits cleanly (interactive loop stub)
- `npm run check:boundaries` passes (no pi-mono imports outside `src/engine/`; no `src/worker/` imports from `src/domains/`)
- `npm run verify` runs the three commands above and exits 0
- CI runs typecheck, build, boundary check, prompt check, and verify on push

**Plan document:** `2026-04-16-clio-coder-phase-1-foundation.md` (ready now)

**Estimated tasks:** ~60

---

## Phase 2 — Safety & Modes

**Depends on:** Phase 1

**Produces:**
- `src/domains/safety/` — action-classifier, scope, audit, rejection-feedback, loop-detector, damage-control, manifest, extension, index
- `src/domains/modes/` — matrix, state, manifest, extension, index
- `damage-control-rules.yaml` seed committed to repo
- `src/tools/registry.ts` — tool registry with mode gating as the admission point
- Bus events: `safety.classified`, `safety.blocked`, `safety.allowed`, `mode.changed`

**Exit criteria:**
- `ActionClassifier.classify(call)` returns deterministic `ActionClass` for fixture inputs (verified via `scripts/diag-safety.ts`)
- Audit trail writes NDJSON to `<dataDir>/audit/YYYY-MM-DD.jsonl` on every classified call
- Mode matrix enforces `advise` tool set when mode is advise (dispatch-agent readonly only)
- `super` mode entry raises a confirmation event
- Hard blocks (`system_modify`, `git_destructive`) reject regardless of mode
- `npm run verify` exercises at least one allowed and one blocked path

**Plan document:** `2026-04-16-clio-coder-phase-2-safety-modes.md` (write when starting Phase 2)

**Estimated tasks:** ~55

---

## Phase 3 — Prompts & Session

**Depends on:** Phase 2

**Produces:**
- `src/domains/prompts/` — compiler, hash, fragments/{identity,modes,safety,providers,session}/*.md, manifest, extension, index
- `src/domains/session/` — manager, checkpoint, history, manifest, extension, index
- `src/engine/session.ts` — full Clio JSONL writer/reader (tree-structured with id + parentId)
- `scripts/check-prompts.ts` — full version (validates every fragment header, every composition hashes stably)

**Exit criteria (reproducibility contract — two hashes, not one):**
- `PromptCompiler.compile({identity, mode, safety, providers, session})` returns `{ text, staticCompositionHash, renderedPromptHash, fragmentManifest, dynamicInputs }`
  - `staticCompositionHash` — SHA-256 over the fragment manifest (file paths + file content hashes) for the static fragments. Stable across turns for identical fragment selection.
  - `renderedPromptHash` — SHA-256 over the fully rendered prompt text for this turn. Varies per turn when `providers/dynamic.md` or `session/dynamic.md` change.
  - `dynamicInputs` — canonical JSON of the inputs fed into the dynamic fragments on this turn (provider/model context, session notes snapshot). Persisted to the session JSONL and the receipt so a replay can reconstruct the rendered prompt.
- Session JSONL round-trips: write turns → close → reopen via `SessionManager.resume(id)` rehydrates identical state including the dynamic inputs per turn
- `<dataDir>/sessions/<cwd-hash>/current.jsonl` and `tree.json` written atomically (tmp + fsync + rename)
- `check-prompts.ts` catches duplicate fragment IDs, unknown template variables, and budget overruns
- `/checkpoint` and `/resume` primitive callable via diag script

**Plan document:** `2026-04-16-clio-coder-phase-3-prompts-session.md`

**Estimated tasks:** ~70

---

## Phase 4 — Providers & Agents

**Depends on:** Phase 3

**Produces:**
- `src/domains/providers/` — discovery, health, catalog, matcher, credentials, runtimes/{anthropic,openai,google,groq,mistral,openrouter,bedrock,local}.ts, manifest, extension, index
- `src/domains/agents/` — recipe, registry, teams, skills, frontmatter, fleet-parser, manifest, extension, index
- `<configDir>/credentials.yaml` writer (mode 0600) + OS keychain fallback
- Builtin agent fleet files in `src/domains/agents/builtins/`: scout, planner, worker, reviewer, context-builder, researcher, delegate

**Exit criteria:**
- `ProviderRegistry.list()` returns configured providers with health status
- Credentials file created with 0600 mode, never referenced in `settings.yaml`
- `AgentRegistry.load()` discovers both `<dataDir>/agents/*.md` and `.clio/agents/*.md`, parses YAML frontmatter per pi-subagents convention
- Fleet parser handles `-> ` separator and `[key=value]` inline config
- `/providers` and `/agents` overlay stubs render list data (real overlays land in Phase 6)

**Plan document:** `2026-04-16-clio-coder-phase-4-providers-agents.md`

**Estimated tasks:** ~80

---

## Phase 5 — Core Tools

**Depends on:** Phase 4

**Produces:**
- `src/tools/read.ts`, `write.ts`, `edit.ts`, `bash.ts`, `grep.ts`, `glob.ts`, `ls.ts`, `web-fetch.ts`, `web-search.ts`
- `src/tools/write-plan.ts` and `src/tools/write-review.ts` — path-constrained to `PLAN.md` / `REVIEW.md` at project root
- `src/tools/dispatch-agent.ts`, `batch-dispatch.ts`, `chain-dispatch.ts` — tool-facing stubs that enqueue jobs for the dispatch domain (Phase 7)
- Registry wiring: each tool declares its `ActionClass` and `allowedModes`

**Exit criteria:**
- Each tool has a corresponding diag script that exercises it in isolation
- `write_plan` with a path argument other than `PLAN.md` returns a tool error (path rejection is structural, not prompt-based)
- Mode gate filters the registry: in `advise`, attempts to call `write` fail at registry lookup (model never sees the tool)
- `bash` respects damage-control rules from Phase 2

**Plan document:** `2026-04-16-clio-coder-phase-5-core-tools.md`

**Estimated tasks:** ~65

---

## Phase 6 — Dispatch & Native Worker (headless)

**Depends on:** Phase 5

**Rationale:** exercise the highest-risk plumbing (worker spawn, NDJSON streaming, heartbeat, receipts, shutdown) through a non-TUI CLI surface before building the interactive layer.

**Produces:**
- `src/domains/dispatch/` — worker-spawn, state (run ledger), routing, primitives, validation, backoff, batch-tracker, resilience, manifest, extension, index
- `src/worker/entry.ts` — native worker subprocess entry
- `src/engine/worker-runtime.ts` — pi-agent-core wiring for worker-side execution (engine-boundary-compliant; replaces pancode's safety-ext exception)
- `src/worker/provider-bridge.ts`, `src/worker/heartbeat.ts`
- `src/cli/run.ts` — headless `clio run <agent> <task>` surface: spawns worker, streams NDJSON to stdout, prints receipt, exits with worker's status
- `scripts/diag-bootstrap.ts`, `diag-orchestrator.ts`, `diag-prompt.ts`, `diag-single-dispatch.ts`, `diag-worker-tools.ts`, `stress.ts`
- `<dataDir>/state/runs.json` atomic writer

**Exit criteria:**
- `clio run <agent> '<task>'` spawns a native worker subprocess, streams NDJSON events to stdout, produces a receipt on exit, updates the run ledger, returns the worker's exit code
- Admission gate rejects workers whose requested permissions exceed the orchestrator's active scope (verified via diag)
- Heartbeat marks workers as `stale` after timeout and `dead` after grace period (verified by killing a worker mid-run)
- `scripts/stress.ts` spawns 10 concurrent workers; every one completes with a valid receipt or terminates cleanly with an interruption marker
- Shutdown sequence kills active workers with SIGTERM, 3s grace, SIGKILL, and marks ledger entries as interrupted
- Engine boundary holds: `npm run check:boundaries` passes with no exceptions

**Plan document:** `2026-04-16-clio-coder-phase-6-dispatch-native-worker.md`

**Estimated tasks:** ~120 (up from 110 — now includes the CLI surface and engine worker-runtime)

---

## Phase 7 — CLI Adapter Fleet

**Depends on:** Phase 6

**Produces:**
- `src/worker/cli-entry.ts` — generic CLI worker wrapper
- `src/domains/providers/runtimes/cli/` — pi-coding-agent, claude-code, codex, gemini, opencode, copilot adapters
- Per-adapter capability manifest (supports `--help`, supports structured output, silver vs bronze telemetry)

**Exit criteria:**
- Each of the 6 CLI adapters passes `scripts/diag-single-dispatch.ts --runtime <name>` with a smoke task
- Capability manifest correctly reports silver vs bronze telemetry
- CLI adapters run under the same mode gate + audit as native workers
- `clio run --runtime <name> <agent> '<task>'` works end-to-end for every adapter

**Plan document:** `2026-04-16-clio-coder-phase-7-cli-adapters.md`

**Estimated tasks:** ~55

---

## Phase 8 — Claude SDK Subprocess

**Depends on:** Phase 6 (can run in parallel with Phase 7)

**Produces:**
- `src/worker/sdk-entry.ts` — Claude Agent SDK subprocess worker
- `src/domains/providers/runtimes/claude-sdk.ts` — SDK adapter with structured I/O, tool hooks, session resume

**Exit criteria:**
- `scripts/diag-single-dispatch.ts --runtime claude-sdk` passes with a smoke task
- Structured tool hooks emit events the orchestrator receives over the dispatch bus
- Gold-tier telemetry (token, turn, duration, per-tool accounting) appears in the receipt

**Plan document:** `2026-04-16-clio-coder-phase-8-claude-sdk.md`

**Estimated tasks:** ~40

---

## Phase 9 — Interactive TUI

**Depends on:** Phase 7 and Phase 8

**Produces:**
- `src/interactive/` — index (ClioInteractiveMode), layout, chat-panel, editor-panel, footer-panel, overlay-manager, slash-router, keybinding-manager
- `src/interactive/renderers/` — per-tool render components
- `src/interactive/components/` — SelectList/SettingsList/BorderedLoader/custom primitives that wrap pi-tui components
- `src/interactive/overlays/` — settings, providers, models, presets, theme, mode, agents, skills, dispatch-board (live), cost (live), receipts (live — real data from Phase 6-8 receipts)
- `src/domains/ui/` — banner, widgets/, dashboard-board, command-palette, theme, identity

**Exit criteria:**
- `clio` launches to prompt with Clio banner, footer shows mode + model + cost
- `Shift+Tab` cycles default ⇄ advise, footer updates within 100ms
- `Alt+S` enters super mode via confirmation overlay
- `Ctrl+P` / `Ctrl+Y` / `Ctrl+R` cycle model / safety / reasoning
- `Esc Esc` opens session tree navigator
- `/` and `:` open slash and command palette respectively
- `/run <agent> <task>` dispatches through the working Phase 6 core and streams live updates into the chat panel
- Every slash command in the surface (`/help`, `/about`, `/version`, `/quit`, `/clear`, `/reload`, `/clio-settings`, `/providers`, `/models`, `/presets`, `/theme`, `/mode`, `/safety`, `/audit`, `/reset`, `/checkpoint`, `/history`, `/new`, `/resume`, `/fork`, `/compact`, `/agents`, `/skills`, `/runs`, `/batches`, `/stoprun`, `/cost`, `/budget`, `/doctor`) works against real domain state
- `Ctrl+D` shutdown honors the DRAIN → TERMINATE → PERSIST → EXIT sequence and terminates active workers correctly

**Plan document:** `2026-04-16-clio-coder-phase-9-interactive-tui.md`

**Estimated tasks:** ~95 (up from 90 — adds live overlay wiring that was stubbed in the pre-resequencing version)

---

## Phase 10 — Observability, Scheduling, Polish

**Depends on:** Phase 9

**Produces:**
- `src/domains/observability/` — telemetry, metrics, receipts, cost, health, manifest, extension, index
- `src/domains/scheduling/` — budget, concurrency, cluster (scaffold), cluster-transport (scaffold), manifest, extension, index
- `src/domains/intelligence/` — contracts, intent-detector, solver, speculative, reconciler, learner (all scaffolded, disabled by default)
- `src/domains/lifecycle/` — upgrade, uninstall, migrations/ filled in
- `src/interactive/overlays/dispatch-board.ts`, `cost.ts`, `receipts.ts` — fully wired live overlays
- `src/domains/ui/dashboard-board.ts` — live widgets
- `scripts/verify.ts` — full end-to-end exercise of every command, every overlay, every mode transition

**Exit criteria:**
- `scripts/verify.ts` green in CI
- `npm run smoke` completes 60-second boot/dispatch/shutdown cycle
- Budget gate blocks new dispatch when ceiling is hit; overlay confirms
- Dashboard board overlay shows live workers with health status
- Cost overlay shows per-provider and per-session totals
- Receipts overlay opens a receipt and `/receipt verify <id>` re-validates
- Intelligence domain loads manifest, subscribes to bus, emits zero observations by default
- `clio upgrade` replaces the installed version and re-runs migrations
- Release tag `v0.1.0` on green CI

**Plan document:** `2026-04-16-clio-coder-phase-10-observability-polish.md`

**Estimated tasks:** ~120

---

## Cross-phase task budget

| Phase | Tasks (est.) | Cumulative |
|---|---:|---:|
| 1 Foundation | 66 | 66 |
| 2 Safety & Modes | 55 | 121 |
| 3 Prompts & Session | 70 | 191 |
| 4 Providers & Agents | 80 | 271 |
| 5 Core Tools | 65 | 336 |
| 6 Dispatch & Native Worker (headless) | 120 | 456 |
| 7 CLI Adapter Fleet | 55 | 511 |
| 8 Claude SDK Subprocess | 40 | 551 |
| 9 Interactive TUI | 95 | 646 |
| 10 Observability & Polish | 120 | 766 |

### Honest effort estimate (P50 / P90)

The earlier roadmap claimed "~43 focused hours" by pricing every task at 3.5 minutes net coding. That ignored the plan's own embedded overhead (typecheck runs, boundary checks, builds, commits) and every form of debugging, rework, review, and context recovery that happens in practice. The Codex adversarial review (2026-04-16) called this out as planning theatre, and it was right.

A more honest reconstruction:

| Cost element | Per task (P50) | Per task (P90) |
|---|---:|---:|
| Net coding + inline code reading | 3.5 min | 6 min |
| Typecheck / boundary / verify runs | 1.5 min | 3 min |
| Debugging, rework, minor design shifts | 3 min | 8 min |
| Review, checkpoint discussion, context recovery | 2 min | 4 min |
| **Total per task** | **10 min** | **21 min** |

Applied to 766 tasks:
- **P50:** ~128 focused hours (~16 eight-hour days)
- **P90:** ~268 focused hours (~34 eight-hour days)

P50 and P90 diverge because ~15% of tasks (engine boundary, dispatch spawn, heartbeat, shutdown coordination, hot-reload classification, prompt hash determinism) carry hidden complexity that surfaces only during implementation. Those tasks routinely consume 3-5× their nominal budget.

**What to do with this estimate:**
- Do not promise v0.1 delivery in under four focused weeks of engineering. Two calendar months with part-time attention is the honest floor.
- After Phase 1 lands, re-measure: record actual elapsed time per task and recalibrate the remaining phases.
- If P50 at Phase 3 or Phase 6 is trending past the budget, cut scope — every feature in §22 ("Deferred to Post-v0.1") is a candidate to push back further, and Phase 10 scaffolded domains (intelligence, cluster) can stay empty longer.

---

## Invariants enforced every phase

These are the three hard invariants from design spec §3. Every phase plan must restate its exit criteria in terms of these.

1. **Engine boundary.** `scripts/check-boundaries.ts` passes on every commit. Only `src/engine/**` imports from `@mariozechner/pi-*`. **No exceptions.** The pancode pattern of whitelisting `src/worker/safety-ext.ts` is explicitly rejected: Clio's worker-side pi-mono usage goes through `src/engine/worker-runtime.ts` (introduced in Phase 6), which is inside the engine boundary. If a future worker file needs a pi primitive, it imports an engine-owned wrapper, not pi-mono directly.
2. **Worker isolation.** `src/worker/**` never imports from `src/domains/**`. The boundary script checks this explicitly. Shared types between orchestrator and worker (dispatch-event shapes, receipt schemas) live in `src/contracts/**`, which is allowed on both sides.
3. **Domain independence — structural, not conventional.** No domain mutates another domain's state. Cross-domain traffic flows through either `SafeEventBus` (for fire-and-forget events) or `DomainContract` instances (for query-only access). The domain loader hands consumers a typed contract, not the extension. Extensions are private. A separate boundary rule (landed in Phase 1 Task 9) forbids importing `src/domains/<x>/extension.ts` from `src/domains/<y>/**`.

If any phase produces work that violates an invariant, the phase is not complete. No exceptions, no policy flags, no "temporary" bypasses.

## Codex adversarial review — 2026-04-16

This roadmap received an adversarial review from Codex (gpt-5.4 xhigh) immediately after the initial draft. The review flagged eight findings, seven of which were adopted wholesale into this document and the Phase 1 plan; one was adapted (Windows support deferred explicitly to v0.2 rather than either removed or hardened).

| # | Finding | Disposition |
|---|---|---|
| 1 | Pi-mono API symbols in Phase 1 were invented, not real | Fixed: added pre-Phase-1 audit; rewrote Phase 1 Tasks 27-30 |
| 2 | `DomainContext.getDependency` returns live extensions (god-object risk) | Fixed: replaced with `DomainContract` pattern in Phase 1 Task 24; added Invariant 3 structural language above |
| 3 | `safety-ext.ts` engine-boundary exception degrades the invariant | Fixed: removed the exception; introduced `src/engine/worker-runtime.ts` in Phase 6 to own worker-side pi-mono |
| 4 | TUI-before-dispatch is the wrong critical path | Fixed: swapped Phase 6 (was TUI) and Phase 7 (was dispatch); Phase 6 is now headless dispatch via `clio run <agent> <task>`, TUI is Phase 9 |
| 5 | Config watcher fires event but never refreshes snapshot; no hot-reload matrix | Fixed: Phase 1 Task 40 now re-reads + classifies + emits typed events (`config.hotReload`, `config.nextTurn`, `config.restartRequired`) |
| 6 | Prompt reproducibility can't be "stable hash" + "per-turn dynamic" simultaneously | Fixed: Phase 3 exit criteria now require two hashes (static composition + rendered prompt) and persisted dynamic inputs |
| 7 | Windows claimed in Phase 1 but never CI-tested | Adapted: "Platform scope for v0.1" section above explicitly defers Windows CI to v0.2; v0.1 CI is Linux + macOS only |
| 8 | 43-hour budget is planning theatre | Fixed: "Honest effort estimate" section above shows P50 ~128h, P90 ~268h |

---

## Execution handoff

**Two execution options once Phase 1 plan is reviewed:**

1. **Subagent-Driven (recommended for Phase 1)** — dispatch a fresh subagent per task, review between tasks. Keeps the planner agent's context clean and enables fast iteration on tight scaffolding steps.
2. **Inline Execution** — execute tasks in this session with checkpoint reviews every ~10 tasks. Faster for interactive tuning but burns main context.

Phases 2+ inherit the same choice. Switch modes between phases if helpful.
