<p align="center">
  <picture>
    <source srcset="assets/banner.webp" type="image/webp" />
    <img src="assets/banner.png" alt="Clio Coder, AI coding harness for repository work" width="100%" />
  </picture>
</p>

<h1 align="center">Clio Coder</h1>

<p align="center"><strong>AI coding harness for supervised repository work.</strong></p>

<p align="center">
  Interactive terminal chat, configurable local and cloud model targets, dispatchable coding workers, and self-development mode.
</p>

<p align="center">
  <a href="https://github.com/iowarp/clio-coder/releases"><img alt="version" src="https://img.shields.io/badge/version-0.1.2-00d4db?style=flat-square" /></a>
  <a href="#install"><img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions"><img alt="ci" src="https://img.shields.io/badge/ci-passing-147366?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm" src="https://img.shields.io/badge/npm-coming%20soon-lightgrey?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00d4db?style=flat-square" /></a>
</p>

---

## Table of contents

1. [What is Clio Coder?](#what-is-clio-coder)
2. [Install](#install)
3. [First run](#first-run)
4. [CLI commands](#cli-commands)
5. [Slash commands](#slash-commands)
6. [Sessions and context](#sessions-and-context)
7. [Keybindings](#keybindings)
8. [Configuration](#configuration)
9. [Targets and runtimes](#targets-and-runtimes)
10. [Runtimes](#runtimes)
11. [Agents](#agents)
12. [Safety model](#safety-model)
13. [Receipts and cost](#receipts-and-cost)
14. [Architecture at a glance](#architecture-at-a-glance)
15. [Development](#development)
16. [Governance](#governance)
17. [Roadmap](#roadmap)
18. [Lineage and credits](#lineage-and-credits)
19. [License](#license)

---

## What is Clio Coder?

Clio Coder is an AI coding harness for supervised repository work. It combines an interactive terminal agent, configurable local and cloud model targets, dispatchable coding workers, and a self-development mode for safely evolving its own codebase.

Status: **v0.1.2** — an experimental patch release. Adds transient provider retry with persistent transcript visibility, hardens bash subprocess abort with SIGKILL escalation, tightens tool/bash transcript rendering, and lands a structured `audit.jsonl` so post-mortem replay can reconstruct what happened in a session. Pin to the tag if you need a stable target.

Recent focus in this dev cycle:

- transient provider and stream retry with cancellation, exhaustion, and
  recovery markers persisted for resume and fork replay
- reliable bash subprocess abort with SIGKILL escalation after a SIGTERM
  grace period
- richer tool and bash transcript rendering with status, elapsed time, and
  command previews
- durable, entry-aware transcript replay for resume, fork, summaries, bash,
  and tool activity
- structured `<dataDir>/audit/YYYY-MM-DD.jsonl` rows for every classified
  tool call, mode transition (including dismissed Alt+S elevations), run
  abort (Esc-on-stream, dispatch.abort, shutdown drain), and session
  park/resume so post-mortem replay knows which session was active and what
  stopped it
- per-tool stats in run receipts (loops, errors, blocked attempts, parallel
  batches), plus `detectedReasoning` exposure in `clio targets --json`
- deterministic project context loading from `AGENTS.md` and `CODEX.md`
- target-oriented auth and configuration flows across the CLI and interactive UI
- target controls, model selection, scoped-model cycling, session navigation, and better live response UX in the TUI
- a startup TUI dashboard with target/model, model-registry, context, latency,
  and worker-profile status at a glance
- mode-colored prompt rails: default stays neutral, advise is amber, and super
  is red
- `/hotkeys` now shows resolved keybindings, legacy-terminal warnings for
  CSI-u-only user bindings, and per-binding settings guidance
- an experimental self-dev harness for hot-reload and restart-required feedback while working on Clio Coder itself

---

## Install

Prerequisites: Node.js `>=20`.

### From source

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm install
npm run build && npm link
clio
```

`npm link` exposes the `clio` binary declared in [`package.json`](package.json) (`dist/cli/index.js`). Re-run `npm run build` after source changes because the link points at built output, not the TypeScript sources.

### From npm

```bash
npm install -g @iowarp/clio-coder
```

### Isolated state trees

The runtime is XDG-aware and also honors `CLIO_HOME`, `CLIO_CONFIG_DIR`, `CLIO_DATA_DIR`, and `CLIO_CACHE_DIR` so you can sandbox a dev install from your daily config.

---

## First run

```bash
clio                                 # start the TUI; first run bootstraps and configures
clio configure                       # rerun the configuration wizard
clio targets                         # inspect target health/auth/capabilities
clio models                          # list models for configured targets
clio auth login <target-or-runtime>  # optional OAuth/API-key flow
```

Bare `clio` bootstraps config, data, and cache automatically. If it is running interactively and no usable default target exists, it guides you into `clio configure` instead of requiring a separate lifecycle step.

For a non-interactive run, `clio run --agent scout "summarize the repo layout"` dispatches a worker and writes a receipt. Use `--target`, `--model`, `--thinking`, and `--require` when you want a one-off override without changing defaults.

Start the interactive TUI with bare `clio`. The banner renders as `Clio Coder`. The current surface includes target and model controls, session navigation, receipts and cost overlays, and the slash-command parser documented below.

---

## CLI commands

| Command | What it does |
| --- | --- |
| `clio` | Launch the interactive TUI. |
| `clio configure` | Run the first-run/configuration wizard. |
| `clio targets` | List configured targets, health, auth, runtime, model, and capabilities. |
| `clio targets add` | Add a target interactively or via flags. |
| `clio targets use <id>` | Set chat and worker defaults to one target. |
| `clio targets remove <id>` / `rename <old> <new>` | Manage target ids. |
| `clio models [search] [--target <id>]` | List discovered or known models for targets. |
| `clio auth list|status|login|logout [target-or-runtime]` | Inspect, add, or remove stored auth. |
| `clio doctor [--fix]` | Diagnose without creating files; `--fix` creates or repairs state. |
| `clio reset [--state|--auth|--config|--all]` | Recover or wipe Clio Coder state while keeping the binary installed. |
| `clio uninstall [--keep-config] [--keep-data]` | Remove Clio Coder state and print package-manager removal guidance. |
| `clio agents` | List builtin agent specs. |
| `clio run [flags] "<task>"` | Dispatch a single worker non-interactively and persist a receipt. |
| `clio upgrade` | Check for and apply runtime upgrades. |
| `clio --version` | Print the installed version. |

Source: [`src/cli/`](src/cli/).

---

## Slash commands

Available inside the interactive TUI.

Typing `/` at the start of the prompt opens the autocomplete dropdown for all
built-in slash commands. Keep typing to filter command names, such as `/m` for
`/model`, and press `Tab` to complete the selected command.

| Command | What it does |
| --- | --- |
| `/run <agent> <task>` | Dispatch a worker and stream its events into the transcript. |
| `/targets` | Overlay target health, auth, runtime, model, and capabilities. |
| `/connect [target]` | Connect to a target or runtime; auth-backed runtimes prompt for credentials, local targets are probed. |
| `/disconnect [target]` | Disconnect a target or runtime when Clio owns stored connection state. |
| `/model [pattern[:thinking]]` | Open the model selector, or set the orchestrator model directly. |
| `/scoped-models` | Edit the scoped list used by model cycling. |
| `/thinking` | Open the thinking-level selector. |
| `/settings` | Open interactive settings controls. |
| `/resume` and `/new` | Resume an existing session or start a fresh one. |
| `/tree` and `/fork` | Navigate the session tree or branch from an earlier assistant turn. |
| `/compact [instructions]` | Compact earlier session context. |
| `/cost` | Overlay session token totals and USD cost accumulated from completed runs. |
| `/receipts [verify <runId>]` | Browse saved run receipts, or verify one receipt against the persisted run ledger. |
| `/help` | Show the slash-command reference. |
| `/hotkeys` | Show the current keyboard and slash-command reference. |
| `/quit` | Exit the TUI cleanly. |

Parser source: [`src/interactive/`](src/interactive/).

---

## Sessions and context

Interactive sessions persist under `<dataDir>/sessions/` as append-only JSONL
plus tree metadata. `/resume` reloads the selected session, replays the
entry-aware transcript, and rebuilds the next-turn context from the same
entries. `/fork` starts a new branch from the selected parent turn, shows the
parent transcript up to that point, and seeds the next model call with that
parent-prefix context while the new branch records fresh turns.

Replay renders user and assistant messages, branch and compaction summaries,
system and checkpoint notes, bash execution entries, custom display entries,
and persisted tool call/result entries when those entries exist in the
session log. Interactive tool activity is written as durable tool call/result
entries, so tool work remains visible after resume and fork; full output replay
still depends on the corresponding durable entries being present.

Transient provider and stream failures retry automatically when `retry.enabled`
is true. Failed attempts remain visible in the transcript, retry countdowns and
exhaustion/recovery markers are persisted for resume/fork replay, and the retry
continues from the existing user turn rather than adding the prompt again.

Before each interactive turn, Clio loads project context files from the current
working directory upward to the filesystem root. The first supported names are
`AGENTS.md` and `CODEX.md`; parent files are injected before child files, and
`AGENTS.md` is injected before `CODEX.md` within the same directory. Missing or
unreadable files are ignored. Broader resources such as skills, prompt
templates, themes, packages, extensions, and a `--no-context-files` flag are
intentionally deferred.

Compaction can run manually with `/compact [instructions]` or automatically
when `compaction.auto` is enabled and the estimated context crosses
`compaction.threshold`. `/settings` exposes those two live controls; advanced
compaction overrides remain direct `settings.yaml` fields.

---

## Keybindings

| Binding | Action |
| --- | --- |
| `Shift+Tab` | Cycle thinking level. |
| `Alt+M` | Cycle mode `default` / `advise`. |
| `Alt+S` | Open the super-mode confirmation overlay. |
| `Alt+T` | Open the session tree navigator. |
| `Ctrl+L` | Open the model selector. |
| `Ctrl+P` / `Shift+Ctrl+P` | Cycle the scoped model set forward / backward. |
| `Ctrl+B` | Toggle the dispatch-board overlay. Rows update live from the dispatch event bus. |
| `Ctrl+C` | Cancel a stream, clear input, or press twice to exit. |
| `Ctrl+D` | Exit. |
| `Esc` | Cancel a stream or close the active overlay. |

Run `/hotkeys` for the resolved binding table. Use Up/Down and `E` there to
inspect a binding's action id, current keys, source, and `settings.yaml`
override guidance.

---

## Configuration

Clio Coder reads from the platform config dir by default: `~/.config/clio/settings.yaml` on Linux, `~/Library/Application Support/clio/settings.yaml` on macOS, and `%APPDATA%/clio/settings.yaml` on Windows. Every path is overridable via XDG or Clio Coder-specific env vars so you can keep dev and prod state separate.

The happy path is package install followed by bare `clio`. The config shape is target-first: local HTTP engines, cloud APIs, OAuth/subscription runtimes, and CLI-backed runtimes all land in `targets[]`, then `orchestrator` and `workers.default` select from those target ids.

```yaml
# Linux default: ~/.config/clio/settings.yaml (excerpt)
version: 1
targets:
  - id: mini
    runtime: openai-compat
    url: http://127.0.0.1:8080
    defaultModel: Qwen3.6-35B-A3B-UD-Q4_K_XL
    capabilities:
      contextWindow: 262144
      reasoning: true

orchestrator:
  target: mini
  model: Qwen3.6-35B-A3B-UD-Q4_K_XL
  thinkingLevel: off

workers:
  default:
    target: mini
    model: Qwen3.6-35B-A3B-UD-Q4_K_XL
    thinkingLevel: off

scope:
  - mini

compaction:
  threshold: 0.8
  auto: true

retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000
  maxDelayMs: 60000
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `CLIO_HOME` | unset | Optional single-tree root for all Clio Coder state. |
| `CLIO_CONFIG_DIR` | platform config dir, or `$CLIO_HOME` when set | Location of `settings.yaml`. |
| `CLIO_DATA_DIR` | platform data dir, or `$CLIO_HOME/data` when set | Receipts, ledgers, sessions. |
| `CLIO_CACHE_DIR` | platform cache dir, or `$CLIO_HOME/cache` when set | Transient caches. |
| `ANTHROPIC_API_KEY` | unset | Enables Claude providers. |
| `OPENAI_API_KEY` | unset | Enables OpenAI providers. |

Runtime credentials can live in environment variables referenced by `targets[].auth.apiKeyEnvVar`, or in Clio Coder's credential store when you use `clio auth login`.
Out-of-tree runtime plugins are loaded from `<configDir>/runtimes/*.js` or
packages listed in `runtimePlugins`; descriptors with `kind: "http"`,
`"subprocess"`, or `"sdk"` are admitted when they satisfy the runtime
descriptor contract.

---

## Targets and runtimes

| Group | Examples | Notes |
| --- | --- | --- |
| Featured / subscription | `openai-codex` | ChatGPT Plus/Pro via Codex OAuth. Use `clio auth login openai-codex`. |
| Cloud APIs | `anthropic`, `openai`, `google`, `groq`, `mistral`, `openrouter`, `bedrock` | API-key-backed runtimes. Use `clio auth list` to inspect the current support surface. |
| Local HTTP | `openai-compat`, `lmstudio-native`, `ollama-native`, `llamacpp-completion`, `vllm`, `sglang`, `lemonade` | Configured as `targets[]` with a URL and optional capability overrides. |
| CLI runtimes | `codex-cli`, `claude-code-cli`, `gemini-cli` | Recognized by the registry and support surfaces. Dispatch requires the matching CLI to be installed and authenticated. |

`clio targets --probe` probes configured targets and reports health, capability flags, and discovered models. `clio models` gives a flatter per-target model view.

---

## Runtimes

Runtime tiers classify how a target is reached.

| Tier | What it is |
| --- | --- |
| `protocol` | HTTP targets that speak a supported model API protocol. |
| `cloud` | Managed API providers with API-key, OAuth, or platform auth. |
| `local-native` | Local model runtimes reached through their native HTTP or SDK surface. |
| `cli-stub` | CLI-backed runtimes launched through installed command-line tools. |

That split is intentionally visible in `clio configure`, `clio targets`, and `clio models` so target configuration, health, and dispatch behavior stay understandable.

---

## Agents

Seven builtin agent specs ship in [`src/domains/agents/builtins/`](src/domains/agents/builtins/).

| Agent | Purpose |
| --- | --- |
| `scout` | Fast repo exploration and context assembly. |
| `planner` | Turns a goal into a reviewable implementation plan. |
| `researcher` | Literature, documentation, and web-grounded investigation. |
| `reviewer` | Reviews work against a plan and a coding standard. |
| `delegate` | Routes work across multiple sub-agents. |
| `context-builder` | Assembles focused context bundles for downstream agents. |
| `worker` | Generic execution worker for bounded tasks. |

Specs are plain Markdown with frontmatter. Drop new files into the same directory to register additional agents.

---

## Safety model

Three modes gate tool visibility and permission.

| Mode | What it allows |
| --- | --- |
| `default` | Read, write, edit, bash, search, and dispatch tools visible. |
| `advise` | Read-oriented. No filesystem mutation. |
| `super` | Privileged writes outside the working directory. Gated by the confirmation overlay (`Alt+S`). |

Hardcoded kill-switches for dangerous Bash patterns live in [`damage-control-rules.yaml`](damage-control-rules.yaml). The list includes `rm -rf /`, `git push --force main`, and raw `dd` writes to block devices.

---

## Receipts and cost

Every completed run writes a receipt to `<dataDir>/receipts/<runId>.json`. A receipt records token counts, USD cost, the model and target used, and a SHA-256 integrity hash over the receipt fields plus the matching run ledger entry.

```bash
/receipts                   # paginated list in the TUI
/receipts verify <runId>    # re-hash the receipt + run ledger and report match / mismatch
/cost                       # session-level token and USD totals
```

Receipts are the source of truth for cost accounting and the audit trail. Nothing else in the system is trusted to report cost.

---

## Architecture at a glance

Core logic is split across [`src/domains/`](src/domains/), [`src/interactive/`](src/interactive/), [`src/engine/`](src/engine/), [`src/worker/`](src/worker/), and the contributor-facing self-dev harness in [`src/harness/`](src/harness/).

Three hard invariants are enforced by the boundary tests in [`tests/boundaries/check-boundaries.ts`](tests/boundaries/check-boundaries.ts):

1. Only `src/engine/**` value-imports engine adapter packages.
2. `src/worker/**` value-imports only the worker-safe provider runtime rehydration modules needed to rebuild runtime descriptors before entering the engine boundary.
3. Cross-domain traffic goes through `SafeEventBus`.

Contributor and review rules live in [`CONTRIBUTING.md`](CONTRIBUTING.md).
Agent-specific operating rules live in [`AGENTS.md`](AGENTS.md).

---

## Development

| Script | Purpose |
| --- | --- |
| `npm run ci` | Full repo gate: typecheck, lint, unit/integration/boundary tests, build, then e2e tests. |
| `npm run typecheck` | Strict TypeScript pass. |
| `npm run format` | Biome formatting pass. |
| `npm run lint` | Biome checks. |
| `npm run test` | Unit, integration, and boundary tests. |
| `npm run test:e2e` | Build first, then run end-to-end tests. |
| `npm run build` | Production bundle via `tsup`. |
| `npm run dev` | `tsup --watch`. |
| `npm run clean` | Remove `dist/`. |
| `npm run hooks:install` | Opt-in pre-commit hook enforcing format and boundaries. |

Recent contributor work also added a self-dev harness in `src/harness/` with hot-reload for some code paths and restart-required signals for the rest. Treat it as a developer convenience layer, not a polished public interface yet.

---

## Roadmap

- **v0.1.2 (current)**: experimental patch release. Adds transient provider retry with persistent transcript visibility, hardens bash subprocess abort with SIGKILL escalation, tightens tool/bash transcript rendering with status and elapsed time, and ships a five-arm `audit.jsonl` (tool calls, mode transitions, run aborts, session park/resume) so sessions leave a complete on-disk trail.
- **v0.1.1**: experimental patch release. Durable transcript replay now preserves rich session entries across resume and fork, and interactive prompts load deterministic `AGENTS.md`/`CODEX.md` project context.
- **v0.1.0-exp**: experimental first release. Target-first config, interactive TUI, receipts and cost ledger, auth and configure flows, model and session controls, dispatchable workers, and an early self-dev harness.
- **Next**: broader runtime hardening, MCP support, richer agent library, deeper developer ergonomics, and more complete context/resource loading.
- **Longer horizon**: first-class CLIO Core integration, multi-agent coding workflows composed at the CLIO Agent layer, scientific-computing recipes.

---

## Lineage and credits

### CLIO family

Clio Coder is a first-class IOWarp product and a coding specialization of the [CLIO Agent](https://iowarp.ai) framework. The CLIO platform is built by the [Gnosis Research Center](https://grc.iit.edu/) at the Illinois Institute of Technology. Companion projects:

- [clio-core](https://github.com/iowarp/clio-core): the Chimaera-based context storage runtime.
- [clio-kit](https://github.com/iowarp/clio-kit): MCP servers for scientific data (HDF5, Slurm, ParaView, Pandas, ArXiv, NetCDF, FITS, Zarr, and more).

Clio Coder is the code-centric sibling of those systems. It is designed to be used standalone and to be composed as a coding primitive inside multi-agent scientific workflows orchestrated by CLIO Agent.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
