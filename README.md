<p align="center">
  <picture>
    <source srcset="assets/banner.webp" type="image/webp" />
    <img src="assets/banner.png" alt="Clio Coder, AI coding harness for supervised repository work" width="100%" />
  </picture>
</p>

<h1 align="center">Clio Coder</h1>

<p align="center"><strong>A supervised AI coding harness for real repository work.</strong></p>

<p align="center">
  Terminal-first. Model-flexible. Agent-aware. Built for developers who want AI assistance without giving up review, control, or auditability.
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

## What is Clio Coder?

Clio Coder is an AI coding harness for supervised work inside software repositories.

It gives you an interactive terminal UI, configurable local and cloud model targets, dispatchable coding agents, persistent sessions, cost receipts, and an audit trail. It is designed for developers and research teams who want AI to help inspect, plan, modify, and review code while keeping humans in control.

Clio Coder is currently in **alpha**. The current release is **v0.1.2**.

Use it if you want to:

- work with AI inside a repository from the terminal;
- connect local models, cloud APIs, or CLI-backed model runtimes;
- dispatch specialized agents for exploration, planning, review, and implementation;
- resume, fork, and compact long coding sessions;
- keep receipts for completed runs, including model, token, cost, and integrity metadata;
- test a serious AI coding workflow before the system is polished.

Do not use it yet if you need a fully stable production coding assistant with a mature plugin ecosystem and zero rough edges.

---

## Why try it now?

Clio Coder is looking for its first alpha users: people willing to test it on real repositories and give precise feedback about where the workflow helps, where it breaks, and where it needs sharper ergonomics.

The most useful alpha users are:

- developers working in non-trivial repositories;
- users running local models through Ollama, LM Studio, llama.cpp, vLLM, SGLang, or OpenAI-compatible servers;
- users with cloud model API keys who want target-first model routing;
- teams that care about receipts, replay, and controlled agent execution;
- researchers building multi-agent or scientific-computing workflows.

Good alpha feedback includes the command you ran, what target/model you used, what you expected, what happened, and whether `clio doctor` or the saved receipt exposed anything useful.

---

## Core features

| Feature | What it gives you |
| --- | --- |
| Interactive terminal UI | Work with an assistant inside your repository without leaving the shell. |
| Target-first model configuration | Route chat and workers through local HTTP runtimes, cloud APIs, OAuth-backed runtimes, or CLI-backed tools. |
| Built-in coding agents | Dispatch `scout`, `planner`, `reviewer`, `worker`, and other focused agents. |
| Persistent sessions | Resume, fork, compact, and replay coding sessions. |
| Project context files | Automatically load `CLIO.md` (canonical) plus any `CLAUDE.md`, `AGENTS.md`, `CODEX.md`, or `GEMINI.md` found from the current directory upward. |
| Safety modes | Use default, advise, or super mode to gate which tools the assistant can see. |
| Receipts and audit logs | Track completed runs, token usage, cost, tool activity, mode changes, aborts, and session park/resume events. |
| Local + cloud model support | Use a local model for private repo exploration, a cloud model for deeper reasoning, or both. |

---

## Install

### Requirements

- Node.js `>=20`
- npm
- A model target, such as:
  - a local OpenAI-compatible server;
  - Ollama, LM Studio, llama.cpp, vLLM, SGLang, or another supported local runtime;
  - a cloud API key;
  - a supported CLI-backed runtime.

### Install from source

