# Clio-Coder v0.1 — Design Plan

- **Status:** Approved (brainstorming complete)
- **Date:** 2026-04-16
- **Author:** akougkas (Anthony Kougkas) + Claude (Opus 4.7)
- **Repo:** `~/projects/iowarp/clio-coder`
- **Reference material:** `~/projects/pancode` (PanCode v0.3.0 — IP source, not code source), `~/tools/pi-mono` (engine foundation), `~/tools/pi-subagents` (dispatch reference), `~/projects/pancode/__NUKED/.planning/example-ref-extensions` (concept seeds)

---

## Table of Contents

1. Thesis
2. Engine Strategy — Level 3 Custom Harness
3. Three Hard Invariants
4. Pan-Everything Axes
5. Domain Architecture (13 domains)
6. Runtime Adapter Tiers
7. Three Modes
8. Safety Model
9. Prompt Compilation
10. Session and Reproducibility
11. Observability
12. Scheduling and Budget
13. Configuration Model
14. Slash Command Surface
15. Keybindings
16. Repository Layout
17. Boot and Shutdown
18. State Ownership Matrix
19. What We Port from PanCode
20. Inspiration from pi-subagents and ref-extensions
21. Verification Strategy
22. Deferred to Post-v0.1
23. Identity Summary

---

## 1. Thesis

Clio-coder is the orchestrator layer of a distributed agentic harness. It is the brain, not the hands. The hands are workers — coding agents, science agents, device agents, anything that produces work under orchestration. Clio discovers providers, composes agents, dispatches work under a unified safety model, observes everything, and surfaces it through one disciplined TUI. The product is the runtime. Agents are guests.

Clio-coder v0.1 ships the full orchestrator at the ambition level of PanCode v0.3.0, rebuilt clean on Level 3 of pi-mono, under the IOWarp Clio brand. Scientific and HPC specialization layer in as later releases without restructuring. Everything PanCode got right stays. Everything PanCode got wrong (god objects, dual SDK paths, scope creep in the wrong places) is excised structurally, not by policy.

The differentiator is sufficiency for scientific and HPC coding, where generic coding agents (Claude Code, Codex) fail on complexity, security posture, and reproducibility demands. v0.1 establishes the orchestration foundation; specialization follows as domain extensions.

## 2. Engine Strategy — Level 3 Custom Harness

Three pi-mono packages as direct npm dependencies, pinned at exact version:

```json
{
  "dependencies": {
    "@mariozechner/pi-agent-core": "0.67.4",
    "@mariozechner/pi-ai": "0.67.4",
    "@mariozechner/pi-tui": "0.67.4",
    "@sinclair/typebox": "^0.34.x",
    "yaml": "^2.x",
    "chalk": "^5.x",
    "undici": "^7.x"
  }
}
```

**No dependency on `@mariozechner/pi-coding-agent`.** Clio owns the agent loop wiring, interactive mode, slash commands, session format, prompt compilation, tool registry, and identity completely. Pi-coding-agent re-enters as one worker adapter among many (CLI tier), not as an engine.

**Why Level 3:** full control over slash commands (cannot remove or rename Pi's built-ins at Level 2), full control over TUI shape (enables future panel-first layouts for scientific/dashboard contexts), full control over session format (enables reproducibility engine without fighting Pi's format), full control over identity (no "pi" branding leaks anywhere), and no upstream ceiling for the Clio v1.0 vision.

**Upgrade discipline:** `src/engine/` is the sole directory that imports from `@mariozechner/pi-*`. A pi-mono minor-version bump changes only files in that directory. Upgrades are deliberate: branch, update exact version, fix breakage in `src/engine/` only, verify no domain file changes, merge when green.

## 3. Three Hard Invariants (enforced at build time)

