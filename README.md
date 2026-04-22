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

Status: **v0.1.0-dev**. Pre-release. Expect sharp edges. See [CHANGELOG.md](CHANGELOG.md) for release notes and [docs/guides/overview.md](docs/guides/overview.md) for the phase roll-up.

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
clio install                                    # bootstrap config/data/cache dirs and seed settings.yaml
clio setup                                      # guided setup wizard
clio providers                                  # probe endpoints and register models
clio                                            # start the interactive TUI
```

`clio setup` writes the selected endpoint under `providers.<engine>.endpoints`, updates `provider.active` / `provider.model`, and points both `orchestrator` and `workers.default` at the same target so chat and workers are usable immediately. Re-run `clio setup` later to switch from the current target to any engine without hand-editing YAML.

After setup, `clio run scout "summarize the repo layout"` dispatches a worker and writes a receipt.

Append `--faux` to `clio run` for a provider-less smoke test.

Start the interactive TUI with bare `clio`. The banner renders as `◆ clio  IOWarp orchestrator coding-agent`. The surface gives you a prompt, the dispatch-board overlay (`Ctrl+B`), and the slash-command parser documented below.

---

## CLI commands

| Command | What it does |
| --- | --- |
| `clio` | Launch the interactive TUI. |
| `clio install` | Bootstrap the resolved config/data/cache dirs and seed `settings.yaml` with commented `llamacpp@mini` and `lmstudio@dynamo` examples. |
| `clio setup` | Guided provider setup. Probes configured endpoints, updates chat and worker targets, and writes valid settings. |
| `clio doctor` | Parse settings, resolve XDG paths, and report health. |
| `clio providers` | Probe configured endpoints and register discovered models into the pi-ai runtime catalog. |
| `clio agents` | List builtin agent specs. |
| `clio run <agent> <task>` | Dispatch a single worker non-interactively and persist a receipt. |
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
| `/cost` | Overlay session token totals and USD cost accumulated from completed runs. |
| `/receipts` | Paginated list of run receipts persisted under `<dataDir>/receipts/`. |
| `/receipt verify <runId>` | Read a receipt and report whether its ledger hash matches on disk. |
| `/help` | Show the slash-command reference. |
| `/quit` | Exit the TUI cleanly. |

Parser source: [`src/interactive/`](src/interactive/).

---

## Keybindings

| Binding | Action |
| --- | --- |
| `Shift+Tab` | Cycle safety mode `default` ⇄ `advise`. |
| `Alt+S` | Open the super-mode confirmation overlay. |
| `Ctrl+B` | Toggle the dispatch-board overlay. Rows update live from the dispatch event bus. |
| `Ctrl+D` | Trigger the four-phase shutdown. |

---

## Configuration

Clio reads from the platform config dir by default: `~/.config/clio/settings.yaml` on Linux, `~/Library/Application Support/clio/settings.yaml` on macOS, and `%APPDATA%/clio/settings.yaml` on Windows. Every path is overridable via XDG or Clio-specific env vars so you can keep dev and prod state separate.

The happy path is `clio install` followed by `clio setup`. The guided setup writes the selected local engine into `runtimes.enabled`, keeps nested defaults intact, and updates both the chat target and worker target together.

```yaml
# Linux default: ~/.config/clio/settings.yaml (excerpt)
providers:
  llamacpp:
    endpoints:
      mini:
        url: http://127.0.0.1:8080
        default_model: Qwen3.6-35B-A3B-UD-Q4_K_XL
  lmstudio:
    endpoints:
      dynamo:
        url: http://127.0.0.1:1234
        default_model: qwen3.6-35b-a3b

runtimes:
  enabled:
    - native
    - llamacpp

provider:
  active: llamacpp
  model: Qwen3.6-35B-A3B-UD-Q4_K_XL

orchestrator:
  provider: llamacpp
  endpoint: mini
  model: Qwen3.6-35B-A3B-UD-Q4_K_XL

workers:
  default:
    provider: llamacpp
    endpoint: mini
    model: Qwen3.6-35B-A3B-UD-Q4_K_XL
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `CLIO_HOME` | unset | Optional single-tree root for all Clio state. |
| `CLIO_CONFIG_DIR` | platform config dir, or `$CLIO_HOME` when set | Location of `settings.yaml`. |
| `CLIO_DATA_DIR` | platform data dir, or `$CLIO_HOME/data` when set | Receipts, ledgers, sessions. |
| `CLIO_CACHE_DIR` | platform cache dir, or `$CLIO_HOME/cache` when set | Transient caches. |
| `ANTHROPIC_API_KEY` | — | Enables Claude providers. |
| `OPENAI_API_KEY` | — | Enables OpenAI providers. |