This is the recommended alpha path.

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm install
npm run build
npm link
clio
```

`npm link` exposes the `clio` binary from the built output. If you change the TypeScript source, run `npm run build` again before testing the linked command.

### Install from npm

The package is planned for npm distribution.

```bash
npm install -g @iowarp/clio-coder
```

Use the source install path if the npm package is not available yet.

---

## First run

Start Clio Coder from the repository you want to work on:

```bash
cd /path/to/your/repo
clio
```

On first run, Clio Coder creates its config, data, and cache directories. If no usable model target exists, it guides you into configuration.

Useful first commands:

```bash
clio configure
clio targets
clio targets --probe
clio models
clio doctor
```

A good first non-interactive test is:

```bash
clio run --agent scout "Summarize this repository layout and identify the main entry points."
```

Inside the interactive UI, try:

```text
/run scout summarize the repo structure
/run planner propose a safe first change for improving the README
/targets
/model
/cost
/receipts
```

---

## Five-minute alpha test

Use this sequence if you want to quickly decide whether Clio Coder is useful in your environment.

```bash
cd /path/to/your/repo
clio doctor
clio configure
clio targets --probe
clio run --agent scout "Map the repository: key directories, entry points, tests, and likely build commands."
clio
```

Then, inside the TUI:

```text
/run planner identify one small, low-risk improvement
/run reviewer check whether that plan is safe and complete
/receipts
/cost
```

If this fails, open an issue with:

- OS and shell;
- Node.js version;
- Clio Coder version;
- model target and model name;
- command or slash command used;
- relevant `clio doctor` output;
- receipt ID, if one was written;
- redacted logs or screenshots if helpful.

Never paste API keys, private prompts, or proprietary source code into a public issue.

---

## CLI commands

| Command | Purpose |
| --- | --- |
| `clio` | Launch the interactive terminal UI. |
| `clio configure` | Run the configuration wizard. |
| `clio targets` | List configured targets, health, auth, runtime, model, and capabilities. |
| `clio targets add` | Add a target interactively or through flags. |
| `clio targets use <id>` | Set chat and worker defaults to one target. |
| `clio targets remove <id>` | Remove a target. |
| `clio targets rename <old> <new>` | Rename a target id. |
| `clio models [search] [--target <id>]` | List discovered or known models. |
| `clio auth list` | Show known auth entries. |
| `clio auth status [target-or-runtime]` | Inspect auth state. |
| `clio auth login <target-or-runtime>` | Add credentials through the supported flow. |
| `clio auth logout <target-or-runtime>` | Remove stored credentials. |
| `clio doctor [--fix]` | Diagnose state; with `--fix`, repair or create missing state. |
| `clio reset [--state\|--auth\|--config\|--all]` | Reset selected Clio Coder state. |
| `clio uninstall [--keep-config] [--keep-data]` | Remove Clio Coder state and print uninstall guidance. |
| `clio agents` | List built-in agent specs. |
| `clio run [flags] "<task>"` | Dispatch one worker non-interactively and write a receipt. |
| `clio upgrade` | Check for and apply runtime upgrades. |
| `clio --version` | Print the installed version. |
| `clio --no-context-files` (alias `-nc`) | Top-level flag that skips the entire `CLIO.md` / `CLAUDE.md` / `AGENTS.md` / `CODEX.md` / `GEMINI.md` chain for one invocation. |

Example:

```bash
clio run \
  --agent scout \
  --target mini \
  --model Qwen3.6-35B-A3B-UD-Q4_K_XL \
  "Find the test command and summarize the project structure."