1. **Engine boundary.** Only `src/engine/**` imports from pi-mono packages. Enforced by `scripts/check-boundaries.ts` in CI.
2. **Worker isolation.** `src/worker/**` never imports from `src/domains/**`. Workers are OS-isolated subprocesses with no shared memory, event loop, or file descriptors with the orchestrator.
3. **Domain independence.** Each domain owns its state. Cross-domain communication flows exclusively through `SafeEventBus`. No domain mutates another domain's state.

## 4. Pan-Everything Axes (preserved from PanCode's thesis)

| Axis | Meaning in Clio |
|---|---|
| **Pan-provider** | Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter, Bedrock, local engines (LM Studio, Ollama, llama.cpp, vLLM). Registered via `pi-ai`'s provider system. |
| **Pan-model** | Tiered model catalog (frontier/mid/fast). Capability routing. Fallback chains. |
| **Pan-agent** | Agent specs as markdown + YAML frontmatter (inspired by pi-subagents). Discovered from `.clio/agents/*.md` and `~/.clio/agents/*.md`. |
| **Pan-runtime** | Native Clio workers, plus CLI adapters for pi-coding-agent, claude-code, codex, gemini, opencode, copilot. Plus SDK-tier Claude Agent SDK in subprocess. |
| **Pan-safety** | Shared action classifier, audit trail, scope enforcement, mode gating, across every runtime. |
| **Pan-observe** | Unified cost, tokens, turns, wall time, receipts across every runtime. |

## 5. Domain Architecture (13 domains)

| # | Domain | Depends on | Owns | Exposes |
|---|---|---|---|---|
| 1 | **config** | — | `~/.clio/settings.yaml`, file watcher, schema | settings access, hot-reload bus events |
| 2 | **providers** | config | provider registry, model catalog, credentials, health | `/providers`, `/models`, health events |
| 3 | **safety** | config | audit trail, action classifier, scope rules, dangerous-command interception | safety gate on every tool call, `/audit` |
| 4 | **modes** | safety | current mode, tool allowlist matrix | `/mode`, Shift+Tab, Alt+S |
| 5 | **prompts** | config | identity + mode + safety + (future) scientific fragments, SHA-256 compilation | `before_agent_start` hook, compiled prompts with hashes |
| 6 | **session** | config | Clio session JSONL, checkpoint, resume, history | `/reset`, `/checkpoint`, `/history`, `/new`, `/resume` |
| 7 | **agents** | config | agent spec registry, recipes, teams, skills | `/agents`, `/skills`, agent discovery |
| 8 | **dispatch** | safety, agents, providers | worker spawn, run ledger, batch tracker, chain primitives, resilience, backoff, admission gating | `dispatch_agent` tool, `batch_dispatch` tool, `/runs`, `/batches`, `/stoprun` |
| 9 | **observability** | dispatch | telemetry, metrics, receipts, cost tracking, reproducibility manifests | `/cost`, `/receipts`, `/doctor` |
| 10 | **scheduling** | dispatch, agents | budget ceiling, concurrency limits, node registry (scaffolded), cluster transport (scaffolded) | `/budget`, `/cluster` |
| 11 | **intelligence** | dispatch, agents | intent detector, solver, learner, speculative (scaffolded, disabled by default) | event-driven observer only |
| 12 | **lifecycle** | config, providers | install metadata, version info, migrations, health checks | `clio install/doctor/upgrade/uninstall` CLI, `/doctor`, `/upgrade` in TUI |
| 13 | **ui** | dispatch, agents, session, scheduling, observability, modes, safety, providers | TUI layout, panels, overlays, custom footer, theme, slash command routing | every slash command ultimately routes here for rendering |

Manifest-driven loading: each domain exports `{ name, dependsOn }`. Topological sort at boot produces load order. Adding a domain is: create folder, write manifest, add to enabled list. Removing a domain is: remove from enabled list.

## 6. Runtime Adapter Tiers

Worker execution abstracts across three tiers. **All workers are subprocesses.** No in-process dispatch from day one.