---

## Providers

| Tier | Provider | Notes |
| --- | --- | --- |
| Hosted | `anthropic` | Claude Sonnet, Opus, and Haiku. Thinking-content supported. |
| Hosted | `openai` | GPT-5 and GPT-4o. |
| Local | `llamacpp` | OpenAI-compatible `llama.cpp` servers. Qwen thinking-content passes through via the `thinkingFormat` compat field. |
| Local | `lmstudio` | LM Studio endpoints. |
| Local | `ollama` | Ollama endpoints. |
| Local | `openai-compat` | Any OpenAI-compatible HTTP endpoint. |

Each local runtime reads its endpoint list from `settings.yaml` and registers discovered models into the pi-ai runtime catalog under the provider id.

The simplest local path is `clio setup` for `llamacpp@mini`. Use the interactive menu to switch the defaults while keeping the earlier `mini` endpoint in the config.

---

## Runtimes

Runtime tiers classify how a worker process is started and spoken to.

| Tier | Status in v0.1 | What it is |
| --- | --- | --- |
| `native` | Admitted | Clio's own worker subprocess on `pi-agent-core`. The only tier dispatch accepts in v0.1. |
| `sdk` | Scaffolded, rejected | Claude Agent SDK adapter. Code exists, dispatch refuses to spawn it in v0.1. |
| `cli` | Scaffolded, rejected | Adapters for `pi-coding-agent`, `claude-code`, `codex`, `gemini`, `opencode`, and `copilot`. Dispatch refuses to spawn in v0.1. |

SDK and CLI tiers ship for v0.2. The v0.1 rejection is deliberate so that one worker path is fully hardened before more surface area lands.

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

Thirteen domains under [`src/domains/`](src/domains/): `config`, `providers`, `safety`, `modes`, `prompts`, `session`, `agents`, `dispatch`, `observability`, `scheduling`, `intelligence`, `lifecycle`, and `ui` (folded under `src/interactive/` in v0.1).

Three hard invariants are enforced at build time by [`scripts/check-boundaries.ts`](scripts/check-boundaries.ts):

1. Only `src/engine/**` imports pi-mono packages.
2. `src/worker/**` never imports `src/domains/**`.
3. Cross-domain traffic goes through `SafeEventBus`.

Full design: [docs/specs/2026-04-16-clio-coder-design.md](docs/specs/2026-04-16-clio-coder-design.md). Engine boundary detail: [docs/architecture/pi-mono-boundary-0.68.1.md](docs/architecture/pi-mono-boundary-0.68.1.md).

---

## Development

Full script index: [docs/guides/scripts.md](docs/guides/scripts.md).

| Script | Purpose |
| --- | --- |
| `npm run ci` | Repo gate. Typecheck, lint, boundary checks, prompt checks, CI diag suite, production build, verify, smoke. |
| `npm run typecheck` | Strict TypeScript pass. |
| `npm run lint` | Biome. |
| `npm run build` | Production bundle via `tsup`. |
| `npm run dev` | `tsup --watch`. |
| `npm run check:boundaries` | Enforce engine, worker, and domain boundaries. |
| `npm run stress` | Ten concurrent faux runs against the shared run ledger. |
| `npm run stress:real` | Opt-in real-provider variant against `llamacpp@mini` and `lmstudio@dynamo`. Excluded from CI. |
| `npm run inference:live` | End-to-end real-inference probe against the homelab. Excluded from CI. |
| `npm run vision:live` | Vision-inference probe. Excluded from CI. |
| `npm run hooks:install` | Opt-in pre-commit hook enforcing format and boundaries. |
| `npm run diag:*` | Forty-plus subsystem probes. Run `npm run | grep diag:` for the full list. |

CI runs on GitHub Actions, matrix `ubuntu-latest` and `macos-14`, with a ten-minute timeout per job.

---

## Roadmap

- **v0.1 (current)**: native runtime, local provider dispatch, interactive TUI, receipts and cost ledger, three-mode safety, dispatch-board overlay.
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