```

---

## Interactive slash commands

Slash commands are available inside the terminal UI. Type `/` at the start of the prompt to open autocomplete.

| Command | Purpose |
| --- | --- |
| `/run <agent> <task>` | Dispatch a worker and stream its events into the transcript. |
| `/targets` | Show target health, auth, runtime, model, and capabilities. |
| `/connect [target]` | Connect to a target or runtime. |
| `/disconnect [target]` | Disconnect a target or runtime when Clio owns the connection state. |
| `/model [pattern[:thinking]]` | Open the model selector or set the orchestrator model. |
| `/scoped-models` | Edit the model list used by model cycling. |
| `/thinking` | Open the thinking-level selector. |
| `/settings` | Open interactive settings controls. |
| `/resume` | Resume an existing session. |
| `/new` | Start a fresh session. |
| `/tree` | Navigate the session tree. |
| `/fork` | Branch from an earlier assistant turn. |
| `/compact [instructions]` | Compact earlier session context. |
| `/cost` | Show token and USD totals for completed runs in the session. |
| `/receipts` | Browse saved run receipts. |
| `/receipts verify <runId>` | Verify a receipt against the persisted run ledger. |
| `/help` | Show the slash-command reference. |
| `/hotkeys` | Show resolved keyboard bindings. |
| `/quit` | Exit the TUI cleanly. |

---

## Built-in agents

Clio Coder ships with built-in agent specs for common coding workflows.

| Agent | Use it for |
| --- | --- |
| `scout` | Fast repository exploration and context assembly. |
| `planner` | Turning a goal into a reviewable implementation plan. |
| `researcher` | Documentation, literature, and web-grounded investigation. |
| `reviewer` | Reviewing work against a plan or coding standard. |
| `delegate` | Routing work across multiple sub-agents. |
| `context-builder` | Building focused context bundles for downstream agents. |
| `worker` | General bounded execution tasks. |

Examples:

```bash
clio run --agent scout "Find the main build, test, and lint commands."
clio run --agent planner "Plan a minimal change to add JSON output to the CLI."
clio run --agent reviewer "Review the current diff for correctness and regressions."
```

Agent specs are Markdown files with frontmatter. Built-ins live under:

```text
src/domains/agents/builtins/
```

---

## Model targets and runtimes

Clio Coder is target-first. A target describes how to reach a model and what capabilities it has.

| Group | Examples |
| --- | --- |
| Featured / subscription | `openai-codex` |
| Cloud APIs | `anthropic`, `openai`, `google`, `groq`, `mistral`, `openrouter`, `bedrock`, `deepseek` |
| Local HTTP | `openai-compat`, `lmstudio-native`, `ollama-native`, `llamacpp-completion`, `vllm`, `sglang`, `lemonade` |
| CLI runtimes | `codex-cli`, `claude-code-cli`, `gemini-cli`, `copilot-cli`, `opencode-cli` |
| SDK runtimes | `claude-code-sdk` (Claude Agent SDK worker path) |

Runtime tiers:

| Tier | Meaning |
| --- | --- |
| `protocol` | HTTP targets that speak a supported model API protocol. |
| `cloud` | Managed API providers with API-key, OAuth, or platform auth. |
| `local-native` | Local model runtimes reached through native HTTP or SDK surfaces. |
| `cli-stub` | CLI-backed runtimes launched through installed command-line tools. |
| `sdk` | In-process SDK worker paths (scaffolded in v0.1.x, admitted by dispatch in a later release). |

Inspect target state with:

```bash
clio targets
clio targets --probe
clio models
```

---

## Configuration

Clio Coder reads `settings.yaml` from the platform config directory by default:

| Platform | Default config path |
| --- | --- |
| Linux | `~/.config/clio/settings.yaml` |
| macOS | `~/Library/Application Support/clio/settings.yaml` |
| Windows | `%APPDATA%/clio/settings.yaml` |

You can isolate state with environment variables:

| Env var | Purpose |
| --- | --- |
| `CLIO_HOME` | Optional single-tree root for all Clio Coder state. |
| `CLIO_CONFIG_DIR` | Location of `settings.yaml`. |
| `CLIO_DATA_DIR` | Receipts, ledgers, sessions, and audit logs. |
| `CLIO_CACHE_DIR` | Transient cache location. |
| `ANTHROPIC_API_KEY` | Enables Anthropic-backed targets when configured. |
| `OPENAI_API_KEY` | Enables OpenAI-backed targets when configured. |

Example local target configuration:

```yaml
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

Credentials can come from environment variables referenced by `targets[].auth.apiKeyEnvVar`, or from Clio Coder’s credential store through:

```bash
clio auth login <target-or-runtime>
```

---

## Project context files

Before each interactive turn, Clio Coder looks for project context files from the current working directory upward to the filesystem root.

Supported names, in priority order:

```text
CLIO.md
CLAUDE.md
AGENTS.md
CODEX.md
GEMINI.md
```

Clio Coder walks every directory between the working directory and the filesystem root, parses each file into sections, and merges them into a single instruction block. `CLIO.md` is the canonical source: when two files define the same section header, `CLIO.md` wins and the other file's body is dropped. For files of equal priority, child directories override parent directories. The merged block carries a short provenance footer listing every file that contributed.

To skip the entire context-file chain for a single invocation:

```bash
clio --no-context-files
clio -nc run --agent scout "..."
```

Use these files to tell Clio Coder and other AI agents how to work in your repository.

Example `CLIO.md`:

```markdown
# Agent instructions

- Use `npm run ci` before claiming the repo is healthy.
- Prefer small, reviewable changes.
- Do not edit generated files under `dist/`.
- Do not change public APIs without an explicit plan.
- Keep documentation examples synchronized with CLI behavior.
- When uncertain, inspect the source instead of guessing.
```

This is the best place to encode repository-specific rules, test commands, style constraints, forbidden paths, review requirements, and release procedures.

---

## Safety model

