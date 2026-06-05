# Clio Coder Developer Documentation Hub

Welcome to the developer-facing documentation for **Clio Coder**, the specialized coding agent in IOWarp's CLIO ecosystem of agentic science.

Clio Coder is an **experimental community alpha**. These docs describe the current `v0.2.1` source-build release for early adopters, including local harness telemetry and dashboard improvements, not a production-stable assistant with managed upgrades.

Clio Coder is a **TUI-first, supervised AI coding harness** designed for research, High-Performance Computing (HPC), and scientific-software engineering teams. It routes, gates, and audits AI model activity directly inside active software repositories while keeping human operators in complete control.

Recent git/source audit themes behind this docs pass:

- target-first runtime resolution, model probing, and native local-runtime support;
- resource packaging through prompt templates, skills, extensions, and share archives;
- hardening around default-deny Bash, project path policy, worker admission, and receipts;
- durable sessions, fork/tree/compaction flows, and smaller-terminal TUI controls;
- prompt-envelope delivery, provider tool contracts, and bounded tool outputs for long local runs.
- live headless validation fixes for unknown fleet agents, open stdin, and streamed prompt diagnostics.

---

## 🗺️ Documentation Portal Map

Explore the in-depth system architecture and domain guides below:

| Guide | Core Target Focus |
| :--- | :--- |
| 🏗️ **[Codebase Architecture](architecture.md)** | Source layout, compile-time boundaries, domain loading, and runtime data flow. |
| 🎯 **[Configuration & Targets](configuration-and-targets.md)** | `settings.yaml`, target-first runtimes, model probing, fleet profiles, and auth. |
| 🛡️ **[Multi-Layered Safety Model](safety-model.md)** | Mode matrix, default-deny Bash, `.clio/safety.yaml`, path policy, and typed validation tools. |
| 🧾 **[Prompt Envelope & Tools](prompt-envelope-and-tools.md)** | Hashed prompt-envelope delivery, provider tool contracts, and registry enforcement. |
| 🚢 **[The Agent Fleet](built-in-agents.md)** | Built-in agent recipes, discovery roots, frontmatter schema, and dispatch admission. |
| 📦 **[Extensions & Sharing](extensions-and-sharing.md)** | Prompt/skill resources, extension manifests, and portable share archives. |
| 🧪 **[Local Evaluation Runner](eval-runner.md)** | Reproducible YAML task suites, reports, comparisons, and local command evidence. |
| 🧠 **[Model Catalog & Field Notes](model-catalog.md)** | Runtime model refresh, catalog sources, local/cloud model quirks, and benchmarking notes. |
| 📂 **[Deterministic Evidence & Memory](evidence-and-memory.md)** | Evidence directory structures (`evidenceId`), findings, and operator-approved memory retrieval. |
| 🧮 **[Scientific Validation Contracts](scientific-validation.md)** | Advisory validation-contract patterns for scientific artifacts and HPC assumptions. |
| 🧩 **[Middleware & Components Scanner](middleware-and-components.md)** | Active component snapshots plus the experimental middleware hook/effect contract. |
| 🧬 **[Evolution & Change Manifests](evolution.md)** | Falsifiable Change Manifest JSON templates, auditability, and `clio evolve`. |
| 📋 **[Documentation Standards](documentation-guide.md)** | Source-first docs workflow, mapping matrix, and alpha wording guidance. |

---

## ⚡ Developer Quick Start

To set up a local development environment for Clio Coder:

### Prerequisites
- Node.js `>=22.19.0` and `npm`
- A configured local or cloud model target (Ollama, LM Studio, vLLM, OpenRouter, Anthropic, or OpenAI API)

### Clone and Link Local Code
```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm install
npm run build
npm link
```
The `npm link` registers the `clio` binary pointing at the local built alpha bundle.
> [!WARNING]
> Clio Coder's linked CLI executes from the built `dist/` directory. If you make changes to TypeScript files in `src/`, you **must run `npm run build`** (or have `npm run dev` running in the background) for your changes to take effect.

---

## 🛠️ CLI Reference

Clio Coder exposes a rich command-line interface for headless execution, audits, and configuration:

```text
Usage: clio <command> [options]
```

