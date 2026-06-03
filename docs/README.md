# Clio Coder Developer Documentation Hub

Welcome to the developer-facing documentation for **Clio Coder**, the specialized coding agent in IOWarp's CLIO ecosystem of agentic science.

Clio Coder is an **experimental community alpha**. These docs describe the current `v0.2.0` source-build release for early adopters, not a production-stable assistant with managed upgrades.

Clio Coder is a **TUI-first, supervised AI coding harness** designed for research, High-Performance Computing (HPC), and scientific-software engineering teams. It routes, gates, and audits AI model activity directly inside active software repositories while keeping human operators in complete control.

---

## 🗺️ Documentation Portal Map

Explore the in-depth system architecture and domain guides below:

| Guide | Core Target Focus |
| :--- | :--- |
| 🏗️ **[Codebase Architecture](architecture.md)** | Compile-time boundaries (Engine, Worker, Domains), Event Bus data flows, and codebase directory layout. |
| 🛡️ **[Multi-Layered Safety Model](safety-model.md)** | Code-level enforcement, L3/L4/L5 sandboxing, default-deny Bash, `.clio/safety.yaml`, and `validate_frontend`. |
| 🚢 **[The Agent Fleet](built-in-agents.md)** | Detailed specs for all 15+ built-in specialized agents (planner, scout, scientific-validator) and creating custom agent recipes. |
| 🧪 **[Local Evaluation Runner](eval-runner.md)** | Running reproducible YAML task benchmark suites, baseline vs. candidate comparisons, and wall-time/token/cost metrics. |
| 🧠 **[Model Catalog & Field Notes](model-catalog.md)** | Runtime model refresh, catalog sources, local/cloud model quirks, and reusable benchmarking note templates. |
| 📂 **[Deterministic Evidence & Memory](evidence-and-memory.md)** | Evidence directory structures (`evidenceId`), findings, and operator-approved long-term memory retrieval rules. |
| 🧮 **[Scientific Validation Contracts](scientific-validation.md)** | Declarative NetCDF/HDF5/Zarr checks, absolute/relative/ULP numerical tolerances, and Slurm/MPI integration. |
| 🧩 **[Middleware & Components Scanner](middleware-and-components.md)** | The filesystem component scanner, snapshot diffs, reload classes, and in-process middleware rules. |
| 🧬 **[Evolution & Change Manifests](evolution.md)** | Falsifiable Change Manifest JSON templates, auditability, and progress-tracking via `clio evolve`. |
| 📋 **[Documentation Standards](documentation-guide.md)** | Technical standards, mapping matrix to `src/` directories, HSL Alert systems, and formatting guidelines. |

---

## ⚡ Developer Quick Start

To set up a local development environment for Clio Coder:

### Prerequisites
- Node.js `>=22` and `npm`
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
- `clio targets [--probe]`: List all configured targets. With `--probe`, Clio tests the HTTP connections and returns model capabilities.
- `clio models [search] [--probe]`: List configured, catalog, and live-discovered models for targets.
- `clio run "<task>"`: Execute a single main-agent turn non-interactively. Use `--json` to stream NDJSON events.
- `clio run "<task>" --agent <id>`: Dispatch a specific fleet agent on a single task and write a receipt.

### Registry & Auditing
- `clio components [--json]`: Scan and inventory every behavior-affecting component (prompts, rules, code interfaces).
- `clio evidence list / inspect <evidenceId>`: Query and view details of deterministic evidence corpora.
- `clio eval run / report / compare`: Manage task runner suites and baseline benchmarks.
- `clio memory list / propose / approve / reject / prune`: Oversee long-term evidence-linked memory records.
- `clio extensions list / install / remove`: Manage installed extension packages and resource overrides.
- `clio share export / import`: Package and unpack settings, prompts, and extension resource roots into a single Clio share archive.

---

## 🖥️ Interactive TUI Controls

Inside the interactive terminal UI, you can issue autocomplete-supported **slash commands** and use **keyboard shortcuts** to cycle states:

### Interactive Slash Commands
- `/run <agent> <task>`: Stream a dispatched agent run into the session transcript.
- `/model [pattern]`: Open the orchestrator model selector or set it via string. In the selector, `r` refreshes the selected target and `R` refreshes all targets.
- `/thinking`: Toggle reasoning effort settings for thinking-capable models.
- `/targets`: View targets and verify credentials or availability. In the overlay, `r` probes the selected target and `R` probes all targets.
- `/resume` / `/new`: Resume previous interactive sessions or start a new one.
- `/fork`: Branch a session tree from an earlier message turn.
- `/compact`: Force prompt-context compaction to free up token windows.
- `/cost` / `/receipts`: View total session receipts and USD cost breakdowns.
- `/help`: Print the command reference.

### Keyboard Bindings

App bindings use `Alt + <key>` as the primary scheme, plus `Shift+Tab`, `Ctrl+D`, and the portable `Ctrl+G` leader. Modern terminals and Linux/meta setups send Alt directly. Stock macOS Terminal.app needs **Use Option as Meta key** enabled in Settings ▸ Profiles ▸ Keyboard for native Alt; otherwise use `Ctrl+G` then the Alt binding's letter, or slash commands. `/hotkeys` shows the resolved table.

| Keybinding | Action Enforced |
| :--- | :--- |
| `Alt+M` | Cycle safety enforcement mode: `default` ⟷ `advise`. |
| `Alt+S` | Trigger the Super Mode elevation overlay (one-shot privileges). |
| `Shift+Tab` | Cycle target reasoning thinking levels (`off`, `low`, `medium`, `high`). |
| `Alt+U` | Toggle the footer dashboard between compact and the expanded 2×2 quadrant view. |
| `Alt+L` | Open the interactive orchestrator model + targets selector. |
| `Alt+J` / `Alt+K` | Cycle forward/backward through the scoped target model set. |
| `Alt+W` | Open/close the Dispatch (workers) Board overlay (visual fleet tracker). |
| `Alt+O` | Expand or collapse the details pane of the most recent tool execution. |
| `Alt+R` | Expand or collapse the most recent thinking block. |
| `Alt+G` | Open the current input in an external editor. |
| `Alt+X` | Dismiss footer notifications. |
| `Ctrl+G`, then a letter | Portable leader fallback for Alt-letter actions, such as `Ctrl+G` then `u` for the dashboard. |
| `Esc` / `Ctrl+C` | Cancel an active streaming run, close an active overlay, or collapse the dashboard. |

---

## 🧪 Development Workflow Invariants

Clio Coder enforces a high-standard contributor policy:
1. **Always green:** Every commit on development branches must leave `npm run ci` green (typecheck, formatting, lints, boundaries, unit/e2e tests).
2. **Boundary safety:** Never bypass the 3 boundary rules (documented in [architecture.md](architecture.md)).
3. **No raw shell bypass:** Avoid execution of raw shell operations in tools; use typed tool wrappers like `run_tests` and `validate_frontend` to preserve safety audits.
