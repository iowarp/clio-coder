<p align="center">
  <picture>
    <source srcset="assets/banner.webp" type="image/webp" />
    <img src="assets/banner.png" alt="Clio Coder — the CLIO Agent for your science" width="100%" />
  </picture>
</p>

<h1 align="center">Clio Coder</h1>

<p align="center"><strong>The CLIO Agent for your science.</strong></p>

<p align="center">
  A composable coding agent inside the <a href="https://iowarp.ai">CLIO Agent</a> framework.
</p>

<p align="center">
  <a href="https://github.com/iowarp/clio-coder/releases"><img alt="version" src="https://img.shields.io/badge/version-0.1.0--dev-00d4db?style=flat-square" /></a>
  <a href="#install"><img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions"><img alt="ci" src="https://img.shields.io/badge/ci-passing-147366?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm" src="https://img.shields.io/badge/npm-coming%20soon-lightgrey?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00d4db?style=flat-square" /></a>
  <a href="https://github.com/mariozechner"><img alt="pi-mono" src="https://img.shields.io/badge/pi--mono-0.68.1-241131?style=flat-square" /></a>
</p>

---

## Table of contents

1. [What is Clio Coder?](#what-is-clio-coder)
2. [Install](#install)
3. [First run](#first-run)
4. [CLI commands](#cli-commands)
5. [Slash commands](#slash-commands)
6. [Keybindings](#keybindings)
7. [Configuration](#configuration)
8. [Providers](#providers)
9. [Runtimes](#runtimes)
10. [Agents](#agents)
11. [Safety model](#safety-model)
12. [Receipts and cost](#receipts-and-cost)
13. [Architecture at a glance](#architecture-at-a-glance)
14. [Development](#development)
15. [Roadmap](#roadmap)
16. [Lineage and credits](#lineage-and-credits)
17. [License](#license)

---

## What is Clio Coder?

Clio Coder is the coding specialization of the [CLIO Agent](https://iowarp.ai) framework, the autonomous-agent layer of the [IOWarp](https://iowarp.ai) platform. It is a terminal-first coding agent that researchers, scientists, and developers can install and drive directly, and a composable coding primitive that larger CLIO-based multi-agent systems can embed.

Status: **v0.1.0-dev**. Pre-release. Useful for active development and local experimentation, but still moving fast enough that docs, config shape, and runtime coverage can change between short release windows. The native worker path is the one being hardened first; broader runtime coverage and some developer ergonomics are ahead of the maturity curve.

Recent focus in this dev cycle:

- unified endpoint auth and setup flows across the CLI and interactive UI
- provider controls, model selection, scoped-model cycling, session navigation, and better live response UX in the TUI
- safer uninstall and reset flows for wiping or reseeding local state
- an experimental self-dev harness for hot-reload and restart-required feedback while working on Clio itself

---

## Install

Prerequisites: Node.js `>=20`.

### From source (current path for v0.1)

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm install
npm run build && npm link
clio install
clio setup
clio
```

`npm link` exposes the `clio` binary declared in [`package.json`](package.json) (`dist/cli/index.js`). Re-run `npm run build` after source changes because the link points at built output, not the TypeScript sources.

### From npm

```bash
npm install -g @iowarp/clio-coder   # coming with v0.1.0
```

### Isolated state trees

The runtime is XDG-aware and also honors `CLIO_HOME`, `CLIO_CONFIG_DIR`, `CLIO_DATA_DIR`, and `CLIO_CACHE_DIR` so you can sandbox a dev install from your daily config. The full walkthrough lives in [docs/guides/interactive-test-walkthrough.md](docs/guides/interactive-test-walkthrough.md).

---

## First run

```bash
clio install                         # bootstrap config/data/cache dirs and seed settings.yaml
clio setup                           # add or edit an endpoint
clio auth list                       # optional: show connectable providers
clio connect <provider-or-endpoint>  # optional: OAuth/API-key flow for hosted providers
clio providers                       # probe configured endpoints and show health/capabilities
clio                                 # start the interactive TUI
```

`clio setup` writes endpoint entries into `settings.yaml` under `endpoints[]`, and can also point `orchestrator` and `workers.default` at the same target so chat and worker dispatch are aligned immediately. Re-run it to add, remove, rename, or retarget endpoints without hand-editing the whole file.

For a non-interactive run, `clio run --agent scout "summarize the repo layout"` dispatches a worker and writes a receipt. Use `--endpoint`, `--model`, `--thinking`, and `--require` when you want a one-off override without changing defaults.

Start the interactive TUI with bare `clio`. The banner renders as `◆ clio  IOWarp orchestrator coding-agent`. The current surface includes provider and model controls, session navigation, receipts and cost overlays, and the slash-command parser documented below.

---

## CLI commands

| Command | What it does |
| --- | --- |
| `clio` | Launch the interactive TUI. |
| `clio install` | Bootstrap the resolved config/data/cache dirs and seed `settings.yaml`. |
| `clio setup` | Create, edit, remove, rename, or retarget endpoints. Supports interactive and non-interactive flows. |
| `clio uninstall` | Remove Clio state or reset it to a fresh default install with guarded flags. |
| `clio doctor` | Parse settings, resolve XDG paths, and report health. |
| `clio providers` | Probe configured endpoints and report health, capabilities, and discovered models. |
| `clio list-models` | List discovered or known models per endpoint. |
| `clio connect [provider|endpoint]` | Start an OAuth or API-key connect flow for a supported runtime. |
| `clio disconnect <provider|endpoint>` | Remove stored credentials for a provider or endpoint. |
| `clio auth [list|status]` | List supported connectable providers or show current auth status. |
| `clio agents` | List builtin agent specs. |
| `clio run [flags] "<task>"` | Dispatch a single worker non-interactively and persist a receipt. |
| `clio upgrade` | Check for and apply runtime upgrades. |
| `clio --version` | Print the installed version. |

Source: [`src/cli/`](src/cli/).

---

## Slash commands

Available inside the interactive TUI.

| Command | What it does |
| --- | --- |
| `/run <agent> <task>` | Dispatch a worker and stream its events into the transcript. |
| `/providers` | Overlay provider and endpoint health from the providers domain. |
| `/connect [target]` | Connect a provider or endpoint from the TUI. |
| `/disconnect [target]` | Disconnect stored provider auth from the TUI. |
| `/model` or `/models` | Open the model selector for the orchestrator target. |
| `/scoped-models` | Edit the scoped list used by model cycling. |
| `/thinking` | Open the thinking-level selector. |
| `/settings` | Open interactive settings controls. |
| `/resume` and `/new` | Resume an existing session or start a fresh one. |
| `/tree` and `/fork` | Navigate the session tree or branch from an earlier assistant turn. |
| `/compact [instructions]` | Compact earlier session context. |
| `/cost` | Overlay session token totals and USD cost accumulated from completed runs. |
| `/receipts` | Paginated list of run receipts persisted under `<dataDir>/receipts/`. |
| `/receipt verify <runId>` | Read a receipt and report whether its ledger hash matches on disk. |
| `/help` | Show the slash-command reference. |
| `/hotkeys` | Show the current keyboard and slash-command reference. |
| `/quit` | Exit the TUI cleanly. |

Parser source: [`src/interactive/`](src/interactive/).

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

---

## Configuration

Clio reads from the platform config dir by default: `~/.config/clio/settings.yaml` on Linux, `~/Library/Application Support/clio/settings.yaml` on macOS, and `%APPDATA%/clio/settings.yaml` on Windows. Every path is overridable via XDG or Clio-specific env vars so you can keep dev and prod state separate.

The happy path is still `clio install` followed by `clio setup`, but the config shape is now endpoint-first: local HTTP engines, cloud APIs, and OAuth-backed providers all land in `endpoints[]`, then `orchestrator` and `workers.default` select from those endpoint ids.

```yaml
# Linux default: ~/.config/clio/settings.yaml (excerpt)
version: 1
endpoints:
  - id: mini
    runtime: llamacpp
    url: http://127.0.0.1:8080
    defaultModel: Qwen3.6-35B-A3B-UD-Q4_K_XL
    capabilities:
      contextWindow: 262144
      reasoning: true

orchestrator:
  endpoint: mini
  model: Qwen3.6-35B-A3B-UD-Q4_K_XL
  thinkingLevel: off

workers:
  default:
    endpoint: mini
    model: Qwen3.6-35B-A3B-UD-Q4_K_XL
    thinkingLevel: off

scope:
  - mini

compaction:
  threshold: 0.8
  auto: true
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `CLIO_HOME` | unset | Optional single-tree root for all Clio state. |
| `CLIO_CONFIG_DIR` | platform config dir, or `$CLIO_HOME` when set | Location of `settings.yaml`. |
| `CLIO_DATA_DIR` | platform data dir, or `$CLIO_HOME/data` when set | Receipts, ledgers, sessions. |
| `CLIO_CACHE_DIR` | platform cache dir, or `$CLIO_HOME/cache` when set | Transient caches. |
| `ANTHROPIC_API_KEY` | — | Enables Claude providers. |
| `OPENAI_API_KEY` | — | Enables OpenAI providers. |

Other provider-specific credentials can live in environment variables referenced by `endpoints[].auth.apiKeyEnvVar`, or in Clio's credential store when you use `clio connect`.

---

## Providers

| Group | Examples | Notes |
| --- | --- | --- |
| Featured / subscription | `openai-codex` | ChatGPT Plus/Pro via Codex OAuth. Recent work has made this a first-class connectable option. |
| Cloud APIs | `anthropic`, `openai`, `google`, `groq`, `mistral`, `openrouter`, `bedrock` | API-key-backed runtimes. Use `clio auth list` or `clio connect` to inspect the current support surface. |
| Local HTTP | `llamacpp`, `lmstudio`, `lmstudio-native`, `ollama`, `ollama-native`, `openai-compat`, `vllm`, `sglang`, `tgi` | Configured as `endpoints[]` with a URL and optional capability overrides. |
| CLI runtimes | `codex-cli`, `claude-code-cli`, `gemini-cli` | Recognized by the registry and support surfaces, but not admitted for dispatch in v0.1. |

`clio providers` probes configured endpoints and reports health, capability flags, and discovered models. `clio list-models` gives a flatter per-endpoint model view.

---

## Runtimes

Runtime tiers classify how a worker process is started and spoken to.

| Tier | Status in v0.1 | What it is |
| --- | --- | --- |
| `native` | Admitted | Clio's own worker subprocess on `pi-agent-core`. This is the only execution tier dispatch accepts in `0.1.0-dev`. |
| `sdk` | Partially integrated, rejected for dispatch | SDK-backed runtimes can be described and surfaced in setup/auth flows, but execution is not yet admitted. |
| `cli` | Partially integrated, rejected for dispatch | CLI-backed runtimes such as Codex and Claude Code are present in the registry and support tables, but dispatch still rejects them. |

That split is intentional. The project is broad enough now that discovery, setup, auth, and UI coverage move ahead of the stable execution contract. The current release line is still about hardening one worker path instead of pretending all registered runtimes are equally mature.

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

Every completed run writes a receipt to `<dataDir>/receipts/<runId>.json`. A receipt records token counts, USD cost, the model and endpoint used, and a hash of the event ledger.

```bash
/receipts                   # paginated list in the TUI
/receipt verify <runId>     # re-hash the ledger and report match / mismatch
/cost                       # session-level token and USD totals
```

Receipts are the source of truth for cost accounting and the audit trail. Nothing else in the system is trusted to report cost.

---

## Architecture at a glance

Core logic is split across [`src/domains/`](src/domains/), [`src/interactive/`](src/interactive/), [`src/engine/`](src/engine/), [`src/worker/`](src/worker/), and the contributor-facing self-dev harness in [`src/harness/`](src/harness/).

Three hard invariants are enforced by the boundary tests in [`tests/boundaries/check-boundaries.ts`](tests/boundaries/check-boundaries.ts):

1. Only `src/engine/**` imports pi-mono packages.
2. `src/worker/**` never imports `src/domains/**`.
3. Cross-domain traffic goes through `SafeEventBus`.

Full design: [docs/specs/2026-04-16-clio-coder-design.md](docs/specs/2026-04-16-clio-coder-design.md). Engine boundary detail: [docs/architecture/pi-mono-boundary-0.68.1.md](docs/architecture/pi-mono-boundary-0.68.1.md).

---

## Development

Full script index: [docs/guides/scripts.md](docs/guides/scripts.md).

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

- **v0.1 (current)**: native runtime, endpoint-first provider config, interactive TUI, receipts and cost ledger, auth/setup flows, model and session controls, and early self-dev harness support.
- **v0.2**: real tool implementations beyond stubs, SDK runtime admitted, CLI runtime admitted, MCP support, richer agent library.
- **Longer horizon**: first-class CLIO Core integration, multi-agent coding workflows composed at the CLIO Agent layer, scientific-computing recipes.

See [docs/superpowers/plans/](docs/superpowers/plans/) for detailed phase plans.

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
