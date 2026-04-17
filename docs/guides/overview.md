# Clio-Coder Overview

## What Clio-Coder is

Clio-Coder is a Level 3 custom harness built on pi-mono. The engine layer imports
`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and `@mariozechner/pi-tui`
at exact version 0.67.4; nothing else in the repository imports those packages.
The product ships as the npm package `@iowarp/clio-coder` with a single binary
named `clio`. The design thesis lives in
`docs/specs/2026-04-16-clio-coder-design.md` §1 and §2: Clio is the orchestrator
layer of a distributed agentic harness, not a chatbot frontend, not a plugin, and
not a reskin of pi-coding-agent. Pi-coding-agent re-enters as one worker adapter
among many on the CLI runtime tier. The orchestrator owns the agent loop, slash
commands, session format, prompt compilation, tool registry, and identity.

## Architecture

### 13 domains

The design spec §5 is the source of truth. The `ui` domain lives under
`src/interactive/` in the actual code; it was folded into `interactive/` for
v0.1 to keep the TUI scaffold self-contained while the overlay surface is still
being built out.

| # | Domain | Depends on | Owns |
|---|---|---|---|
| 1 | config | (none) | `~/.clio/settings.yaml`, file watcher, schema |
| 2 | providers | config | provider registry, model catalog, credentials, health |
| 3 | safety | config | audit trail, action classifier, scope rules, dangerous-command interception |
| 4 | modes | safety | current mode, tool allowlist matrix |
| 5 | prompts | config | identity + mode + safety fragments, SHA-256 compilation |
| 6 | session | config | session JSONL, checkpoint, resume, history |
| 7 | agents | config | agent spec registry, recipes, teams, skills |
| 8 | dispatch | safety + agents + providers | worker spawn, run ledger, batch tracker, admission gating |
| 9 | observability | dispatch | telemetry, metrics, receipts, cost tracking |
| 10 | scheduling | dispatch + agents | budget ceiling, concurrency limits, node registry |
| 11 | intelligence | dispatch + agents | intent detector, solver, learner (scaffolded, disabled by default) |
| 12 | lifecycle | config + providers | install metadata, version info, migrations, health checks |
| 13 | ui | dispatch + agents + session + scheduling + observability + modes + safety + providers | TUI layout, panels, overlays, footer, theme, slash routing |

Each domain exports `{ name, dependsOn }`. Topological sort at boot produces the
load order. Adding a domain is a three-step change: create the folder, write
the manifest, add the name to the enabled list.

### 3 hard invariants

The invariants are enforced by `scripts/check-boundaries.ts` in CI so a code
change that violates one fails the build:

1. **Engine boundary.** Only `src/engine/**` imports from pi-mono packages.
   The single source for pi-mono package strings lives in
   `src/engine/pi-mono-names.ts` so static analysis is reliable.
2. **Worker isolation.** `src/worker/**` never imports from `src/domains/**`.
   Workers are OS-isolated subprocesses with no shared memory, event loop, or
   file descriptors with the orchestrator.
3. **Domain independence.** Each domain owns its state. Cross-domain
   communication flows exclusively through `SafeEventBus`. No `extension.ts`
   file imports from a sibling domain.

### 3 runtime tiers

Every worker is a subprocess. There is no in-process dispatch path.

| Tier | Adapters | Telemetry depth |
|---|---|---|
| Native | Clio worker via pi-agent-core | Platinum |
| SDK | Claude Agent SDK in subprocess | Gold |
| CLI | pi-coding-agent, claude-code, codex, gemini, opencode, copilot | Silver or Bronze (depends on streaming richness) |

### 3 safety modes

Mode state persists to `settings.yaml` under `state.lastMode`. The tool registry
mode gate runs at registration time; tools outside the active allowlist are
never shown to the model.

| Mode | Tool set | Entry |
|---|---|---|
| default | read, write, edit, bash, grep, glob, ls, web_fetch, web_search, dispatch_agent, batch_dispatch, chain_dispatch | launched by default |
| advise | read, grep, glob, ls, web_fetch, web_search, write_plan (PLAN.md only), write_review (REVIEW.md only), dispatch_agent (readonly workers) | `Shift+Tab` cycles default ⇄ advise |
| super | default + privileged ops (writes outside cwd, package installs); `system_modify` and `git_destructive` stay hard-gated | `Alt+S` with a confirmation overlay |

## Per-phase delivery

| Phase | Tag | SHA | Deliverable |
|---|---|---|---|
| 1 | `phase-1-hardened` | `2f82d8c` | scaffold + config + interactive stub + XDG |
| 2 | `phase-2-complete` | `d0e31c1` | safety classifier + damage-control + modes + registry |
| 3 | `phase-3-complete` | `dfebddc` | two-hash prompt compiler + session JSONL + hot-reload |
| 4 | `phase-4-complete` | `0e70be3` | 8-provider catalog + credentials (0600) + 8 runtime adapters + agents discovery + `/providers` + `/agents` |
| 5 | `phase-5-complete` | `44c637c` | 14 tools with mode-gated registry + write_plan/write_review path guard |
| 6 | `phase-6-complete` | `6356b27` | dispatch domain + native worker subprocess + NDJSON stream + receipt + 10-concurrent stress |
| 7 | `phase-7-complete` | `c6100f2` | six CLI adapter stubs + generic cli-entry wrapper + RUNTIME_ADAPTERS |
| 8 | `phase-8-complete` | `bb0028c` | Claude SDK subprocess adapter with graceful fallback |
| 9 | `phase-9-partial` | `e47b4f7` | minimal interactive TUI scaffold (banner + editor + footer + Shift+Tab) |
| 10 | `phase-10-partial` | `cbf70fc` | observability + scheduling + intelligence domain scaffolding |

Four iteration commits landed after `phase-10-partial`:

- `a4df8b2` enrich dispatch bus payloads with provider + model + duration
- `ec14bae` accumulate worker usage tokens into receipt + observability
- `3a92f6b` tighten engine boundary + PID-owned ledger lock (HIGH + MED audit fixes)
- `a6bef10` wire `/run` + `/help` slash commands through dispatch

## What phases 9 and 10 still need

Items already landed by the four post-`phase-10-partial` commits have been
removed from the lists below.

**Phase 9 (interactive TUI) deferred work:**

- `Alt+S` super-mode confirmation overlay
- `Ctrl+P` / `Ctrl+Y` / `Ctrl+R` cycling (model, safety, thinking level)
- `Esc Esc` session tree navigator
- Slash palette autocomplete and command palette (`:`)
- Live overlays: settings, providers, models, presets, theme, mode, safety,
  audit, receipts, dispatch-board, cost, runs, batches
- Full slash-command surface from the design spec
- Custom keybindings manager

**Phase 10 (observability, scheduling, intelligence, release) deferred work:**

- Budget gate actually blocking dispatch (currently alerts only)
- Dispatch-board, cost, and receipts overlays (blocked on Phase 9 UI)
- Cluster domain real remote dispatch (v0.2 scope)
- Intelligence real detector, solver, and learner implementations (v0.2 scope)
- `npm run smoke` 60-second end-to-end cycle
- `clio upgrade` with migrations
- `v0.1.0` release tag

## User-facing surface today

- `clio --version`, `clio install`, `clio doctor`, `clio uninstall` handle
  lifecycle.
- `clio providers [--json] [--no-probe]` and `clio agents [--json]` list
  discovered providers and agents. Local-engine providers (llamacpp,
  lmstudio, ollama, openai-compat) enumerate configured endpoints from
  `~/.clio/settings.yaml` and report per-endpoint health.
- `clio run <agent> <task> [--faux] [--json] [--provider ...] [--endpoint ...] [--model ...]`
  runs a headless dispatch and streams NDJSON events plus a final receipt.

### Local inference engines

Clio ships four native local providers that talk to any local server:

- `llamacpp` drives `llama-server` over OpenAI-compat `/v1/*` plus
  llama.cpp specifics (`/health`, `/props`, `/slots`, `/tokenize`).
- `lmstudio` drives LM Studio with `/api/v0/models` preferred and a fall
  back to `/v1/models`.
- `ollama` drives any Ollama instance through its native `/api/tags`
  listing; chat flows through Ollama's OpenAI-compat `/v1/*` for v0.1.
- `openai-compat` is the generic fallback for SGLang, vLLM, tgi, and
  other servers that expose `/v1/chat/completions` without matching the
  above quirks.

Endpoints are user-supplied. Example `~/.clio/settings.yaml`:

```yaml
providers:
  llamacpp:
    endpoints:
      home-mini:
        url: http://192.168.86.141:8080
        default_model: Qwen3.6-35B-A3B-UD-Q4_K_XL
  lmstudio:
    endpoints:
      home-dynamo:
        url: http://192.168.86.143:1234
        default_model: qwen3.6-35b-a3b
orchestrator:
  provider: llamacpp
  endpoint: home-mini
  model: Qwen3.6-35B-A3B-UD-Q4_K_XL
workers:
  default:
    provider: lmstudio
    endpoint: home-dynamo
    model: qwen3.6-35b-a3b
```
- `clio` with no subcommand launches the interactive TUI scaffold. Slash
  commands available today are `/run <agent> <task>`, `/help`, and `/quit`.
- `npm run diag:*` covers the diagnostic suite. Full index lives in
  `docs/guides/scripts.md`.
