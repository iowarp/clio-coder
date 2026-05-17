<p align="center">
  <picture>
    <source srcset="assets/banner.webp" type="image/webp" />
    <img src="assets/banner.png" alt="Clio Coder, the coding agent in IOWarp's CLIO ecosystem of agentic science" width="100%" />
  </picture>
</p>

<h1 align="center">Clio Coder</h1>

<p align="center"><strong>The coding agent in IOWarp's CLIO ecosystem of agentic science.</strong></p>

<p align="center">
  Terminal-first. Model-flexible. Agent-aware. Built for HPC and scientific-software developers who want AI assistance on real research code without giving up review, control, or auditability.
</p>

<p align="center">
  <a href="https://github.com/iowarp/clio-coder/releases"><img alt="version" src="https://img.shields.io/badge/version-0.1.8-00d4db?style=flat-square" /></a>
  <a href="#install"><img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions"><img alt="ci" src="https://img.shields.io/badge/ci-passing-147366?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm" src="https://img.shields.io/badge/npm-coming%20soon-lightgrey?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00d4db?style=flat-square" /></a>
</p>

---

## What is Clio Coder?

Clio Coder is the coding agent in IOWarp's CLIO ecosystem of agentic science, part of the NSF-funded IOWarp project at [iowarp.ai](https://iowarp.ai). It targets HPC and scientific-software developers across research-software domains and runs as a supervised AI coding harness inside their repositories.

It gives you an interactive terminal UI, configurable local and cloud model targets, dispatchable coding agents, persistent sessions, cost receipts, and an audit trail. It is designed for developers and research teams who want AI to help inspect, plan, modify, and review code while keeping humans in control.

Clio Coder is currently in **alpha**. The current release is **v0.1.8**.

## What's new in v0.1.8

A supervised-control and configure-hardening release. The headline is that the `claude-code-sdk` runtime now goes through Clio's safety policy with a real overlay for `ask` decisions, and `clio configure` rejects nonsense before it reaches the runtime.

- **Configure validation.** `clio configure --runtime <r> --model <m>` rejects models that are not in the runtime catalog (exit 2, with a known-models listing). `--context-window N` is rejected when it exceeds the catalog max. Both gates share a `--force` flag that warns instead of failing for advanced users.
- **SDK canUseTool wired to Clio safety.** The `claude-code-sdk` runtime now calls Clio's `SafetyContract` for every Claude Code tool request. Allow / block / ask decisions match what native Clio workers would do for the same tool.
- **Bidirectional approval IPC.** Workers and the orchestrator now talk both directions over the worker subprocess's stdin. `clio_tool_approval_request` and `clio_tool_approval_response` NDJSON messages carry safety asks to the TUI and decisions back to the worker.
- **Tool-approval overlay.** Supervised SDK runs open a TUI overlay showing the Claude tool, arguments, classification, and policy hint. `[A]` allows once, `[D]` and `Esc` deny.
- **`--auto-approve` flag.** `clio run --auto-approve <allow|deny>` skips the IPC handshake for headless runs. Unsupervised runs without the flag auto-deny ask decisions and record `"headless ask auto-denied; pass --auto-approve to override"` in the receipt.
- **Receipt accounting for SDK gates.** SDK runs now record allow / elevated / blocked counts and populate `safety.blockedAttempts` so the receipt reflects what Clio actually gated.
- **gemini-cli token fix.** Receipts for gemini runs now show real `tokenCount` values; the parser reads the per-call `stats` field gemini's `stream-json` emits.

See [CHANGELOG.md](CHANGELOG.md) for the full entry.

## Use it if

- you want AI assistance inside a real repository from the terminal;
- you run local models (Ollama, LM Studio, llama.cpp, vLLM, SGLang) or have cloud API keys;
- you care about supervised execution, receipts, and audit trails;
- you can tolerate alpha rough edges and report them.

## Skip it if

- you need a fully stable production coding assistant with a mature plugin ecosystem.

---

## Core features

| Feature | What it gives you |
| --- | --- |
| Interactive terminal UI | Work with an assistant inside your repository without leaving the shell. |
| Target-first model configuration | Route chat and workers through local HTTP runtimes, cloud APIs, OAuth-backed runtimes, or CLI-backed tools. |
| Built-in coding agents | Dispatch `scout`, `planner`, `reviewer`, `worker`, and other focused agents. |
| Persistent sessions | Resume, fork, compact, and replay coding sessions. |
| Project context | Use checked-in `CLIO.md` as the canonical project guide, with `/init` and `clio init` to fold existing agent instruction files into it. |
| Safety modes | Use default, advise, or super mode to gate which tools the assistant can see. |
| Receipts and audit logs | Track completed runs, token usage, cost, tool activity, mode changes, aborts, and session park/resume events. |
| Local + cloud model support | Use a local model for private repo exploration, a cloud model for deeper reasoning, or both. |