| Tier | Examples | Control depth | Telemetry |
|---|---|---|---|
| **Native** | Clio worker (our own binary in worker mode, pi-agent-core based) | Full: prompts, tools, model, safety, events, NDJSON streaming | Platinum (we own the engine) |
| **SDK** | Claude Agent SDK (subprocess running the SDK in V2 session mode) | Deep: structured I/O, tool hooks, session resume | Gold |
| **CLI** | pi-coding-agent, claude-code, codex, gemini, opencode, copilot | Task + CWD + system prompt over subprocess | Silver/Bronze depending on streaming richness |

**v0.1 ships eight adapters:** Native (Clio), Claude SDK subprocess, pi-coding-agent CLI, claude-code CLI, codex CLI, gemini CLI, opencode CLI, copilot CLI.

**No dual in-process path.** PAN-SDK-V2's subprocess plan wins from day one. The 172 LOC SdkConcurrencyLimiter, the 80 LOC executeSdkWorker branch, the isSdkRuntime gate — never exist in Clio.

## 7. Three Modes

| Mode | Tool set | Entry |
|---|---|---|
| **default** (build/yolo) | read, write, edit, bash, grep, glob, ls, web_fetch, web_search, dispatch_agent, batch_dispatch, chain_dispatch | default at launch |
| **advise** | read, grep, glob, ls, web_fetch, web_search, write_plan (→ PLAN.md only), write_review (→ REVIEW.md only), dispatch_agent (readonly workers only) | `Shift+Tab` toggles default⇄advise |
| **super** | default + privileged ops (writes outside cwd, package installs, admin queries); `system_modify` and `git_destructive` still hard-gated | `Alt+S`, confirmation overlay on entry |

`write_plan` / `write_review` reject any path argument that does not resolve to `PLAN.md` / `REVIEW.md` at project root. This is a tool-level constraint, not prompt-level.

Mode state persists to settings.yaml under `state.lastMode`.

## 8. Safety Model

Structural, not prompt-based. Four layers:

1. **Mode gate.** Current mode's tool allowlist is applied at the tool registry level. If a tool is not in the active set, the model never sees it. Shift+Tab changes the visible surface mid-session.
2. **Action classifier.** Every tool call maps to an `ActionClass` (read, write, execute, system_modify, git_destructive, etc.). Classification is deterministic.
3. **Policy gate.** Per safety level (suggest, auto-edit, full-auto), each ActionClass is allowed, confirmation-gated, or blocked. Hard blocks: `system_modify`, `git_destructive`.
4. **Scope contract.** Worker permissions are a strict subset of orchestrator permissions. Privilege non-escalation enforced at dispatch admission.

Audit trail: every action (allowed or blocked) writes a structured entry to `~/.clio/audit/YYYY-MM-DD.jsonl` with correlation ID, reason code, redacted args.

## 9. Prompt Compilation

Fragment-based. Deterministic. Same input → same output → same SHA-256 hash.

```
identity/clio.md            ← "You are Clio, the orchestrator..."
  + modes/<active>.md        ← behavior for default | advise | super
  + safety/<level>.md        ← what is and is not permitted
  + providers/dynamic.md     ← current provider/model context (rebuilt per turn)
  + session/dynamic.md       ← persistent session notes (if any)
  + [future] scientific/*.md ← HPC/numerics overlay, opt-in per project
```

Compilation output: compiled prompt text + SHA-256 hash + fragment manifest (file paths + hashes). Hash lands in every audit record and receipt. Reproducibility depends on this determinism.

Fragment loading: built-ins live in `src/domains/prompts/fragments/`, user/project overrides in `~/.clio/prompts/` and `.clio/prompts/`, discovered at boot and at `/reload`.

## 10. Session and Reproducibility

Session JSONL is Clio's own format. Append-only. Tree-structured (id + parentId) for branching (fork, revert, navigate). Stored under `~/.clio/sessions/[cwd-hash]/current.jsonl`.

