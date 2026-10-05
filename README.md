<p align="center">
  <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" alt="Clio Coder — IOWarp's coding agent for scientific software" width="100%" />
</p>

# Clio Coder

**A coding agent for scientific software and everyday engineering.**<br />
Your models. Your machines. Work you can inspect.

<p align="center">
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm version" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?color=00a6ad&amp;style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/iowarp/clio-coder?color=147366&amp;style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/iowarp/clio-coder/ci.yml?branch=main&amp;style=flat-square" /></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00a6ad?style=flat-square" /></a>
  <a href="https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318"><img alt="NSF award 2411318" src="https://img.shields.io/badge/NSF-%232411318-241131?style=flat-square" /></a>
</p>
<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#capabilities">Capabilities</a> ·
  <a href="#interfaces">Interfaces</a> ·
  <a href="#models">Models</a> ·
  <a href="https://coder.iowarp.ai">Website</a> ·
  <a href="docs/README.md">Documentation</a>
</p>

Clio Coder connects your choice of model to a coding workspace: repository
context, tools, verification, and delegated workers. Use it in the terminal,
in the desktop app (alpha), in unattended scripts with `clio-coder run`, or
inside an editor through ACP. Chat and workers can use different models on your
workstation, an institutional gateway, or a cloud service.

Built for scientific and research software, Clio also handles everyday
engineering: understanding a mixed-language build, investigating a failing
check, implementing a change, or coordinating a fleet. Tool activity, diffs,
verification results, and sealed worker receipts make the work inspectable.
You choose the tools, model connections, and authority each workflow receives.