---

## Install

### Requirements

- Node.js `>=22`
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
git checkout v0.1.8
npm install
npm run build
npm link
clio
```

`npm link` exposes the `clio` binary from the built output. Use the latest GitHub release tag for reproducible installs, or omit `git checkout v0.1.8` if you intentionally want the current development branch. If you change the TypeScript source, run `npm run build` again before testing the linked command.

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
clio doctor
clio configure
clio targets --probe
clio
```

On first run, Clio Coder creates its config, data, and cache directories. If no usable model target exists, configuration guides you through one.

For local runtimes, use the matching `--runtime` so Clio can manage the resident-model lifecycle (eviction, `keep_alive`, GPU placement):

```bash
clio configure --runtime lmstudio-native --id lmstudio --url http://127.0.0.1:1234 --model your-model
clio configure --runtime ollama-native   --id ollama   --url http://127.0.0.1:11434 --model your-model
clio configure --runtime llamacpp        --id llamacpp --url http://127.0.0.1:8080  --model your-model
clio configure --runtime vllm            --id vllm     --url http://127.0.0.1:8000  --model your-model
clio configure --runtime sglang          --id sglang   --url http://127.0.0.1:30000 --model your-model
```

Migrate older `openai-compat` targets pointing at LM Studio or Ollama with `clio targets convert <id> --runtime <native>`.

For OpenRouter free-model testing:

```bash
clio configure --runtime openrouter --id openrouter-free --model tencent/hy3-preview:free --api-key-env OPENROUTER_API_KEY --set-orchestrator --set-worker-default
clio targets --probe --target openrouter-free
```

Quick smoke test, non-interactive:

```bash
clio run --agent scout "Summarize this repository layout and identify the main entry points."
```

Inside the TUI, try:

```text
/run scout summarize the repo structure
/run planner propose one small, low-risk improvement
/run reviewer check whether that plan is safe and complete
/targets
/model
/cost
/receipts
```

When something breaks, open an issue with `clio --version`, `node --version`, the command you ran, the target/model, what you expected, and what happened. Redact secrets, private prompts, and proprietary code.

---

## CLI commands

| Command | Purpose |
| --- | --- |
| `clio` | Launch the interactive terminal UI. |
| `clio configure` | Run the configuration wizard. |
| `clio init [--yes]` | Create or refresh `CLIO.md` and local project fingerprint state. |
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
| `clio components [--json]` | List behavior-affecting harness components. |
| `clio components snapshot --out <path>` | Write a component snapshot JSON file. |
| `clio components diff --from <a> --to <b>` | Compare two component snapshots. |
| `clio evolve manifest init\|validate\|summarize` | Create and check typed harness change manifests. |
| `clio evidence build\|inspect\|list` | Build and inspect deterministic evidence artifacts. |
| `clio eval run\|report\|compare` | Run local eval task files and compare results. |
| `clio memory list\|propose\|approve\|reject\|prune` | Manage scoped, evidence-linked memory records. |
| `clio extensions list\|discover\|install\|enable\|disable\|remove` | Manage installed extension packages and their resource roots. |
| `clio share export --out <path>` | Export project context, prompts, skills, settings fragments, and extension bundles into a Clio share archive. |
| `clio share import <path> [--dry-run] [--force]` | Import a Clio share archive with conflict reporting. |
| `clio export --out <path>` / `clio import <path>` | Short aliases for `clio share export` and `clio share import`. |
| `clio --print [@files...] "<task>"` (alias `-p`) | Run one non-interactive chat turn, optionally including text file references, and print only the assistant text. |
| `clio run [flags] "<task>"` | Dispatch one worker non-interactively and write a receipt. |
| `clio upgrade` | Check for and apply runtime upgrades. |
| `clio --version` | Print the installed version. |
| `clio --no-context-files` (alias `-nc`) | Top-level flag that skips loading `CLIO.md` project context for one invocation. |

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
| `/init` | Create or refresh the checked-in `CLIO.md` project guide. |
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
| `/extensions` | List installed extension packages and active/shadowed/disabled state. |
| `/share export <path>` | Export the current project resources to a Clio share archive. |
| `/share import [--dry-run] [--force] <path>` | Preview or apply a Clio share archive import. |
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
| `memory-curator` | Proposing scoped memory records from evidence artifacts. |
| `debugger` | Explaining a failing run, session, or evidence id. |
| `regression-scout` | Finding likely regressions and targeted negative tests. |
| `middleware-author` | Drafting declarative middleware rules for review. |
| `attributor` | Mapping eval changes to keep, rollback, or inconclusive calls. |
| `evolver` | Drafting change manifests and minimal implementation plans. |
| `benchmark-runner` | Running eval suites and summarizing budget and failures. |
| `scientific-validator` | Drafting validation contracts for scientific artifacts. |

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
| Local HTTP | `openai-compat`, `lmstudio-native`, `ollama-native`, `llamacpp`, `vllm`, `sglang`, `lemonade` |
| CLI runtimes | `codex-cli`, `claude-code-cli`, `gemini-cli`, `copilot-cli`, `opencode-cli` |
| SDK runtimes | `claude-code-sdk` (Claude Agent SDK worker path) |