Per-session metadata persisted separately: model, provider, token usage, cost, turns, compiled-prompt hash, environment manifest (Node version, Clio version, pi-mono version, platform, git ref of cwd), start/end timestamps.

Checkpoint: full session JSONL + state bundle written atomically (tmp + fsync + rename). Resume: replay the JSONL, rehydrate domain state, reconnect providers, restore active mode and safety.

Reproducibility receipts (owned by observability): per-run JSON manifest with task, agent, runtime, model, tokens in/out, cost, duration, tool calls, exit status, compiled-prompt hash. `/receipt verify <id>` re-validates the manifest structure and hashes.

## 11. Observability

Every worker run produces:
- Run envelope in the ledger (active + historical)
- Telemetry events (session lifecycle, tool counts, durations)
- Receipt (reproducibility manifest)
- Cost accounting (tokens × model pricing → session total vs ceiling)

Ring-buffered storage: metrics and receipts have configurable max size (`CLIO_MAX_RUNS`, `CLIO_MAX_METRICS`). Old entries evict. No unbounded growth.

Live visibility: dispatch board overlay shows active runs with health status (healthy/stale/dead based on heartbeat), per-worker token burn, per-worker elapsed time.

## 12. Scheduling and Budget

Budget ceiling is a hard gate. When session cost hits the ceiling, new dispatch is blocked. User must explicitly raise the ceiling via TUI (not via LLM).

Concurrency: per-node worker limit (`CLIO_NODE_CONCURRENCY`, default auto-detect based on CPU/memory). Token buckets per provider. Exponential backoff on provider errors.

Cluster registry: scaffolded for v0.2+ (multi-node SSH/SLURM). Populated from settings.yaml. Node heartbeat and capacity tracked but not used for remote dispatch in v0.1.

## 13. Configuration Model

Single human-editable `~/.clio/settings.yaml`. TypeBox-validated. **No LLM-callable config tools** (security invariant). All configuration happens through:

- Direct file edit (watcher picks up changes)
- TUI overlays (`/clio-settings`, `/providers`, `/presets`, `/theme`, `/mode`)

Hot-reload matrix:

| Change type | Hot-reload | Restart nudge |
|---|---|---|
| Theme, keybindings, safety rules, mode defaults, prompt fragments, audit verbosity | Yes, ≤100ms | — |
| Model selection, thinking level, budget ceiling | Yes, next turn | — |
| Provider credentials, active provider list, runtime enable/disable, engine settings | — | Yes |

Restart nudge: friendly overlay saying "Settings change detected. Press R to restart, Esc to keep editing." Clio writes the settings, shuts down multi-phase, re-execs. No data loss.

Credentials: `~/.clio/credentials.yaml` (mode 0600) or OS keychain when available. Never in settings.yaml. Never LLM-readable. Managed through the `/providers` TUI overlay which shells out to OS keychain APIs.

## 14. Slash Command Surface (all ours)

Because Level 3 owns the command set, every command is defined in Clio. No Pi leakage.

**Core:** `/help`, `/about`, `/version`, `/quit`, `/clear`, `/reload`

**Configuration:** `/clio-settings`, `/providers`, `/models`, `/presets`, `/theme`

**Modes and safety:** `/mode [default|advise|super]`, `/safety`, `/audit`

**Session:** `/reset`, `/checkpoint`, `/history`, `/new`, `/resume`, `/fork`, `/compact`

**Agents and dispatch:** `/agents`, `/skills`, `/runs`, `/batches`, `/stoprun <id>`, `/run <agent> <task>`, `/chain`, `/parallel`

**Observability:** `/cost`, `/budget`, `/receipts`, `/receipt verify <id>`, `/doctor`

**Lifecycle (both CLI and TUI):** `/upgrade`, `/diagnose`

## 15. Keybindings (owned, not inherited)