### Core Operations
- `clio`: Launch the interactive terminal user interface (TUI).
- `clio configure`: Interactively set up and configure model targets.
- `clio doctor [--fix]`: Run environment checks on config, data, and cache paths. With `--fix`, missing files/directories are repaired.
- `clio targets [--probe]`: List all configured targets. With `--probe`, Clio tests live targets and refreshes discovered capabilities.
- `clio targets profile <name> <id>`: Register a named fleet profile.
- `clio models [search] [--probe]`: List configured, catalog, and live-discovered models for targets.
- `clio auth list|status|login|logout`: Inspect or update target/runtime credentials.
- `clio run "<task>"`: Execute a single main-agent turn non-interactively. Use `--json` to stream JSONL events.
- `clio run "<task>" --agent <id>`: Dispatch a specific fleet agent on a single task and write a receipt.

### Registry & Auditing
- `clio components [--json]`: Scan and inventory every behavior-affecting component (prompts, rules, code interfaces).
- `clio evidence list / inspect <evidenceId>`: Query and view details of deterministic evidence corpora.
- `clio eval run / report / compare`: Manage task runner suites and baseline benchmarks.
- `clio memory list / propose / approve / reject / prune`: Oversee long-term evidence-linked memory records.
- `clio extensions list / discover / install / enable / disable / remove`: Manage extension packages and resource overrides.
- `clio share export / import / inspect`: Package and unpack context files, settings fragments, prompts, skills, and extension files.

---

## 🖥️ Interactive TUI Controls

Inside the interactive terminal UI, you can issue autocomplete-supported **slash commands** and use **keyboard shortcuts** to cycle states:

### Interactive Slash Commands
- `/run [options] <agent> <task>`: Stream a dispatched fleet-agent run into the session transcript.
- `/model [pattern[:thinking]]` and `/models`: Open the model selector or set a model by pattern.
- `/thinking`: Open reasoning/thinking controls for thinking-capable models.
- `/targets`: View targets and verify credentials or availability.
- `/connect [target]` / `/disconnect [target]`: Open target auth/connect flows.
- `/skills`, `/skill:<name>`, `/prompts`, `/extensions`, `/share`: Work with resource packages and share archives.
- `/resume` / `/new` / `/tree` / `/fork`: Resume, start, navigate, or branch sessions.
- `/compact [instructions]`: Force prompt-context compaction.
- `/cost` / `/receipts [verify <runId>]`: View cost, receipts, and receipt integrity.
- `/settings` / `/scoped-models` / `/hotkeys` / `/help`: Inspect interactive controls and preferences.

### Keyboard Bindings

App bindings use `Alt + <key>` as the primary scheme, plus `Shift+Tab`, `Ctrl+D`, and the portable `Ctrl+G` leader. Modern terminals and Linux/meta setups send Alt directly. Stock macOS Terminal.app needs **Use Option as Meta key** enabled in Settings ▸ Profiles ▸ Keyboard for native Alt; otherwise use `Ctrl+G` then the Alt binding's letter, or slash commands. `/hotkeys` shows the resolved table.

| Keybinding | Action Enforced |
| :--- | :--- |
| `Alt+M` | Cycle safety enforcement mode: `default` ⟷ `advise`. |
| `Alt+S` | Trigger the Super Mode elevation overlay (one-shot privileges). |
| `Shift+Tab` | Cycle target reasoning thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh` when supported). |
| `Alt+U` | Toggle the footer dashboard between compact and expanded layouts. |
| `Alt+T` | Open the session tree navigator. |
| `Alt+L` | Open the interactive orchestrator model + targets selector. |
| `Alt+J` / `Alt+K` | Cycle forward/backward through the scoped target model set. |
| `Alt+W` | Open/close the Dispatch (workers) Board overlay. |
| `Alt+O` | Expand or collapse the details pane of the most recent tool execution. |
| `Alt+R` | Expand or collapse the most recent thinking block. |
| `Alt+G` | Open the current input in an external editor. |
| `Alt+Enter` | Queue the current input as a follow-up message. |
| `Alt+Up` | Restore queued follow-up messages to the editor. |
| `Alt+X` | Dismiss footer notifications. |
| `Ctrl+D` | Exit the TUI. |
| `Ctrl+G`, then a letter | Portable leader fallback for Alt-letter actions, such as `Ctrl+G` then `u` for the dashboard. |
| `Esc` / `Ctrl+C` | Cancel an active streaming run, close an active overlay, collapse dashboard state, or clear input depending on context. |

---

## 🧪 Development Workflow Invariants

Clio Coder enforces a high-standard contributor policy:
1. **Always green:** Every commit on development branches must leave `npm run ci` green (typecheck, lint, boundary/contract/smoke tests, and build).
2. **Boundary safety:** Never bypass the 3 boundary rules (documented in [architecture.md](architecture.md)).
3. **No raw shell bypass:** Avoid execution of raw shell operations in tools; use typed tool wrappers like `run_tests` and `validate_frontend` to preserve safety audits.