Runtime tiers:

| Tier | Meaning |
| --- | --- |
| `protocol` | HTTP targets that speak a supported model API protocol. |
| `cloud` | Managed API providers with API-key, OAuth, or platform auth. |
| `local-native` | Local model runtimes reached through native HTTP or SDK surfaces. |
| `cli-gold`, `cli-silver`, `cli-bronze`, `cli` | CLI-backed runtimes launched through installed command-line tools. |
| `sdk` | In-process SDK worker paths such as the Claude Agent SDK. |

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
| `CLIO_DATA_DIR` | Receipts, ledgers, sessions, audit logs, evidence, evals, and memory. |
| `CLIO_CACHE_DIR` | Transient cache location. |
| `ANTHROPIC_API_KEY` | Enables Anthropic-backed targets when configured. |
| `OPENAI_API_KEY` | Enables OpenAI-backed targets when configured. |
| `OPENROUTER_API_KEY` | Enables OpenRouter-backed targets when configured. |

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

## Project context

Clio Coder uses `CLIO.md` as the canonical project guide. Before each interactive turn, it loads the nearest applicable `CLIO.md` and includes that guidance in the prompt unless `--no-context-files` is set.

Run `/init` in the TUI or `clio init` from the shell to create or refresh this file. During init, Clio can read existing agent instruction files and fold their useful content into `CLIO.md` so the repository has one explicit source of guidance:

```text
CLAUDE.md
AGENTS.md
CODEX.md
GEMINI.md
```

Clio stores local fingerprint state under `.clio/state.json` so it can warn when `CLIO.md` no longer matches the current project state and should be refreshed.

To skip project context for a single invocation:

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

## Extensions and sharing

Clio extension packages are filesystem bundles with a `clio-extension.yaml` manifest. User extensions install under the Clio config directory, project extensions install under `.clio/extensions`, and project packages shadow user packages with the same `id`. Extension resources are loaded as low-priority package roots, so user and project prompts or skills still override package defaults.

Minimal extension manifest:

```yaml
manifestVersion: 1
id: lab-pack
name: Lab Pack
version: 1.0.0
description: Prompts and skills for this lab
resources:
  prompts: prompts
  skills: skills
```

Install and inspect packages:

```bash
clio extensions discover ./lab-pack
clio extensions install ./lab-pack --project
clio extensions list --all
clio extensions disable lab-pack --project
```

Share archives are single JSON files with `kind: "clio-share-archive"`, `formatVersion: 1`, a stable `manifest.files[]` index, and per-file SHA-256 checks. They can carry project context files, project/user prompt templates, skills, non-secret settings fragments, and extension bundle files.

```bash
clio share export --out project.clio-share.json --project
clio share import project.clio-share.json --dry-run
clio share import project.clio-share.json --force
```

Dry-run imports report destination conflicts without writing files. Forced imports overwrite conflicting files and merge supported settings-fragment keys.

---

## Safety model

Clio Coder is designed for supervised work. It does not treat the model as an unrestricted shell user.

### Modes

| Mode | Behavior |
| --- | --- |
| `default` | Read, write, edit, search, typed git/test/build tools, and default-deny Bash. Bash only admits the curated allowlist or audited project policy entries. |
| `advise` | Read-oriented analysis, planning, and review. Dispatch admission is readonly. Worker recipes that need write/execute scope are rejected. |
| `super` | Explicit operator elevation. Base hard blocks still apply. External CLI/SDK runtimes do not map to bypass/full-access unless `CLIO_ALLOW_EXTERNAL_FULL_ACCESS=1`. |

`Alt+S` opens the super confirmation overlay for one-shot privileged calls. `safetyLevel` in settings (`suggest`, `auto-edit`, `full-auto`) shifts prompt posture but does not override the enforcement gate.