| Keys | Action |
|---|---|
| `Shift+Tab` | Toggle default ⇄ advise mode |
| `Alt+S` | Enter super mode (requires confirmation) |
| `Ctrl+P` | Cycle model within scoped set |
| `Ctrl+Y` | Cycle safety level |
| `Ctrl+R` | Cycle thinking/reasoning level |
| `Esc` (double) | Open session tree navigator |
| `Ctrl+D` | Exit |
| `Ctrl+C` | Abort current turn |
| `:` | Open command palette |
| `/` | Begin slash command |

Customizable via settings.yaml under `keybindings`.

## 16. Repository Layout

```
clio-coder/
  README.md LICENSE CHANGELOG.md CONTRIBUTING.md
  package.json tsconfig.json biome.json
  .github/workflows/
    ci.yml release.yml deploy-docs.yml
  docs/
    architecture/           # architecture, invariants, domain specs
    guides/                 # getting started, configuration, agents, skills
    reference/              # slash commands, keybindings, settings schema
    development/            # contributing, adding runtimes, adding domains
    dispatch/               # dispatch primitives, chains, receipts
    specs/                  # versioned design specs (this document lives here)
  scripts/
    check-boundaries.ts     # engine + worker isolation enforcement
    check-prompts.ts        # prompt fragment validation
    verify.ts               # inline orchestrator smoke path
    stress.ts               # dispatch scaling stress test
    diag-*.ts               # dispatch diagnostic scripts
  src/
    engine/                 # SOLE pi-mono import boundary
      index.ts
      agent.ts              # wraps pi-agent-core Agent + State
      ai.ts                 # wraps pi-ai provider/model/streaming
      tui.ts                # wraps pi-tui primitives (TUI, Editor, Box, Text, etc.)
      session.ts            # Clio session format + SessionManager
      tools.ts              # tool registration helpers
      types.ts              # re-exported pi types
    core/                   # foundation (no pi-mono imports)
      config.ts defaults.ts init.ts
      event-bus.ts shared-bus.ts bus-events.ts
      domain-loader.ts termination.ts
      xdg.ts package-root.ts
      concurrency.ts startup-timer.ts
      agent-profiles.ts     # orchestrator vs worker profiles
      tool-names.ts
    tools/                  # coding tool implementations
      read.ts write.ts edit.ts bash.ts
      grep.ts glob.ts ls.ts
      web-fetch.ts web-search.ts
      write-plan.ts write-review.ts      # advise-mode constrained
      dispatch-agent.ts batch-dispatch.ts chain-dispatch.ts
      registry.ts
    interactive/            # our InteractiveMode equivalent
      index.ts                    # ClioInteractiveMode
      layout.ts                   # layout composer
      chat-panel.ts               # message history
      editor-panel.ts             # user input editor
      footer-panel.ts             # live status footer
      overlay-manager.ts          # all overlays
      slash-router.ts             # slash command registration + dispatch
      keybinding-manager.ts       # keybinding schema + cycles
      renderers/                  # per-tool rendering
      components/                 # SelectList, SettingsList, BorderedLoader, custom
      overlays/                   # settings, providers, models, presets, theme, mode,
                                  # agents, skills, dispatch board, cost, receipts
    worker/                 # PHYSICALLY ISOLATED from domains/
      entry.ts              # native worker subprocess entry
      cli-entry.ts          # CLI worker wrapper
      sdk-entry.ts          # Claude SDK subprocess worker
      provider-bridge.ts    # minimal ExtensionAPI for worker provider resolution
      safety-ext.ts         # worker-side safety
      heartbeat.ts          # parent liveness monitoring
    domains/
      config/              index.ts manifest.ts extension.ts schema.ts watcher.ts
      providers/           index.ts manifest.ts extension.ts discovery.ts health.ts
                           catalog.ts matcher.ts credentials.ts runtimes/
      safety/              index.ts manifest.ts extension.ts scope.ts action-classifier.ts
                           audit.ts rejection-feedback.ts loop-detector.ts damage-control.ts
      modes/               index.ts manifest.ts extension.ts matrix.ts state.ts
      prompts/             index.ts manifest.ts extension.ts fragments/ compiler.ts hash.ts
      session/             index.ts manifest.ts extension.ts manager.ts checkpoint.ts
                           history.ts
      agents/              index.ts manifest.ts extension.ts recipe.ts registry.ts teams.ts
                           skills.ts frontmatter.ts fleet-parser.ts
      dispatch/            index.ts manifest.ts extension.ts
                           worker-spawn.ts state.ts routing.ts primitives.ts
                           validation.ts backoff.ts batch-tracker.ts resilience.ts
      observability/       index.ts manifest.ts extension.ts telemetry.ts
                           metrics.ts receipts.ts cost.ts health.ts
      scheduling/          index.ts manifest.ts extension.ts budget.ts concurrency.ts
                           cluster.ts cluster-transport.ts
      intelligence/        index.ts manifest.ts extension.ts contracts.ts
                           intent-detector.ts solver.ts speculative.ts reconciler.ts
                           learner.ts    # all scaffolded, disabled by default
      lifecycle/           index.ts manifest.ts extension.ts install.ts doctor.ts
                           upgrade.ts uninstall.ts version.ts migrations/
      ui/                  index.ts manifest.ts extension.ts
                           banner.ts widgets/ dashboard-board.ts
                           command-palette.ts theme.ts identity.ts
    cli/
      index.ts shared.ts
      clio.ts                     # default: start interactive
      doctor.ts install.ts uninstall.ts upgrade.ts
      version.ts sessions.ts diagnose.ts
    entry/
      orchestrator.ts             # composition root
      worker.ts                   # worker composition root
  dist/ (gitignored)
```

