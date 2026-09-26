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

Clio Coder connects a model to repository tools, project context, verification,
and worker delegation. Use her to understand a codebase, investigate a failing
check, implement a change, or coordinate a workflow across local and SSH workers.
The runtime records tool activity, changes, checks, and run receipts for review.

Developed for simulation kernels, numerical libraries, data pipelines, and
mixed-language builds, Clio also supports general software development. Chat and
workers can use different models on your workstation, an institutional gateway,
or a cloud service. Clio is open-source, pre-1.0 software with active development.

## Get started

Requires **Node.js 22.19 or newer** and a model with tool calling. Linux and macOS
are the primary platforms; Windows support is best effort.

```bash
npm install -g @iowarp/clio-coder
cd /path/to/your/project
clio-coder configure
clio-coder
```

1. Choose **Guided setup**, then pick the description you recognize: an app on
   this computer, a model server, an AI subscription, or a provider account.
   Clio fills in the internal connection name, probes the endpoint when the
   provider allows it, and lets you select from the model list instead of typing
   an id. **Connect by endpoint** remains a shortcut when you already know a URL.
2. Start Clio in your project and give a concrete request:

   > Explain how this repository builds and runs its tests. Identify the main
   > entry points and suggest one verification task. Do not change files yet.

3. Use `/help` for commands, `/model` for model selection, and `/settings` for
   configuration. `/settings` keeps configure's section names and order, from
   **Connections** through **Advanced**. Reopen **Connections → Add a target**
   for Guided setup, **Chat** to change the answering model, or **Fleet** for
   worker defaults. See the [settings walkthrough](docs/guide/configuration-and-targets.md#settings-center)
   for model inheritance and session, project, and global saves.
   `clio-coder doctor` checks installation and connections.

Prefer a browser workspace? After installing the same package, run:

```bash
clio-coder gui --open
```

If you have already configured Clio, open a project and start a conversation.
Otherwise, **Guided setup** in the browser connects your app, server, subscription,
or provider account, selects a model, and reviews the connection before saving.
You can enter a key or follow the browser sign-in instructions there; running
`clio-coder configure` first is optional. The terminal and GUI share your saved
connections and settings. Bare `clio-coder` still opens the terminal workspace.

<details>
<summary><strong>Package managers and source installation</strong></summary>

```bash
# pnpm
pnpm add -g @iowarp/clio-coder

# Run without a global install
npx --yes @iowarp/clio-coder@latest

# Install without the optional Claude Agent SDK worker dependency
npm install -g @iowarp/clio-coder --omit=optional
```

From source, build the release tag:

```bash
git clone --branch v0.5.6 https://github.com/iowarp/clio-coder.git
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

The terminal brings conversation, tool calls, permissions, fleet activity, and
context accounting into one workspace. The browser application provides project
and conversation views, session controls, fleet previews, traces, evidence, and
configuration through the same runtime. The browser interface is in alpha.

During a conversation, the left sidebar switches between project sessions,
recorded runs, and configuration tools while your chat stays open. The collapsible
Artifacts panel holds recorded file activity, results, and linked evidence.
Open a dedicated trace or evidence viewer when you need more inspection space.
Scroll up to read earlier messages; **Jump to latest** returns immediately to the
newest output and resumes following the stream.

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/screenshots/tui-boot.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/screenshots/tui-boot.webp" alt="Clio Coder terminal boot screen with model and workspace information, fleet, shortcuts, composer and context footer" width="1000" /></a>
</p>
<p align="center"><sub>Terminal workspace. Select a capture to open its full-resolution image.</sub></p>
<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/screenshots/gui-overview.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/screenshots/gui-overview.webp" alt="Clio Coder browser overview with project selection, recent conversations and navigation for traces, fleet, evidence, library and settings" width="1000" /></a>
</p>

<details>
<summary><strong>Browser conversation view</strong></summary>

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/screenshots/gui-conversation.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/screenshots/gui-conversation.webp" alt="Browser conversation with project-grouped sessions, a compact composer, model selection and harness controls" width="800" /></a>
</p>
<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/screenshots/gui-artifacts.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/screenshots/gui-artifacts.webp" alt="Conversation with eight passing tests and recorded verification results in the collapsible right Artifacts panel" width="800" /></a>
</p>

[Watch a real calibration verification (33 seconds, MP4)](https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/recordings/gui-calibration.mp4)
· [GIF preview](https://raw.githubusercontent.com/iowarp/clio-coder/v057/assets/recordings/gui-calibration-preview.gif)

```bash
clio-coder gui --open
```

On Linux, an optional background application serves the GUI:

```bash
clio-coder gui background install --open
```

Bare `clio-coder gui` reuses this installation's owned background application
when present, or starts a private foreground server. See the
[GUI guide](docs/guide/commands-and-modes.md#graphical-application).

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

# Headless execution; timeout is in seconds
clio-coder run "Summarize this repository's entry points."
clio-coder run --json --timeout 300 "Run the existing parser tests and report the results."

# Agent Client Protocol server for editors and other hosts
clio-coder acp
```

Headless text mode writes the answer to stdout and diagnostics to stderr;
`--json` emits JSONL. Calls requiring interactive permission are denied in
headless mode. A focused worker can run inside a terminal session:

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

Clio resolves model capabilities from provider metadata, its catalog, and user
overrides. Configure a model with the tool calling, context window, vision, and
reasoning support your workflow requires. See
[connections and targets](docs/guide/configuration-and-targets.md).

## Execution policy

The default policy admits workspace reads, edits, and recognized checks, and
requests permission for unfamiliar commands and outward actions. Permission
cards show the invocation. **Yolo** removes ordinary approval prompts; protected
paths, hard blocks, and damage-control rules continue to apply.

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

## Acknowledgements

Clio Coder is developed by the [Gnosis Research Center](https://grc.iit.edu) at
[Illinois Tech](https://www.iit.edu), in collaboration with the
[University of Utah](https://www.utah.edu), as part of [IOWarp](https://iowarp.ai).
The IOWarp CLIO architecture is supported by the National Science Foundation
under [Award #2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318),
2024–2029. Principal Investigator: Dr. Xian-He Sun. Co-Principal Investigators:
Dr. Anthony Kougkas, Dr. Jake Hochhalter and Dr. Vivek Srikumar.

Clio builds on the [Pi agent framework](https://github.com/earendil-works/pi),
[ACP](https://agentclientprotocol.com), and [MCP](https://modelcontextprotocol.io).
Dependency and component notices are in [NOTICE](NOTICE).

CLIO means **Context Layer for Input/Output**. Related IOWarp projects include
[clio-core](https://github.com/iowarp/clio-core) for data and context storage and
[clio-kit](https://github.com/iowarp/clio-kit) for scientific tool servers.