**Experimental software.** Clio Coder is open-source, pre-1.0 software in active
development. Settings, commands and interfaces may change between minor
releases, so read the [changelog](CHANGELOG.md) before upgrading. Report
problems in [GitHub issues](https://github.com/iowarp/clio-coder/issues);
contributions start with the [contributor guide](CONTRIBUTING.md).

## Get started

You need a model with tool calling. Linux and macOS are the primary platforms.
The installer brings its own Node.js 24, needs no root, and supports older
x64 Linux hosts with glibc 2.17 or newer, including HPC login nodes without a
usable `module load nodejs`:

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
cd /path/to/your/project
clio-coder
```

If coder.iowarp.ai is unreachable, use the copy attached to each GitHub release:
`curl -fsSL https://github.com/iowarp/clio-coder/releases/latest/download/install.sh | sh`
(`install.ps1` sits next to it). The installer checks the Node download against
SHASUMS256.txt and attempts release-signature verification when `gpgv` or `gpg`
is available. It installs under
`~/.local/share/clio-coder-install` (`~/Library/Application Support/clio-coder/install`
on macOS), and writes the launcher to `~/.local/bin/clio-coder`. On a Linux
terminal it also offers the desktop app, which starts at login and appears in
your app menu; `--gui` or `--no-gui` answers up front. See
[HPC clusters](docs/guide/hpc-clusters.md) for old glibc, proxies and airgapped
sites.

With your own **Node.js 22.19 or newer**, npm works too:

```bash
npm install -g @iowarp/clio-coder
```

Native Windows support is best effort. In PowerShell, run
`irm https://coder.iowarp.ai/install.ps1 | iex`; in CMD, run
`curl.exe -fsSL https://coder.iowarp.ai/install.cmd -o install.cmd && install.cmd && del install.cmd`.
Both install under `%LOCALAPPDATA%\clio-coder\install` with the launcher
`%USERPROFILE%\.local\bin\clio-coder.cmd`, need no administrator rights, and add
the launcher directory to your user `PATH` only with `-AddToPath`. CI builds and
boots the binary on Windows and tests selected subprocess contracts, but the native Windows installed-package flow is not CI-verified.
The 0.6.1 installer was checked by hand on one x64 host with PowerShell 5.1
(install, repair, rollback and uninstall); 0.6.0's installer fails there, so
install 0.6.1 or newer. Interactive terminal use there remains best effort.

**First run.**

1. Run `clio-coder` in your project. On a new machine it starts setup: choose
   **Guided setup**, then either a route Clio already detected (a local model
   server, a saved login, or an API key in your environment) or the description
   you recognize: an app on this computer, a model server, an AI subscription,
   a provider account, or an installed coding agent. Clio probes the endpoint
   when the provider allows it and lets you pick from its model list.
   **Connect by endpoint** is the shortcut when you already know a URL. A home
   that is already set up opens chat on its saved route, or on a route Clio
   detects when the saved one is missing.
2. Give a concrete request:

   > Explain how this repository builds and runs its tests. Identify the main
   > entry points and suggest one verification task. Do not change files yet.

3. Use `/help` for commands, `/model` for model selection, `/config` to rerun
   setup, and `/settings` for every saved default. See the
   [settings walkthrough](docs/guide/configuration-and-targets.md#settings-center)
   for model inheritance and session, project, and global saves.
   `clio-coder doctor` checks the installation and connections.

**Update and remove.** Installer installs update in the background: an idle interactive session checks
the install's channel at most once a day, installs a newer release beside the
current one, and switches the launcher to it; a running session keeps its
version until you restart and `/resume`. Opt out with `--no-auto-update` or
`CLIO_CODER_AUTO_UPDATE=0`. An exact `--version` pins the install;
`clio-coder upgrade` then holds it there and prints the command that follows the
channel again. `clio-coder upgrade`, or `/upgrade` in the terminal, updates on
demand, and `clio-coder upgrade --rollback` returns to the previous version and
turns background updates off.

For global npm, pnpm and Bun installs, the terminal checks the npm registry at
most once a day and shows a notice when a newer release is out.
`clio-coder upgrade` updates an npm install; for pnpm and Bun it prints the
package-manager command to run.

`clio-coder reset` clears session state and keeps the launcher;
`clio-coder uninstall` removes settings, credentials, data, state and caches,
with `--keep-config` to keep settings and credentials and `--remove-binary` to
also remove the launcher, the private Node and every installed version.

<details>
<summary><strong>Package managers and source installation</strong></summary>

```bash
# pnpm
pnpm add -g @iowarp/clio-coder

# Bun; clio-coder still runs on Node.js 22.19 or newer from PATH
bun add -g @iowarp/clio-coder

# Run without a global install
npx --yes @iowarp/clio-coder@latest

# The installer skips the Claude Agent SDK (about 224 MB) by default.
# To include it at install time instead of fetching it on first use:
curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --include-claude-sdk
```

From source, build the release tag:

```bash
git clone --branch v0.6.1 https://github.com/iowarp/clio-coder.git
cd clio-coder
corepack enable pnpm
pnpm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
"$HOME/.local/bin/clio-coder" --version
command -v clio-coder
```

See [installation and lifecycle](docs/guide/installation-and-lifecycle.md) for
upgrade, launcher, background service, and uninstall options.

</details>

## Interfaces

Choose the surface that fits the task. All use Clio's model connections,
project context, tools, and execution policy.

**Terminal.** Bare `clio-coder` opens the conversation with inline tool calls,
diffs, approval cards, and worker activity. During a turn, Enter queues your
message for the next steering slot; `Alt+K` opens the queue to edit, reorder,
remove, or defer messages, and `Alt+S` interrupts with your draft. `/resume`
reopens a saved session. Partial project-instruction coverage appears as a
brief footer notice, keeping the welcome screen quiet.

**Desktop app (alpha).** `clio-coder gui` opens a workspace with a task rail per
project and a Session column for model health, context, spend, branches,
evidence, artifacts, workers, and session notices. First-run setup connects a
model before you start. Multiple tasks can stay open, with up to four active
turns; idle tasks park after five minutes and resume when shown again.

The app runs through a local server and browser. `clio-coder gui` reuses the
installed desktop service when available; otherwise it starts a private server
for the terminal. On Linux, `clio-coder gui background install` adds the desktop
launcher and login service through a systemd user session. Focusing one existing window requires the installed
Chrome or Edge app; the native Linux launcher opens a browser tab per launch.
See the [GUI guide](docs/guide/commands-and-modes.md#graphical-application).

**Headless runs.** `clio-coder run` executes a task for scripts and CI. Text mode
writes the answer to stdout and diagnostics to stderr; `--json` streams JSONL.
There is no operator to answer questions or permissions, so put decisions in
the task prompt and expect permission asks to be denied. `--allow-tools` limits
the main agent's capabilities, while `--delegate-tools` separately limits what
dispatched workers may hold.

```bash
clio-coder run "Summarize this repository's entry points. Do not change files."
clio-coder run --json --timeout 300 "Run the existing parser tests and report the results."
```

**Editors and ACP.** `clio-coder acp` serves an editor or another host over the
Agent Client Protocol. Attended clients can handle approvals and questions;
Clio sends live usage, plan, and workspace updates. Clio's ACP extensions expose
artifacts, worker receipts, shell commands, and steering-queue controls. Client
support determines which extensions are available in your editor.

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/tui-boot.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/tui-boot.webp" alt="Clio Coder terminal boot with the model, workspace, fleet, composer, and guidance footer" width="1000" /></a>
</p>
<p align="center"><sub>Terminal workspace. Select a capture to open its full-resolution image.</sub></p>
<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-overview.png"><picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-overview-light.webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-overview.webp" alt="Clio Coder browser overview with project selection, recent conversations and navigation for traces, fleet, evidence, library and settings" width="1000" />
  </picture></a>
</p>

<details>
<summary><strong>Conversation and evidence views</strong></summary>

Use the task rail to move between conversations and the Session column to
inspect the active task. Session notices sit with the model, context, and trust
facts they describe. Trace and evidence views provide deeper inspection of
recorded work. The captures below show earlier browser layouts; the desktop
app now groups these controls in the task rail and Session column.

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-conversation.png"><picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-conversation-light.webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-conversation.webp" alt="Browser conversation with project-grouped sessions, a compact composer, model selection and harness controls" width="800" />
  </picture></a>
</p>
<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-artifacts.png"><picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-artifacts-light.webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-artifacts.webp" alt="Conversation with seven passing temperature-calibration tests and recorded verification results in the collapsible right Artifacts panel" width="800" />
  </picture></a>
</p>

[Watch a real calibration verification (33 seconds, MP4)](https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/recordings/gui-calibration.mp4)
· [GIF preview](https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/recordings/gui-calibration-preview.gif)

</details>

## Capabilities

- **Repository tools and scientific verification.** Read, search, edit, inspect
  Git, and run declared tests, builds, numerical comparisons, and performance
  checks. Repository quality policies map changed paths to required checks and
  track whether their evidence matches the current covered inputs.
- **Project context and navigation.** Combine an authored `CLIO-CODER.md`
  handbook, layered rules, a Tree-sitter codemap, bounded project orientation,
  and current Git and operator-task observations. Retrieve detail as needed.
- **Long-running conversations.** Working-set selection keeps model context
  within its budget while retaining the session ledger. Recall previous
  observations, inspect `/context`, and branch, resume, or prepare a handoff.
- **Workers and fleets.** Assign recipes with declared tools, scope, model, and
  result contracts. Compose parallel, sequential, review, and other workflows;
  use isolated task worktrees, and review compiled fleet plans before execution.
  Worker receipts record outcomes, validation, and the model that ran the task.
  SSH worker nodes are experimental; see the experimental features below.
- **Inspectable execution.** View tool activity, diffs, traces, token and cost
  accounting, checks, and sealed run records. Review and accept memory proposals
  linked to recorded evidence.
- **System One decisions (experimental).** Bind a fast decision engine to
  typed decision sites: the operator's request, a proposed tool call, external
  tool output, a finished turn, catalog ranking, direct consultation, and
  `/draft` judging. Answers are calibrated probabilities, and a site changes
  nothing until a fitted cut exists for the answering build. `clio-coder doctor`
  shows the bindings. See [System One](docs/guide/system-one.md).
- **Scientific infrastructure and agent interoperability.** Connect MCP
  servers, including clio-kit Slurm workflows. Delegate through supported
  coding-agent connectors, subject to their trust and tool-governance limits.
- **Reusable procedures and extensions.** Install or author skills, agents,
  prompts, fleets, and plugins through `clio-coder library` or `/library`.
  Library packages can be pinned and checked for drift. Add executable command
  tools through declared harness extensions; project plugins and extensions
  require workspace trust before they load.

<details>
<summary><strong>Everyday commands and automation</strong></summary>

| Task | Command |
| --- | --- |
| Choose a model or configure the session | `/model`, `/settings`, `/config` |
| Attach a workspace file | Type `@` and choose a path |
| Inspect tool details, context, memory, or usage | `/view`, `/context`, `/memory`, `/usage` |
| Browse the resource library | `/library` or `Alt+L` |
| Inspect workers and operator tasks | `/fleet`, `/tasks` |
| Branch or recover a conversation | `/tree`, `/fork`, `/resume` |
| Export a transcript | `/export`, `/export notes.md` |

During a terminal turn, **Enter** queues for the next steering slot, **Alt+K**
opens the queue, and **Escape** interrupts. On permission cards, **Deny** skips
a call and **Stop** ends the turn.

```bash
# Prepare project guidance and the codemap
clio-coder context init

# Manage skills, agents, prompts, fleets and plugins; /library does the same in the terminal
clio-coder library search review
clio-coder library install skill:ast-grep
```

A focused worker can run inside a terminal session:

```text
/run verifier Review the current diff and run the relevant existing checks. Do not edit files.
```

See [commands and modes](docs/guide/commands-and-modes.md),
[output formats](docs/guide/exit-codes-and-output.md), and
[workers and fleets](docs/guide/fleet-dispatch.md).

</details>

<details>
<summary><strong>Experimental features</strong></summary>

These features are experimental, and their configuration and behavior may change:

- **System One** binds fast decision engines to typed sites and applies decisions
  only with fitted cuts. See [System One](docs/guide/system-one.md).
- **Steering triage** (`chat.steering.triage`) is off by default. A side model can
  classify queued messages, defer unrelated work, or interrupt for a confident
  stop request.
- **Speculative dispatch** (`fleet.speculativeDispatch`) is off by default.
- **SSH worker nodes** use `clio-coder fleet nodes` to add, test, and install
  nodes. A node needs a passing recorded `test --record` before dispatch;
  `fleet.defaultNode` sets a standing preference.
- **Docks and music** require Herdr and are off by default. Worker (`Alt+W`),
  Yazi file (`Alt+E`), and music (`Alt+A`) docks hide and show without stopping
  their process; a second tap within 400 ms closes the dock. `/music` needs
  cliamp and `integrations.music.enabled`; the optional model-controlled
  `music` tool also needs `integrations.music.agentControl`.

</details>

## Models

A saved model connection is a **target**. Chat and workers can use different
targets, models, and thinking settings. `/model` changes the current session;
**Settings → Fleet** configures worker defaults.

| Connection | Supported runtimes and services |
| --- | --- |
| Local and self-hosted | Ollama, LM Studio, llama.cpp, vLLM, SGLang, Lemonade |
| Gateways | LiteLLM, OpenAI-compatible and Anthropic-compatible APIs |
| Cloud APIs | OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, DeepSeek, Amazon Bedrock, Inception Mercury |
| Subscription sign-in | ChatGPT through `openai-codex`; Claude through `anthropic-max` |
| Institutional inference | Argonne ALCF Sophia and Metis through Globus OAuth |

Serving limits come from the live inference server, explicit target settings,
or a labeled cloud-catalog estimate. Model profiles describe capabilities and
thinking controls; a profile's maximum context is never the loaded serving
window. Live reports decide tool calling, vision, and reasoning support; a
target override can lower those capabilities but cannot raise them. An unreported window stays
unknown. See [connections and targets](docs/guide/configuration-and-targets.md).

The five packaged local profiles are **gpt-oss-20b, Qwen3.8-27B, Gemma 4
26B-A4B, Nemotron 3.5 Lightning 30B-A3B, and Qwen3.5-4B**, checked against their
upstream model cards and templates. They describe upstream behavior, not a
benchmark or a guarantee for every runtime or quantization. Add local profiles
in your config directory's `model-profiles.yaml`; profiles for earlier
finetunes are no longer packaged.

## Execution policy

**Approvals and trust.** The default policy admits workspace reads, edits, and
recognized checks, and requests permission for unfamiliar commands and outward
actions. Approval cards name the tool, target, effect, and requester; Bash
approvals describe the command's consequence. **Yolo** removes ordinary approval
prompts while protected paths, hard blocks, and damage-control rules still apply.
In the terminal, `Ctrl+G` then `y` toggles the session's autonomy.

Project plugins and extensions stay unloaded until approved with
`clio-coder config trust plugins` or `clio-coder config trust extensions`.
An ignored project copy does not shadow your own trusted copy. Review project
safety grants with `clio-coder config trust safety`.

**Worker boundaries.** Each dispatched worker receives an immutable permit for
its tools, asks, and Git allowance. Native worker commands use an OS sandbox
when `safety.sandbox: auto` finds a backend: bubblewrap on Linux or Seatbelt on
macOS. Writes are confined to the worker's roots and private scratch space;
`.git` and `.clio-coder` remain read-only to those commands. Network is off
unless the worker holds `web_fetch` or `safety.sandboxNetwork` is enabled.
Set `safety.sandbox: required` to refuse commands when no backend is available.
Main-agent commands are not OS-sandboxed. External agents that manage their own
tool loop require `trustedUnmediated: true` for write-capable work.

**Information flow (advanced and opt-in).** Rules in `.clio-coder/safety.yaml`
can restrict named paths or tool content to approved model recipients. Those
restrictions follow workers, resume, and compaction, and still apply at Yolo.
The policy format may change; a project with no rules keeps the default behavior.

Commands execute with your operating-system permissions, subject to the worker
sandbox where active. Clio's runtime policy controls tool admission; project
tests, numerical references, performance budgets, and human review supply the
acceptance criteria. See the [safety model](docs/architecture/safety-model.md)
and [quality policies](docs/guide/quality-policy.md).

## Documentation

Read the [public documentation](https://coder.iowarp.ai/docs.html), open the
installed package’s `docs/` files in your editor, or ask Clio about its own
configuration and source through the offline `clio_docs` capability. The package
includes authored guides, architecture documentation, prompt fragments, agent
recipes, and runtime source.

| Topic | Reference |
| --- | --- |
| Complete documentation map | [Documentation index](docs/README.md) |
| Configuration and model setup | [Connections](docs/guide/configuration-and-targets.md) · [Configuration reference](docs/guide/configuration-reference.md) |
| Verification and delegation | [Tool usage](docs/guide/tool-usage.md) · [Fleet dispatch](docs/guide/fleet-dispatch.md) |
| Context and session continuity | [Project context](docs/architecture/project-context.md) · [Context continuity](docs/guide/context-continuity.md) |
| Skills, plugins, and executable extensions | [Library](library/README.md) · [Harness extensions](docs/guide/harness-extensions.md) |
| Architecture and source ownership | [Architecture](docs/architecture/architecture.md) |
| Generated development reference, v0.1 | [Wiki](https://github.com/iowarp/clio-coder/wiki) |

<details>
<summary><strong>For agents</strong></summary>

For work on this repository, read [CONTRIBUTING.md](CONTRIBUTING.md) and the
relevant architecture guide. A local `CLIO-CODER.md` may provide checkout guidance.
Use source, schemas, and focused behavioral tests to resolve implementation questions.

For questions about an installed Clio, use `clio-coder --help` and its bundled docs.
CLI commands use `clio-coder …`; slash commands run inside an interactive session.
Retrieve documentation through
`gateway(op="call", capability="clio_docs", args={query: "your question"})`.
Its citations resolve relative to the installed package root; see the
[lookup contract](docs/README.md#where-clio-coder-finds-these-docs-when-it-is-running-in-someone-elses-project).

</details>

## Contribute

Clio is experimental, actively developed pre-1.0 software. Contributions target
the current version branch; `main` advances with releases. Bug reports should
include the Clio and Node versions, reproduction steps, and relevant diagnostics.

[Issues](https://github.com/iowarp/clio-coder/issues) ·
[Discussions](https://github.com/iowarp/clio-coder/discussions) ·
[Contributor guide](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) ·
[Changelog](CHANGELOG.md)

Report security concerns through [SECURITY.md](SECURITY.md).

General questions about Clio Coder: coder@iowarp.ai.

## Acknowledgements

Clio Coder is developed by the [Gnosis Research Center](https://grc.iit.edu) at
[Illinois Tech](https://www.iit.edu), in collaboration with the
[University of Utah](https://www.utah.edu), as part of [IOWarp](https://iowarp.ai).
The IOWarp CLIO architecture is supported by the National Science Foundation
under collaborative awards
[OAC-2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318) and
[OAC-2411319](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411319), 2024–2029.

Clio builds on the [Pi agent framework](https://github.com/earendil-works/pi),
[ACP](https://agentclientprotocol.com), and [MCP](https://modelcontextprotocol.io).
Dependency and component notices are in [NOTICE](NOTICE).

CLIO means **Context Layer for Input/Output**. Related IOWarp projects include
[clio-core](https://github.com/iowarp/clio-core) for data and context storage and
[clio-kit](https://github.com/iowarp/clio-kit) for scientific tool servers.