## 17. Boot and Shutdown

**Boot (target ≤800ms to first frame):**
1. CLI entry resolves subcommand
2. Load `~/.clio/settings.yaml`, validate against schema
3. Core init: XDG paths, shared event bus, termination coordinator, startup timer
4. Collect domain manifests → topological sort → load order
5. Instantiate each domain's ExtensionFactory in dependency order
6. Engine boot: create `pi-agent-core` Agent, wire provider via `pi-ai`, instantiate Clio TUI on `pi-tui`
7. Fire `session_start` hooks across domains (providers discover, modes apply, prompts compile, ui renders)
8. Show Clio banner
9. Enter interactive loop

**Shutdown (multi-phase, critical for safety):**
1. **DRAIN** — stop accepting new input and new dispatch
2. **TERMINATE** — SIGTERM to every active worker subprocess, 3s grace, then SIGKILL. Mark interrupted runs in ledger.
3. **PERSIST** — atomic writes of all domain state (settings, session JSONL, audit, ledger, metrics, receipts)
4. **EXIT** — tear down TUI, `process.exit(0)`

## 18. State Ownership Matrix

| State | Owner | File |
|---|---|---|
| User settings | config | `~/.clio/settings.yaml` |
| Credentials | providers | `~/.clio/credentials.yaml` (0600) or OS keychain |
| Provider registry (live) | providers | memory, recreated at boot |
| Model cache | providers | `~/.clio/cache/models.json` |
| Agent specs | agents | `~/.clio/agents/` + `.clio/agents/` |
| Session (current) | session | `~/.clio/sessions/[cwd-hash]/current.jsonl` |
| Session tree | session | `~/.clio/sessions/[cwd-hash]/tree.json` |
| Audit trail | safety | `~/.clio/audit/YYYY-MM-DD.jsonl` |
| Run ledger | dispatch | `~/.clio/state/runs.json` |
| Metrics | observability | `~/.clio/state/metrics.json` |
| Receipts | observability | `~/.clio/receipts/<run-id>.json` |
| Budget counters | scheduling | `~/.clio/state/budget.json` |
| Install metadata | lifecycle | `~/.clio/install.json` |
| Cluster nodes | scheduling | `~/.clio/state/cluster.json` |

All writes atomic (tmp + fsync + rename).

## 19. What We Port from PanCode (IP inventory map)