### Enforcement layers

1. **Damage-control rules.** Base hard blocks for things like `rm -rf /`, `git push --force`, `dd` writes to block devices, fork bombs, and pipe-to-shell installers. Applied identically in the orchestrator and native workers. See `damage-control-rules.yaml`.
2. **Default-deny Bash.** Default mode denies arbitrary Bash. The allowlist covers common engineering commands (see [docs/specs/safety-model.md](docs/specs/safety-model.md) for the full list). Anything else needs an audited project policy entry or super elevation. Shell operators are denied unless a project policy entry explicitly opts in.
3. **Typed execution tools.** `git_status`, `git_diff`, `git_log`, `run_tests`, `run_lint`, `run_build`, `package_script` use fixed argv vectors with bounded cwd, timeouts, and output caps. No `/bin/bash -lc`.
4. **Project policy.** `.clio/safety.yaml` (schema v1) defines reviewed commands with `id`, `command`, optional relative `cwd`, `timeoutMs`, `maxOutputBytes`, `actionClass`, `shellOperators`, `env`, `requireConfirmation`, `rationale`, `owner`, `comment`. Strict validation: unknown keys, wrong types, absolute cwd, and `..`-escaping cwd reject the entire policy. Entries without `cwd` are bound to the policy root. Active runs use the snapshot the engine loaded at start, so an agent cannot edit and benefit from the new allowlist in the same run.
5. **Dispatch admission.** Worker scope must be a subset of orchestrator scope, and the worker's requested action classes must fit inside its scope. Unknown tools classify as `unknown` and fail closed.
6. **External runtimes.** Subprocess CLIs (Claude Code, Codex, Gemini, Copilot, OpenCode) and the Claude Agent SDK are delegated sandboxes. Clio chooses conservative permission modes by default and refuses to map super to bypass without the explicit opt-in flag. Receipts call out this limitation for those runtimes.

The full spec lives in [docs/specs/safety-model.md](docs/specs/safety-model.md).

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
- cwd, git commit, branch, dirty-state count, and dirty-state hash;
- token counts;
- estimated USD cost;
- tool statistics;
- safety decision counts and blocked attempts;
- worker mode, dispatch scope, requested action classes, and external runtime limitations;
- damage-control rule-pack hash and project safety policy fingerprint;
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

Audit entries cover classified tool calls, mode transitions, run aborts, and session park/resume events. Tool rows include action class, decision, rule id, reason code, policy source, command, cwd, mode, and redacted arguments where available.

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

## For AI assistants reading this README

The product is **Clio Coder**, CLI binary `clio`. It is alpha software; do not imply production stability or invent commands, runtimes, or capabilities. Configuration is target-first (`targets[]` → `orchestrator` → `workers.default`). Inspect `CLIO.md` before proposing changes. Keep `default`, `advise`, and `super` modes distinct. Recommend `clio doctor`, `clio targets --probe`, and receipts when debugging.

---

## Development

Most users do not need this section. It is for contributors.

| Script | Purpose |
| --- | --- |
| `npm run ci` | Local and GitHub gate: typecheck, lint, tests, build, and e2e. |
| `npm run typecheck` | Strict TypeScript pass. |
| `npm run format` | Biome formatting pass. |
| `npm run lint` | Biome checks. |
| `npm run test` | Unit, integration, and boundary tests. |
| `npm run check:boundaries` | Boundary invariants only. |
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

Boundary tests enforce three rules at build time:

1. **Engine boundary.** Only `src/engine/**` value-imports `@earendil-works/pi-*`. Type-only imports are allowed anywhere.
2. **Worker isolation.** `src/worker/**` never imports `src/domains/**` except `src/domains/providers`, which carries pure runtime descriptors the worker rehydrates from stdin.
3. **Domain independence.** `src/domains/<x>/**` never imports another domain's `extension.ts`. Cross-domain traffic flows through `SafeEventBus`.

This keeps provider-specific code contained and the system easier to reason about as more runtimes and agents are added.

---

## Roadmap

Current release: **v0.1.8** alpha (supervised SDK control plus configure validation). See [CHANGELOG.md](CHANGELOG.md) for prior releases.

Near-term:

- MCP support;
- broader runtime hardening and clearer first-run ergonomics;
- more complete context and resource loading;
- stronger docs for local model workflows;
- closer integration with CLIO Core and CLIO Agent.

Longer horizon:

- first-class multi-agent coding workflows;
- deeper scientific-computing recipes;
- composition with CLIO Agent and CLIO Core context storage.

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
