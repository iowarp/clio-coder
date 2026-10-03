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

Clio Coder is a coding agent for people who maintain scientific and research
software. She connects the model you choose to repository tools, project
context, verification, and worker delegation, so you can understand a codebase,
investigate a failing check, implement a change, or coordinate work across local
and SSH workers. Every run leaves tool activity, changes, checks, and run
receipts you can review.

Clio is built for simulation kernels, numerical libraries, data pipelines, and
mixed-language builds, and works for general software development too. Chat and
workers can use different models on your workstation, an institutional gateway,
or a cloud service.

**Experimental software.** Clio Coder is open-source, pre-1.0 software in active
development. Settings, commands and interfaces may change between minor
releases, so read the [changelog](CHANGELOG.md) before upgrading. Report
problems in [GitHub issues](https://github.com/iowarp/clio-coder/issues);
contributions start with the [contributor guide](CONTRIBUTING.md).

## Get started

You need a model with tool calling. Linux and macOS are the primary platforms.
The installer brings its own Node.js 24 LTS, needs no root, and works on HPC login
nodes with an old glibc or no usable `module load nodejs`:

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
cd /path/to/your/project
clio-coder
```

If coder.iowarp.ai is unreachable, use the copy attached to each GitHub release:
`curl -fsSL https://github.com/iowarp/clio-coder/releases/latest/download/install.sh | sh`
(`install.ps1` sits next to it). The installer verifies the Node download against
SHASUMS256.txt and the Node.js release keys, installs under
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
the launcher directory to your user `PATH` only with `-AddToPath`. A complete
native Windows install of 0.6.0 has not yet been verified end to end, and the
terminal session itself is not routinely tested there.

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
git clone --branch v0.5.9 https://github.com/iowarp/clio-coder.git
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

One runtime serves three surfaces, and they share your saved connections,
settings, and sessions.

**Terminal.** Bare `clio-coder` opens the terminal workspace: conversation, tool
calls, permissions, fleet activity, and context accounting in one screen.

**Headless and ACP.** `clio-coder run` executes one task without a terminal UI,
for scripts and CI, and `clio-coder acp` serves editors and other hosts over the
Agent Client Protocol:

```bash
clio-coder run "Summarize this repository's entry points."
clio-coder run --json --timeout 300 "Run the existing parser tests and report the results."
clio-coder acp
```

Headless text mode writes the answer to stdout and diagnostics to stderr;
`--json` emits JSONL, and calls that would ask for permission are denied.

**Browser.** `clio-coder gui` opens the browser workspace: projects,
conversations, session controls, fleet previews, traces, evidence, and
configuration. It reuses this installation's desktop app when one is
installed, and otherwise starts a private server for this terminal. If Clio is
not configured yet, **Guided setup** in the browser connects a model and reviews
the connection before saving. On Linux, `clio-coder gui background install`
adds the desktop app later. The browser interface is in alpha; see the
[GUI guide](docs/guide/commands-and-modes.md#graphical-application).

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
<summary><strong>Browser conversation view</strong></summary>

During a conversation, the left sidebar switches between project sessions,
recorded runs, and configuration tools while your chat stays open. The collapsible
Artifacts panel holds recorded file activity, results, and linked evidence.
Open a dedicated trace or evidence viewer when you need more inspection space.
Scroll up to read earlier messages; **Jump to latest** returns immediately to the
newest output and resumes following the stream.

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
  use worktrees and SSH nodes, and review compiled fleet plans before execution.
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
  coding-agent connectors or open companion panes with Herdr and Yazi.
- **Reusable procedures and extensions.** Install or author skills, agents,
  prompts, fleets, and plugins. Add executable command tools through declared
  harness extensions.

<details>
<summary><strong>Everyday commands and automation</strong></summary>

| Task | Command |
| --- | --- |
| Choose a model or configure the session | `/model`, `/settings`, `/config` |
| Attach a workspace file | Type `@` and choose a path |
| Inspect tool details, context, memory, or usage | `/view`, `/context`, `/memory`, `/usage` |
| Browse the resource library | `/library` or `Alt+L` |
| Inspect workers and operator tasks | `Alt+W`, `/tasks` |
| Branch or recover a conversation | `/tree`, `/fork`, `/resume` |
| Export a transcript | `/export`, `/export notes.md` |

During a terminal turn, **Enter** steers, **Ctrl+Q** queues a follow-up, and
**Escape** interrupts. On permission cards, **Deny** skips a call and **Stop**
ends the turn.

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

Clio takes serving windows and capabilities from the live inference server
first, then from its packaged model profiles and an optional
`model-profiles.yaml` in your config directory, which can lower a reported
capability but never raise it. `/context` shows where the window came from, and
an unknown window stays unknown instead of guessed. Configure a model with the
tool calling, context window, vision, and reasoning support your workflow
requires. See [connections and targets](docs/guide/configuration-and-targets.md).

## Execution policy

The default policy admits workspace reads, edits, and recognized checks, and
requests permission for unfamiliar commands and outward actions. Permission
cards show the invocation. **Yolo** removes ordinary approval prompts; protected
paths, hard blocks, and damage-control rules continue to apply. In the terminal,
`Ctrl+G` then `y` switches the current session between the default policy and
Yolo without changing saved settings.

Commands execute with your operating-system permissions. Clio's runtime policy
controls tool admission, while project tests, numerical references, performance
budgets, and human review supply your acceptance criteria. See the
[safety model](docs/architecture/safety-model.md) and
[quality policies](docs/guide/quality-policy.md).

## Documentation

Read the [public documentation](https://coder.iowarp.ai/docs.html), open the
installed package’s `docs/` files in your editor, or ask Clio about her own
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
[lookup contract](docs/README.md#where-clio-finds-these-docs-when-it-is-running-in-someone-elses-project).

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