PanCode has 29,523 LOC across 186 files. We port the IP, not the file structure. Mapping:

| PanCode concept | Clio destination | What changes |
|---|---|---|
| Pi-coding-agent extensions | Custom interactive + domain extensions | Level 3 — we own the shell |
| 4-mode system (Admin/Plan/Build/Review) | 3-mode system (default/advise/super) | Simpler, user-driven |
| LLM-callable `pan_apply_config` | TUI-first overlays + yaml file + watcher | Security improvement |
| Dispatch subsystem (extension + worker-spawn + state + routing + primitives) | `src/domains/dispatch/` + `src/worker/` | Subprocess-only from day one, no in-process SDK path |
| Runtime adapters (7 in PanCode) | `src/domains/providers/runtimes/` | Same 7, all subprocess, plus pi-coding-agent as new CLI adapter |
| Provider system | `src/domains/providers/` | Same design, cleaned |
| Agent specs (YAML frontmatter) | `src/domains/agents/` | Same format, further inspired by pi-subagents |
| Safety (action classifier, scope, audit) | `src/domains/safety/` | Same design |
| Prompts (fragment compilation) | `src/domains/prompts/` | Same design, SHA-256 hashes retained |
| Session (JSONL, checkpoint) | `src/engine/session.ts` + `src/domains/session/` | Clio-branded format, provenance-ready |
| Observability (telemetry, receipts) | `src/domains/observability/` | Same design |
| Scheduling (budget, cluster, transport) | `src/domains/scheduling/` | Same, cleaned |
| Intelligence (scaffolded) | `src/domains/intelligence/` | Same, scaffolded |
| TUI (Pi-based with extensions) | `src/interactive/` (our own) | Level 3 — full custom mode |
| CLI commands (pancode / up / down / sessions) | `src/cli/` | Clio-branded, tmux removed from v0.1 |
| Config loader | `src/core/config.ts` + `src/domains/config/` | YAML single source of truth |

**Explicitly not ported:**
- Pi-coding-agent as engine dependency (gone)
- Vendored `packages/` directory (gone, normal npm deps)
- 12 stashes of abandoned experiments (gone)
- 3 unstaged deletions (gone)
- God objects from earlier PanCode iterations (structurally impossible due to domain boundaries)
- Dual in-process/subprocess SDK path (structurally gone — only subprocess)

## 20. Inspiration from pi-subagents and ref-extensions

Not dependencies, references. We study these for patterns, implement natively.