Clio Coder is designed for supervised work. It does not treat the model as an unrestricted shell user.

| Mode | Behavior |
| --- | --- |
| `default` | Read, write, edit, bash, search, and dispatch tools are visible. |
| `advise` | Read-oriented mode. Filesystem mutation is disabled. |
| `super` | Allows privileged writes outside the working directory. Requires explicit confirmation. |

Key safety behavior:

- `Alt+S` opens the super-mode confirmation overlay.
- Dangerous Bash patterns are blocked by hardcoded damage-control rules.
- Known blocked patterns include commands like `rm -rf /`, force-pushing `main`, and raw `dd` writes to block devices.
- Bash subprocess abort escalates from `SIGTERM` to `SIGKILL` after a grace period.
- Tool and bash activity is rendered into the transcript with status, elapsed time, and command previews.

The damage-control rules live in:

```text
damage-control-rules.yaml
```

---

## Sessions, replay, and context compaction

Interactive sessions persist under:

```text
<dataDir>/sessions/
```

Sessions are append-only JSONL with tree metadata. This supports:

- resuming previous sessions;
- replaying rich transcript entries;
- forking from earlier assistant turns;
- compacting old context;
- preserving bash, tool, summary, checkpoint, and branch entries when durable entries exist.

Useful commands:

```text
/resume
/new
/tree
/fork
/compact
```

Automatic compaction can be enabled in settings:

```yaml
compaction:
  threshold: 0.8
  auto: true
```

Manual compaction:

```text
/compact summarize previous implementation details but keep API decisions and test failures
```

---

## Receipts, cost, and auditability

Every completed run writes a receipt to:

```text
<dataDir>/receipts/<runId>.json
```

A receipt records:

- run id;
- model and target;
- token counts;
- estimated USD cost;
- tool statistics;
- integrity metadata;
- a SHA-256 hash over receipt fields plus the matching run ledger entry.

Use:

```text
/receipts
/receipts verify <runId>
/cost
```

Clio Coder also writes structured audit rows under:

```text
<dataDir>/audit/YYYY-MM-DD.jsonl
```

Audit entries cover classified tool calls, mode transitions, run aborts, and session park/resume events.

---

## Keybindings

| Binding | Action |
| --- | --- |
| `Shift+Tab` | Cycle thinking level. |
| `Alt+M` | Cycle mode: `default` / `advise`. |
| `Alt+S` | Open the super-mode confirmation overlay. |
| `Alt+T` | Open the session tree navigator. |
| `Ctrl+L` | Open the model selector. |
| `Ctrl+P` | Cycle the scoped model set forward. |
| `Shift+Ctrl+P` | Cycle the scoped model set backward. |
| `Ctrl+B` | Toggle the dispatch-board overlay. |
| `Ctrl+O` | Toggle the most recent tool segment between collapsed subline and full body. |
| `Ctrl+C` | Cancel a stream, clear input, or press twice to exit. |
| `Ctrl+D` | Exit. |
| `Esc` | Cancel a stream or close the active overlay. |

Run this inside the TUI for the resolved binding table:

```text
/hotkeys
```

---

## Troubleshooting

| Problem | Try this |
| --- | --- |
| `clio: command not found` | Run `npm run build && npm link` from the Clio Coder source tree. |
| No model target is available | Run `clio configure`, then `clio targets --probe`. |
| Local model does not respond | Confirm the local runtime is running and that the target URL is correct. |
| Cloud model auth fails | Check `clio auth status <target>` and verify the relevant API key or login flow. |
| Source changes do not appear | Re-run `npm run build`; the linked CLI points at `dist/`. |
| Session replay looks incomplete | Confirm durable session entries exist for the relevant tool, bash, or display activity. |
| State appears corrupted | Run `clio doctor`; if needed, run `clio doctor --fix`. |
| You need a clean start | Use `clio reset --state`, `--auth`, `--config`, or `--all` depending on what you want to remove. |

For issue reports, include:

```bash
clio --version
node --version
clio doctor
clio targets
```

Redact secrets and private repository content.

---

## For AI agents and coding assistants reading this README

You are reading the product README for **Clio Coder**.

Use these instructions when helping a user with this repository or with Clio Coder itself:

1. Refer to the product as **Clio Coder** and the CLI binary as `clio`.
2. Treat the project as alpha software. Do not imply production stability.
3. Prefer the source install path unless npm availability has been explicitly confirmed.
4. Do not invent unsupported commands, runtimes, plugins, or capabilities.
5. When explaining configuration, use the target-first model: `targets[]`, then `orchestrator`, then `workers.default`.
6. When helping with a repository that uses Clio Coder, inspect `CLIO.md` (and any other context files such as `CLAUDE.md`, `AGENTS.md`, `CODEX.md`, `GEMINI.md`) before proposing changes.
7. Keep safety modes distinct: `default`, `advise`, and `super`.
8. Recommend `clio doctor`, `clio targets --probe`, and receipts when debugging.
9. For repo edits, prefer small, reviewable patches and state which command should validate the change.
10. Do not tell users to paste API keys, private source code, or proprietary prompts into public issues.
11. If asked to summarize this README, preserve the alpha status, install path, model-target concept, safety model, and receipt/audit features.
12. If asked to generate documentation for Clio Coder, keep the tone technical and direct. Avoid hype.

---

## Development

Most users do not need this section. It is for contributors.

| Script | Purpose |
| --- | --- |
| `npm run ci` | Full repo gate: typecheck, lint, tests, build, and e2e tests. |
| `npm run typecheck` | Strict TypeScript pass. |
| `npm run format` | Biome formatting pass. |
| `npm run lint` | Biome checks. |
| `npm run test` | Unit, integration, and boundary tests. |
| `npm run test:e2e` | Build first, then run end-to-end tests. |
| `npm run build` | Production bundle through `tsup`. |
| `npm run dev` | `tsup --watch`. |
| `npm run clean` | Remove `dist/`. |
| `npm run hooks:install` | Install the optional pre-commit hook. |

Core source areas:

```text
src/cli/           CLI entry points
src/interactive/   terminal UI
src/engine/        model/provider engine boundary
src/worker/        worker dispatch and runtime rehydration
src/domains/       domain logic and built-in agent specs
src/harness/       contributor-facing self-development harness
tests/             unit, integration, boundary, and e2e tests
```

Contributor rules live in:

```text
CONTRIBUTING.md
CLIO.md
```

---

## Architecture notes

Clio Coder keeps model execution, worker dispatch, interactive UI state, and domain logic separated.

Boundary tests enforce three important rules:

1. Only `src/engine/**` value-imports engine adapter packages.
2. `src/worker/**` imports only worker-safe provider runtime rehydration modules needed before entering the engine boundary.
3. Cross-domain traffic goes through `SafeEventBus`.

This is intended to keep provider-specific code contained and make the system easier to reason about as more runtimes and agents are added.

---

## Roadmap

Current release:

- **v0.1.2** (alpha). Highlights: transient provider/stream retry with cancel-aware countdowns and persisted recovery, bash abort that escalates `SIGTERM` to `SIGKILL` after a grace period, structured tool and bash transcript rendering with `Ctrl+O` expand toggle and edit-tool diff preview, mode-colored editor rails, slash-command autocomplete, welcome dashboard at TUI launch, per-tool stats in run receipts, five-arm audit JSONL (tool calls, mode changes, run aborts, session park/resume), reasoning probe state surfaced in `clio targets --json`, provider catalog aligned with pi SDK 0.70.2, and `/thinking` plus `clio run` working against local `openai-compat` and LM Studio backends.

Near-term direction:

- broader runtime hardening;
- MCP support;
- richer built-in agent library;
- better first-run and target setup ergonomics;
- more complete context and resource loading;
- stronger docs for local model workflows;
- expanded CLIO Core and CLIO Agent integration.

Longer horizon:

- first-class multi-agent coding workflows;
- deeper scientific-computing recipes;
- composition with CLIO Agent;
- integration with CLIO Core context storage.

---

## Lineage

Clio Coder is part of the IOWarp CLIO family.

Related projects:

- [clio-core](https://github.com/iowarp/clio-core): Chimaera-based context storage runtime.
- [clio-kit](https://github.com/iowarp/clio-kit): MCP servers for scientific data, including HDF5, Slurm, ParaView, Pandas, ArXiv, NetCDF, FITS, Zarr, and more.

Clio Coder is the code-focused sibling: usable as a standalone terminal coding harness and designed to compose into broader CLIO Agent workflows.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
