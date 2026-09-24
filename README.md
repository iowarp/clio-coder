<p align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" type="image/webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.png" alt="Clio Coder — IOWarp's terminal coding agent for scientific software" width="100%" />
  </picture>
</p>

# Clio Coder

**The coding agent for the people who maintain the code that science runs on.**<br />
Your models. Your machines. Work you can inspect.

<p align="center">
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm version" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?color=00a6ad&style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions/workflows/ci.yml"><img alt="CI status on main" src="https://img.shields.io/github/actions/workflow/status/iowarp/clio-coder/ci.yml?branch=main&label=CI%20%28main%29&style=flat-square" /></a>
  <a href="#get-started"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="Part of IOWarp" src="https://img.shields.io/badge/IOWarp-CLIO-00a6ad?style=flat-square" /></a>
</p>

[Get started](#get-started) · [Capabilities](#what-clio-can-do) · [Models](#choose-your-models) · [Terminal](#work-in-the-terminal)<br />
[Automation](#use-the-same-harness-in-automation) · [Permissions](#choose-authority-keep-the-evidence) · [Docs](#documentation-you-can-ask-about) · [For agents](#for-agents) · [Install](#install) · [Upgrade & recovery](#upgrade-reset-or-uninstall) · [Contribute](#contribute)

Clio Coder is an open-source terminal coding agent for scientific software and
everyday engineering. Ask her to explain a repository, investigate a failing
test, implement a change, or delegate a focused task. Inspect the tool activity,
review the diff, and follow the recorded checks behind the result.

Built for research codebases and high-performance computing, Clio connects to
models on your workstation, your institution's gateway, or a cloud service.
Start with one conversation; add workers, reusable skills, and scientific tools
as your work grows.

## Get started

You need **Node.js 22.19 or newer** and access to a model. Linux and macOS are
the primary terminal platforms; Windows support is best effort.

```bash
npm install -g @iowarp/clio-coder
cd /path/to/your/project
clio-coder configure
clio-coder
```

In the configuration launcher, choose **Quick Connect** for a local server or
compatible API. Enter its endpoint, provide credentials if required, and select
a model that supports tool calling. Common local endpoints are
`http://localhost:1234` for LM Studio and `http://localhost:11434` for Ollama;
start your model server first. For subscription sign-in or other provider setup,
choose **Settings → Connections**. See the [connection guide](docs/guide/configuration-and-targets.md).

Try a first request:

> Explain how this repository builds and runs its tests. Find the main entry
> points and suggest one useful verification task. Do not change files yet.

The default **capable** mode (`auto-edit` in saved settings) permits workspace
edits, worker dispatch, and recognized commands, including tests. Other actions
may ask for approval or be blocked by policy. Change this in **Settings → Permissions & Limits**; the
[permissions overview](#choose-authority-keep-the-evidence) explains the choices.

For connection trouble, run `clio-coder doctor` and follow the
[troubleshooting guide](docs/guide/troubleshooting.md). For pnpm, a temporary
run, or source builds, see [Install](#install). Already using Clio? See
[Upgrade & recovery](#upgrade-reset-or-uninstall).

## What Clio can do

| Your task | How Clio helps |
| --- | --- |
| **Find your way through unfamiliar code** | Navigate files, symbols, and dependencies with a structural index, bounded search, and a project handbook. [Context engine](docs/architecture/context-engine.md) |
| **Make a change and check it** | Edit files, inspect diffs, run declared tests and builds, compare numerical results, and check performance budgets. [Tools and verification](docs/guide/tool-usage.md) |
| **Get an independent review or share the work** | Dispatch coding, verification, and research workers; use different models and compose workflows across local or SSH nodes. [Workers and fleets](docs/guide/fleet-dispatch.md) |
| **Work with another coding agent** | Give an installed Claude Code, Codex, OpenCode, Antigravity CLI, or Pi a named task through a managed headless run, ACP connection, or interactive pane. [Coding agent interoperability](docs/guide/interop.md#delegate-work-to-an-installed-coding-agent) |
| **Continue a long task** | Manage the model's context, compact conversations, retain task memory, and fork, resume, or hand off a session. [Context continuity](docs/guide/context-continuity.md) |
| **Connect scientific tools** | Reach Model Context Protocol (MCP) servers through a common gateway, including Slurm job workflows through clio-kit. [MCP tools](docs/guide/tool-usage.md#gateway-discover-and-call-secondary-capabilities) · [Slurm](docs/guide/slurm.md) |
| **Reuse domain knowledge** | Install skills, prompts, agents, plugins, and fleets from the library. Review and import supported text resources from other coding agents. [Library](library/README.md) · [Interoperability](docs/guide/interop.md) |
| **Understand a run's results and cost** | Inspect tool activity, traces, evidence bundles, worker receipts, token usage, and subscription headroom where available. [Observability](docs/architecture/observability.md) · [Usage](docs/guide/commands-and-modes.md#subscription-quota-and-session-usage) |

## Choose your models

A saved connection is a **target**. Chat, workers, and optional model-assisted
memory can use different targets and models. For example, use a local model for
routine edits and another model for an independent review.

| Where the model runs | Examples |
| --- | --- |
| **Your workstation or server** | Ollama, LM Studio, llama.cpp, vLLM, SGLang, Lemonade |
| **A gateway or compatible API** | LiteLLM, OpenAI-compatible and Anthropic-compatible endpoints |
| **Cloud APIs** | OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, DeepSeek, Amazon Bedrock, Inception Mercury |
| **Subscription sign-in** | ChatGPT through `openai-codex`; Claude through `anthropic-max` |
| **Institutional inference** | Argonne ALCF Sophia and Metis through Globus OAuth |

Tool calling, context capacity, and reasoning support depend on the model and
server. Clio combines live provider metadata, catalog knowledge, and configured
overrides. Check the selected model against your own coding tasks.
Subscription connections depend on the provider's sign-in support and terms.

Use `/model` to switch models and **Settings → Fleet** to choose worker defaults.
Changes can apply to the current session, the project, or global defaults;
resuming a session restores its recorded model and thinking level.
The [connection guide](docs/guide/configuration-and-targets.md) covers setup;
the [model catalog](docs/architecture/model-catalog.md) explains capabilities
and runtime differences. Task memory can also work without a separate model.

## Work in the terminal

The terminal interface brings the conversation, tool activity, diffs, and
permission decisions together. The footer shows the active model, context use,
and subscription headroom when the connected account reports it.

Start typing as the initial shell appears; submissions wait until the full
interface is ready. During work, folded reads and searches keep the transcript
scannable, worker cards show delegated activity, and `/view` opens the details.
Export a conversation when you need a record to revisit or share.

| Want to… | Use… |
| --- | --- |
| Find commands and your current keybindings | `/help` |
| Choose a model or change settings | `/model`, `/settings` |
| Attach a project file | Type `@` and choose a path |
| Read the details behind a tool call or result | `/view` |
| Inspect context, memory, or usage | `/context`, `/memory`, `/usage` |
| Compare candidate answers with a configured decision model | `/draft [N] <request>` |
| Browse skills, agents, prompts, plugins, and fleets | `/library` or `Alt+L` |
| Inspect workers or manage tasks | `Alt+W`, `/tasks` |
| Branch or recover a conversation | `/tree`, `/fork`, `/resume` |
| Save a transcript to share or revisit | `/export` for HTML; `/export notes.md` for Markdown |
| Leave the session | `/quit` |

During an active turn, **Enter** sends steering for the next available slot,
**Ctrl+Q** queues a follow-up after the run, and **Escape** interrupts. On a
permission card, **Deny** skips the displayed invocation and **Stop** ends the
turn. These are the default bindings; `/help` shows your effective controls.

Clio includes contextual guidance. Use `clio-coder --no-demo` for a quieter
session. See the [command and shortcut reference](docs/guide/commands-and-modes.md)
and the optional [terminal panes](docs/guide/panes-and-files.md).

### Teach Clio your project

```bash
clio-coder context init
```

This prepares a `CLIO-CODER.md` project handbook and a structural code index.
Review the handbook and keep your build commands, conventions, and validation
requirements there. An existing handbook is preserved unless you explicitly
request replacement. You can version it with your project; generated runtime
state goes under `.clio-coder/`. During setup, Clio offers to add that directory
to `.gitignore`.
See [project context](docs/architecture/context-engine.md).

### Start small, then delegate

Give Clio a bounded change and its acceptance criteria:

> Add a regression for the boundary case, make the smallest fix, and run the
> relevant checks. Keep the public API unchanged. Do not commit or push.

For an independent verification pass, run a worker explicitly:

```text
/run verifier Review the current diff and run the relevant existing checks. Do not edit files.
```

A **worker** runs a focused assignment; a **fleet** combines assignments into a
repeatable workflow. Start locally, then add [fleet workflows and SSH placement](docs/guide/fleet-dispatch.md)
when needed. The [built-in agent guide](docs/guide/built-in-agents.md) explains
each recipe's tools and responsibilities. Worker controls act on the current
session's runs, and fleet inspection starts with the current project.

If another coding CLI is installed, `/interop` shows its available modes.
Use `/run --target <peer-target> --worktree <agent> <task>` for a managed edit
on a preserved branch, `/delegate <peer> <task>` for a configured ACP
connection, or `/peer <peer> [brief]` for an interactive pane handoff. See the
[peer setup guide](docs/guide/interop.md#delegate-work-to-an-installed-coding-agent)
for supported agents and permission limits.

For alternatives that need no tools, `/draft [N] <request>` generates two to
four candidate answers. A configured decision model can judge the candidates;
the requests count toward usage. Use this for comparing explanations, plans,
or designs before committing to an approach.

## Use the same harness in automation

After configuring a model, run a single task from a script:

```bash
clio-coder run --autonomy read-only "Summarize this repository's entry points."
clio-coder run --json --timeout 300 "Run the existing parser tests and report the results."
```

Text mode writes the final answer to stdout and diagnostics to stderr. `--json`
emits JSONL events; `--timeout` limits the run in seconds. Headless runs cannot
answer permission prompts; actions that still require confirmation are denied.
Choose an appropriate autonomy level and project policy before unattended work.
See [output and exit codes](docs/guide/exit-codes-and-output.md).

For an editor or another agent host that supports the **Agent Client Protocol
(ACP)**, configure it to launch:

```bash
clio-coder acp
```

See [ACP integration](docs/architecture/acp.md) for transport and permissions.

## Choose authority, keep the evidence

| Autonomy | What it allows |
| --- | --- |
| **capable** (default; `auto-edit`) | Edit within permitted roots, dispatch workers, and run recognized commands; ask for other actions. |
| **yolo** (`full-auto`) | Skip routine autonomy prompts, including outward actions; safety rules still apply. |
| `read-only` | Inspect and answer; deny commands, edits, and delegation. |
| `suggest` | Inspect within the workspace; ask before edits, commands, or delegation. |

Settings offers **capable** and **yolo**. The CLI also accepts `read-only`,
`suggest`, and the saved names `auto-edit` and `full-auto` for scripts and
existing configurations.

Protected paths, safety checks, and explicit task constraints still govern tool
admission. **Clio is not an operating-system sandbox**: commands run with the
host user's permissions. Read the [safety model](docs/architecture/safety-model.md)
before choosing unattended execution or external worker runtimes.

Clio is pre-1.0 software. Review changes and validate scientific results against
your reference tests and data. Recorded checks and receipts help establish what
ran and what it returned; scientific correctness still needs domain validation.
Reported dollar costs depend on available usage and pricing data, and a Clio
budget is not a provider billing cap.

Report security problems privately through [SECURITY.md](SECURITY.md).

## Documentation you can ask about

**Ask Clio how to use or extend Clio.** The package includes the documentation,
source, prompt fragments, and agent recipes for the installed version. Try:

> How do I use a different model for workers? Show me the relevant guide and settings.

| Looking for… | Start here |
| --- | --- |
| The complete documentation map | [Documentation index](docs/README.md) |
| Connections, models, and settings | [Configuration and targets](docs/guide/configuration-and-targets.md) · [Configuration reference](docs/guide/configuration-reference.md) |
| Commands, shortcuts, and output formats | [Commands and modes](docs/guide/commands-and-modes.md) · [Exit codes and output](docs/guide/exit-codes-and-output.md) |
| Installation or connection trouble | [Troubleshooting](docs/guide/troubleshooting.md) · [Doctor](docs/guide/doctor.md) |
| Scientific checks and measurements | [Verification tools](docs/guide/tool-usage.md#verify-run-declared-verification-checks) |
| Custom skills, plugins, or harness behavior | [Library](library/README.md) · [Authoring plugins](docs/guide/authoring-plugins.md) · [Harness extensions](docs/guide/harness-extensions.md) |
| Design and source ownership | [Architecture](docs/architecture/architecture.md) |

To read the bundled Markdown in a browser:

```bash
clio-coder docs
clio-coder docs safety
```

No model connection is needed. By default, this starts a local documentation
server: stop it with `clio-coder docs --stop`, or let it stop after 15 minutes
with no pages open. If you installed the background app, the command uses that
instead. See [documentation server details](docs/README.md#where-clio-finds-these-docs-when-it-is-running-in-someone-elses-project).
The terminal remains the primary interface; `clio-coder gui` is an opt-in alpha.

## For agents

**Working on this repository:** read [CONTRIBUTING.md](CONTRIBUTING.md), then the
relevant section of the [architecture guide](docs/architecture/architecture.md).
Read a local `CLIO-CODER.md` if present; it is optional checkout guidance.
Use source, schemas, and contract tests to resolve disagreements with prose.
The contributor guide lists focused tests, required checks, and the current
version-branch workflow.

**Helping someone use Clio:** start with `clio-coder --help` and the docs for
their installed version. CLI commands use `clio-coder …`; slash commands such
as `/model` belong inside an interactive session. A README on a development
branch may describe changes that have not shipped; check the [changelog](CHANGELOG.md)
and the matching release tag.

**Finding Clio's own documentation from a running Clio session:** use
`gateway(op="call", capability="clio_docs", args={query: "your question"})`.
Resolve its citations against the installed **package root**, the parent of
the prompt's `CLIO_DOCS_PATH`. For example, `docs/guide/tool-usage.md` belongs
under that package root. See the [documentation lookup contract](docs/README.md#where-clio-finds-these-docs-when-it-is-running-in-someone-elses-project).

## Install

| Use case | Command |
| --- | --- |
| Install with npm | `npm install -g @iowarp/clio-coder` |
| Install with pnpm | `pnpm add -g @iowarp/clio-coder` |
| Try without a global install | `npx --yes @iowarp/clio-coder@latest` |
| Omit the optional Claude SDK worker dependency | `npm install -g @iowarp/clio-coder --omit=optional` |
| Check your installation | `clio-coder doctor` |

Node.js is required with every package manager. The optional Claude Agent SDK
contains a platform-specific binary; ordinary chat and native workers work
without it. The [installation and lifecycle guide](docs/guide/installation-and-lifecycle.md)
covers configuration, upgrades, resets, and removal.

<details>
<summary><strong>Build and install from source</strong></summary>

From source, pin the release tag for a reproducible checkout:

```bash
git clone --branch v0.5.4 https://github.com/iowarp/clio-coder.git
cd clio-coder
corepack enable pnpm
pnpm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
"$HOME/.local/bin/clio-coder" --version
```

The example pins a published release. For development, follow the
[contributor instructions](CONTRIBUTING.md#submitting-changes) for the current
version branch.

The installer resolves dependencies, builds, and links the launcher into
`${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}`. If Corepack is unavailable, install
pnpm with `npm install -g pnpm@10.34.5`. Preview with
`bash scripts/install-local.sh --dry-run`.

Run `command -v clio-coder` to check which launcher your shell reaches. After
changing `PATH`, use `hash -r` in Bash or `rehash` in Zsh. An older global
installation can otherwise shadow the launcher you just installed.

</details>

## Upgrade, reset, or uninstall

### Upgrade and continue working

Finish your current turn and leave with `/quit`. For an npm global installation,
upgrade and resume from the same project directory with:

```bash
clio-coder upgrade --restart
```

Clio preserves the install's npm prefix, applies migrations through the new
binary, and resumes only after success. For pnpm, use
`pnpm add -g @iowarp/clio-coder@latest` with the original global directory,
then `clio-coder upgrade --post-install` and `clio-coder --continue`.
Source installations should check out the desired release and rerun
`pnpm run install:local`, which also applies migrations.

A quiet footer hint can tell you when an update is available or the running
installation has changed. It waits for an idle session and never upgrades
automatically. Set `CLIO_CODER_UPDATE_CHECK=0` to disable these checks.

`clio-coder upgrade --dry-run` previews the built-in upgrade path. After an
update, use `clio-coder --version` and `command -v clio-coder` to confirm your
shell reaches the expected installation; `hash -r` refreshes Bash's command
cache. [The lifecycle guide](docs/guide/installation-and-lifecycle.md) covers
migrations, installation methods, and recovery.

### Repair or reset

Start with `clio-coder doctor`. Use `clio-coder doctor --fix` for supported
installation repairs and `clio-coder upgrade --post-install` for pending
migrations. If you need to clear something, preview the specific scope:

| Intent | Preview |
| --- | --- |
| Clear cached artifacts | `clio-coder reset --cache --dry-run` |
| Clear conversation history and runtime state | `clio-coder reset --state --dry-run` |
| Clear saved credentials | `clio-coder reset --auth --dry-run` |
| Restore settings defaults | `clio-coder reset --config --dry-run` |
| Clear all user configuration, data, state, and cache | `clio-coder reset --all --dry-run` |

Review the listed paths, then replace `--dry-run` with `--force` to apply the
reset. A bare `reset` selects **state**, including saved conversations;
clearing it removes the history used by resume. User resets leave project
`.clio-coder/` directories in place.

### Remove Clio

`npm uninstall -g @iowarp/clio-coder` (or `pnpm remove -g @iowarp/clio-coder`)
removes the package and preserves user data. Use the original installation
prefix. If you installed the optional background app service, first run
`clio-coder gui background uninstall` while the CLI is still available.

To also remove Clio's user configuration and data, first inspect
`clio-coder uninstall --dry-run`. The command lists what it will remove;
`--keep-config` and `--keep-data` preserve selected roots. Follow the
[uninstall guide](docs/guide/installation-and-lifecycle.md#d-uninstallation-clio-coder-uninstall)
for launcher removal and per-project cleanup.

## Contribute

A difficult build, an unreliable connection, or a workflow that needs too much
babysitting makes a useful bug report. Include your Clio and Node versions,
reproduction steps, and relevant `clio-coder doctor` output. Remove credentials
and sensitive project data.

- [Report an issue or suggest an improvement](https://github.com/iowarp/clio-coder/issues)
- [Set up a development checkout and run the checks](CONTRIBUTING.md)
- [Contribute a skill or workflow](library/README.md)
- [Read the release notes](CHANGELOG.md)

Contributions target the current version branch; `main` advances when a release
ships. Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Built by IOWarp, on open source

Clio Coder is developed by the [Gnosis Research Center](https://grc.iit.edu) at
[Illinois Tech](https://www.iit.edu), in collaboration with the University of
Utah, as part of [IOWarp](https://iowarp.ai). The IOWarp CLIO architecture is
supported by the National Science Foundation under
[Award #2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318).

Clio builds on [Earendil Works' Pi framework](https://github.com/earendil-works/pi),
the [Agent Client Protocol](https://agentclientprotocol.com), and the work of
open-source runtime, terminal, compiler, model-serving, and scientific-tool
communities. Optional Claude SDK workers use Anthropic's Claude Agent SDK.
See [NOTICE](NOTICE) for component acknowledgements and distributed notices.

CLIO means **Context Layer for Input/Output**. Explore the wider ecosystem:
[clio-core](https://github.com/iowarp/clio-core) for data and context storage,
and [clio-kit](https://github.com/iowarp/clio-kit) for scientific tool servers.

**Apache-2.0** · [License](LICENSE) · [Notices](NOTICE)