**From ref-extensions (PanCode's concept seeds):**
- `damage-control.ts` → safety domain's dangerous-command interception
- `purpose-gate.ts` → modes domain's tool admission gating
- `pure-focus.ts` → advise mode's tool restriction pattern
- `system-select.ts` → prompts domain's fragment selection UI
- `theme-cycler.ts` → ui domain's theme overlay
- `tool-counter-widget.ts` → ui domain's live status widget
- `cross-agent.ts` → agents domain's context-registry pattern
- `session-replay.ts` → observability's reproducibility engine foundation
- `subagent-widget.ts` → ui dispatch board live widget
- `agent-chain.ts`, `agent-team.ts`, `tilldone.ts` → dispatch primitives

**From pi-subagents (mature worker dispatch):**
- Agent frontmatter convention (`model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `tools`, `extensions`, `output`, `defaultReads`, `maxSubagentDepth`) → agents domain's recipe schema
- Builtin agents (scout, planner, worker, reviewer, context-builder, researcher, delegate) → Clio ships the same starting fleet
- Chain and parallel execution (`/chain`, `/parallel`, `-> ` separator, inline config `[key=value]`) → dispatch domain's primitives
- `--bg` async execution → dispatch domain's background mode
- Worktree isolation → dispatch domain's per-worker worktree
- Model fallback for provider/quota errors → dispatch's resilience module

## 21. Verification Strategy (no test theater)

Locked decision: no vanity test suite. Inline verification only.

- `scripts/verify.ts` — scripted orchestrator boot, exercises every command, every overlay, every mode transition. CI gate.
- `scripts/check-boundaries.ts` — engine boundary + worker isolation.
- `scripts/check-prompts.ts` — every prompt fragment parses, every composition produces stable hashes.
- `scripts/stress.ts` — dispatch scaling stress (spawn N workers, verify lifecycle).
- `scripts/diag-*.ts` — dispatch diagnostic (from PanCode's 5 diag scripts).
- `npm run typecheck` — TypeScript strict mode.
- `npm run build` — tsup production bundle.
- `npm run smoke` — 60-second boot/dispatch/shutdown cycle.

## 22. Deferred to Post-v0.1 (intentionally)

These are real features Clio will have. They are not in v0.1 because their integration points are scaffolded and the features themselves add breadth, not depth, to the orchestrator.

- **Scientific specialization** (HDF5/MPI/numerics-aware prompts, build-system introspection, facility safety rules) — v0.2 or later
- **Cluster dispatch** (SLURM, SSH, multi-node worktrees) — v0.3 or later
- **Reproducibility-as-artifact** (citation-ready receipts, paper-ready exports) — v0.3 or later
- **Tmux-backed session persistence** (`clio up` / `clio down`) — v0.2
- **Headless mode** (`clio run --headless` for CI) — v0.3
- **REST API daemon + SSE events** — v1.0
- **Multi-node fleet over SSH** — v0.3
- **Agent marketplace / skill packs** — v1.0+
- **Runtime tool forging in sandboxed V8** — v1.0+

## 23. Identity Summary

| Field | Value |
|---|---|
| Product name | Clio-Coder |
| User-facing brand | Clio (IOWarp's orchestrator coding-agent) |
| CLI binary | `clio` |
| Config dir | `~/.clio/` (XDG-aware, respects `$XDG_CONFIG_HOME/clio`) |
| NPM package | `@iowarp/clio-coder` |
| License | Apache 2.0 |
| Voice | Professional, scientific, no emojis, no em-dashes |
| Engine (invisible) | pi-mono (pi-agent-core + pi-ai + pi-tui) |
| Node runtime | >= 20 |
| Language | TypeScript 5.7 strict |
| Build tool | tsup |
| Lint/format | Biome |

---

## Decision Log

| Decision | Rationale | Locked |
|---|---|---|
| Level 3 custom harness on pi-agent-core + pi-ai + pi-tui | Full control over slash commands, TUI shape, session format, identity. No upstream ceiling. | Yes |
| No dependency on pi-coding-agent in v0.1 | Re-enters as one worker adapter later, not engine | Yes |
| 13 domains with manifest-driven topological loading | PanCode's proven architecture pattern | Yes |
| Subprocess-only dispatch from day one | PAN-SDK-V2 plan; avoids PanCode's dual-path debt structurally | Yes |
| 3 modes (default/advise/super) | Cleaner than PanCode's 4; default is useful, advise is distinct, super is rare | Yes |
| TUI-first config, no LLM-callable config tools | Security invariant | Yes |
| Single `~/.clio/settings.yaml`, file-watched, hot-reload with restart-nudge | Simpler than PanCode's multi-file approach | Yes |
| All slash commands owned by Clio (no inheritance) | Level 3 dividend | Yes |
| Engine boundary enforced at build time | Upstream churn containment | Yes |
| Worker isolation enforced by directory structure | Physical impossibility of worker reaching orchestrator state | Yes |
| No test theater, inline verification via scripts/ only | Carried from PanCode locked decision #4 | Yes |
| Apache 2.0, pure open source | Carried from PanCode | Yes |

---

## Next Steps

1. Spec self-review (placeholder, contradiction, ambiguity, scope checks)
2. User review of written spec
3. Invoke `superpowers:writing-plans` to produce the phased implementation plan
4. Initialize the clio-coder repo scaffolding per the implementation plan
