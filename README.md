<p align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" type="image/webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.png" alt="Clio Coder, IOWarp's terminal coding agent for scientific software" width="100%" />
  </picture>
</p>

# Clio Coder

**The coding agent for the people who maintain the code that science runs on.**<br />
Your models. Your machines. Work you can inspect.

<p align="center">
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm version" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?label=npm&color=00a6ad&style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm downloads per month" src="https://img.shields.io/npm/dm/%40iowarp%2Fclio-coder?label=downloads&color=00a6ad&style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/releases/latest"><img alt="Latest GitHub release" src="https://img.shields.io/github/v/release/iowarp/clio-coder?label=release&color=147366&style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions/workflows/ci.yml"><img alt="CI status on main" src="https://img.shields.io/github/actions/workflow/status/iowarp/clio-coder/ci.yml?branch=main&label=CI%20%28main%29&style=flat-square" /></a>
  <a href="#get-started"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-147366?logo=nodedotjs&logoColor=white&style=flat-square" /></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
</p>
<p align="center">
  <a href="https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318"><img alt="Supported by NSF award 2411318" src="https://img.shields.io/badge/NSF-%232411318-241131?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="Part of IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00a6ad?style=flat-square" /></a>
  <a href="https://grc.iit.edu"><img alt="Gnosis Research Center at Illinois Tech" src="https://img.shields.io/badge/Gnosis%20Research%20Center-Illinois%20Tech-cc0000?style=flat-square" /></a>
  <a href="#get-started"><img alt="Linux and macOS" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-147366?style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/iowarp/clio-coder?color=241131&style=flat-square" /></a>
</p>
<p align="center">
  <a href="https://github.com/earendil-works/pi"><img alt="Built on the Pi agent framework" src="https://img.shields.io/badge/built%20on-Pi-241131?style=flat-square" /></a>
  <a href="https://agentclientprotocol.com"><img alt="Speaks the Agent Client Protocol" src="https://img.shields.io/badge/Agent%20Client%20Protocol-ACP-147366?style=flat-square" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="Connects Model Context Protocol servers" src="https://img.shields.io/badge/Model%20Context%20Protocol-MCP-147366?style=flat-square" /></a>
  <a href="#models"><img alt="Local models are first-class" src="https://img.shields.io/badge/local%20models-first--class-00a6ad?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#why-clio">Why Clio</a> ·
  <a href="#models">Models</a> ·
  <a href="#safety">Safety</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="#contribute">Contribute</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/readme/clio-session.png" alt="A Clio Coder terminal session: a failing pytest run, the diagnosis of an unstable finite-difference time step, a two-line edit to solver.py, the passing test run, and the footer showing a local 27B model" width="860" />
</p>
<p align="center"><sub>An unedited session on a local 27B model: a failing numerical test, the diagnosis, a two-line fix, and the passing run.</sub></p>

Clio Coder is an open-source coding agent for your terminal. Ask her to explain a
repository, chase a failing test, implement a change, or hand a focused task to a
worker. You see every tool call and every diff, and the checks behind each result
are recorded.

She was built for research codebases and high-performance computing: simulation
kernels, numerical libraries, data pipelines and mixed-language builds. She is
just as useful for everyday engineering. Point her at a model on your
workstation, your lab's gateway, or a cloud service, and start with one
conversation.

## Get started

You need **Node.js 22.19 or newer** and a model to talk to. Linux and macOS are
the primary platforms; Windows support is best effort.

```bash
npm install -g @iowarp/clio-coder
cd /path/to/your/project
clio-coder configure
clio-coder
```

1. **Connect a model.** In the configuration launcher, choose **Quick Connect**.
   Enter an endpoint such as `http://localhost:1234` (LM Studio) or
   `http://localhost:11434` (Ollama), add credentials if the server needs them,
   and pick a model that supports tool calling. Subscription sign-in and other
   providers are under **Settings → Connections**.
2. **Start a session.** Run `clio-coder` in your project directory.
3. **Ask for something real.**

   > Explain how this repository builds and runs its tests. Find the main entry
   > points and suggest one useful verification task. Do not change files yet.

If something does not connect, `clio-coder doctor` checks the installation and
the [troubleshooting guide](docs/guide/troubleshooting.md) covers the rest. Other
package managers and source builds are under [Install](#install).

## Why Clio

Most coding agents assume a frontier model in the cloud and a shell you trust it
with. Clio makes a different bet: the harness should be strong enough that a model
on your own hardware does real work, and honest enough that you can check what
happened afterward.

- **Your models, on your terms.** Local servers, lab gateways, cloud APIs and
  subscriptions are all first-class, and chat and workers can use different
  ones. The compiled prompt is reused byte for byte, so a local server's prefix
  cache stays warm, and Clio tells you when a turn went cold.
  [Models](#models)
- **Typed tools, one admission path.** The model reads, edits, searches, runs and
  delegates through typed tools. Shell commands are parsed and scanned before
  they run, and every call passes the same autonomy, protected-path and
  damage-control checks. [Safety model](docs/architecture/safety-model.md)
- **It checks its own work.** `verify` runs the checks your repository already
  declares: pytest or unittest, Cargo, Go, CMake presets, Make and just targets,
  and the scripts your CI calls. It also compares numerical results and holds
  performance budgets. [Verification](docs/guide/tool-usage.md#verify-run-declared-verification-checks)
- **Bounded workers, from one machine to a cluster.** Coding, testing, review
  and research workers each get their own model, tool ceiling and call budget.
  Fleets chain them into repeatable workflows, and declared nodes run the same
  workers over SSH. [Workers and fleets](docs/guide/fleet-dispatch.md)
- **Evidence, not only answers.** Tool activity, diffs, traces, token use and
  cost are recorded. Runs seal receipts and evidence bundles you can inspect
  later. [Observability](docs/architecture/observability.md)
- **Built for science.** A project handbook, a Tree-sitter code index for large
  trees, MCP servers behind one gateway (including Slurm job workflows through
  clio-kit), and a library of skills, agents and domain plugins that Claude Code
  and Codex can use too. [Context engine](docs/architecture/context-engine.md) ·
  [Slurm](docs/guide/slurm.md) · [Library](library/README.md)
- **Works with the agents you already use.** Claude Code, Codex, OpenCode, Pi and
  Antigravity CLI can take managed tasks or open in a pane beside your session,
  and Clio serves editors and other hosts over the Agent Client Protocol.
  [Interoperability](docs/guide/interop.md)

## Models

A saved connection is a **target**. Chat, workers and optional model-assisted
memory can each use a different target and model: a local model for routine
edits, another for an independent review.

| Where the model runs | Examples |
| --- | --- |
| **Your workstation or server** | Ollama, LM Studio, llama.cpp, vLLM, SGLang, Lemonade |
| **A gateway or compatible API** | LiteLLM, OpenAI-compatible and Anthropic-compatible endpoints |
| **Cloud APIs** | OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, DeepSeek, Amazon Bedrock, Inception Mercury |
| **Subscription sign-in** | ChatGPT through `openai-codex`; Claude through `anthropic-max` |
| **Institutional inference** | Argonne ALCF Sophia and Metis through Globus OAuth |

Tool calling, context capacity and reasoning support depend on the model and the
server. Clio combines live provider metadata, catalog knowledge and your
overrides. Switch models with `/model` and set worker defaults under
**Settings → Fleet**. The [connection guide](docs/guide/configuration-and-targets.md)
covers setup and the [model catalog](docs/architecture/model-catalog.md) explains
capabilities and runtime differences.

## Everyday use

The terminal keeps the conversation, tool activity, diffs and permission
decisions in one place. The footer shows the active model, context use and,
when the connected account reports it, subscription headroom.

| Want to… | Use… |
| --- | --- |
| Find commands and your keybindings | `/help` |
| Choose a model or change settings | `/model`, `/settings` |
| Attach a project file | Type `@` and choose a path |
| Read the details behind a tool call | `/view` |
| Inspect context, memory or usage | `/context`, `/memory`, `/usage` |
| Browse skills, agents, prompts, plugins and fleets | `/library` or `Alt+L` |
| Watch workers or manage tasks | `Alt+W`, `/tasks` |
| Branch or recover a conversation | `/tree`, `/fork`, `/resume` |
| Save a transcript | `/export` for HTML, `/export notes.md` for Markdown |

During a turn, **Enter** steers, **Ctrl+Q** queues a follow-up and **Escape**
interrupts. On a permission card, **Deny** skips that one call and **Stop** ends
the turn. The [command and shortcut reference](docs/guide/commands-and-modes.md)
has the rest.

**Teach Clio your project.** `clio-coder context init` drafts a `CLIO-CODER.md`
handbook and builds the code index. Keep your build commands, conventions and
validation rules there and version it with the project; runtime state goes under
`.clio-coder/`. See [project context](docs/architecture/context-engine.md).

**Start small, then delegate.** Give Clio a bounded change with its acceptance
criteria, then ask a worker for an independent pass:

```text
/run verifier Review the current diff and run the relevant existing checks. Do not edit files.
```

The [built-in agent guide](docs/guide/built-in-agents.md) describes each worker
recipe; [fleet workflows](docs/guide/fleet-dispatch.md) add SSH placement when
you need it.

<details>
<summary><strong>Scripts, CI and editors</strong></summary>

```bash
clio-coder run --autonomy read-only "Summarize this repository's entry points."
clio-coder run --json --timeout 300 "Run the existing parser tests and report the results."
```

Text mode writes the final answer to stdout and diagnostics to stderr. `--json`
emits JSONL events and `--timeout` limits the run in seconds. Headless runs
cannot answer permission prompts, so actions that still need confirmation are
denied; choose the autonomy level before unattended work. See
[output and exit codes](docs/guide/exit-codes-and-output.md).

For an editor or agent host that speaks the Agent Client Protocol, configure it
to launch `clio-coder acp`. See [ACP integration](docs/architecture/acp.md).

</details>

<details>
<summary><strong>Other coding agents and draft answers</strong></summary>

With another coding CLI installed, `/interop` shows what it supports. Use
`/run --target <peer-target> --worktree <agent> <task>` for a managed edit on a
preserved branch, `/delegate <peer> <task>` for a configured ACP connection, or
`/peer <peer> [brief]` for an interactive pane handoff. The
[peer setup guide](docs/guide/interop.md#delegate-work-to-an-installed-coding-agent)
lists each peer's setup and permission limits.

`/draft [N] <request>` generates two to four candidate answers without tools, and
a configured decision model can judge them. Use it to compare plans or
explanations before committing to one; the requests count toward usage.

</details>

## Safety

| Autonomy | What it allows |
| --- | --- |
| **capable** (default; saved as `auto-edit`) | Edit within permitted roots, dispatch workers, run recognized commands; ask for anything else. |
| **yolo** (saved as `full-auto`) | Skip routine prompts, including outward actions; safety rules still apply. |
| `read-only` | Inspect and answer; deny commands, edits and delegation. |
| `suggest` | Inspect within the workspace; ask before edits, commands or delegation. |

In the default mode a bare test runner runs directly. A test runner behind a
pipe, redirect or `&&` chain, or a command Clio does not recognize, asks first,
and the approval card shows the exact invocation. Settings offers **capable** and **yolo**; the CLI also accepts
`read-only`, `suggest`, `auto-edit` and `full-auto`.

**Clio is not an operating-system sandbox.** Commands run with your user's
permissions. Protected paths, damage-control rules and explicit task constraints
apply at every level. A passing check shows what ran and what it returned, not
that the science is right: review changes and validate results against your own
reference tests and data. Reported costs depend on available pricing data, and a
Clio budget is not a provider billing cap. Read the
[safety model](docs/architecture/safety-model.md) before unattended runs, and
report security problems privately through [SECURITY.md](SECURITY.md).

## Install

| Use case | Command |
| --- | --- |
| Install with npm | `npm install -g @iowarp/clio-coder` |
| Install with pnpm | `pnpm add -g @iowarp/clio-coder` |
| Try without a global install | `npx --yes @iowarp/clio-coder@latest` |
| Skip the optional Claude SDK worker dependency | `npm install -g @iowarp/clio-coder --omit=optional` |
| Check your installation | `clio-coder doctor` |

Node.js is required with every package manager. The optional Claude Agent SDK
contains a platform-specific binary; chat and native workers run without it. The
[installation and lifecycle guide](docs/guide/installation-and-lifecycle.md)
covers every method in detail.

<details>
<summary><strong>Build and install from source</strong></summary>

From source, pin the release tag for a reproducible checkout:

```bash
git clone --branch v0.5.5 https://github.com/iowarp/clio-coder.git
cd clio-coder
corepack enable pnpm
pnpm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
"$HOME/.local/bin/clio-coder" --version
```

The installer resolves dependencies, builds, and links the launcher into
`${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}`. If Corepack is unavailable, install
pnpm with `npm install -g pnpm@10.34.5`. Preview with
`bash scripts/install-local.sh --dry-run`. For development, follow the
[contributor instructions](CONTRIBUTING.md#submitting-changes) for the current
version branch.

Run `command -v clio-coder` to check which launcher your shell reaches. After
changing `PATH`, use `hash -r` in Bash or `rehash` in Zsh; an older global
installation can otherwise shadow the one you just installed.

</details>

<details>
<summary><strong>Upgrade, repair, reset or uninstall</strong></summary>

**Upgrade.** Finish your turn, leave with `/quit`, and from the same project
directory run `clio-coder upgrade --restart`. It keeps the install's npm prefix,
applies migrations through the new binary, and resumes only after success. With
pnpm, run `pnpm add -g @iowarp/clio-coder@latest`, then
`clio-coder upgrade --post-install` and `clio-coder --continue`. Source installs
check out the new release tag and rerun `pnpm run install:local`. A quiet footer
hint says when an update is available; it never upgrades on its own, and
`CLIO_CODER_UPDATE_CHECK=0` turns it off.

**Repair.** `clio-coder doctor` diagnoses, `clio-coder doctor --fix` applies the
repairs it supports, and `clio-coder upgrade --post-install` runs pending
migrations.

**Reset.** Preview a scope first, review the listed paths, then replace
`--dry-run` with `--force`:

| Intent | Preview |
| --- | --- |
| Clear cached artifacts | `clio-coder reset --cache --dry-run` |
| Clear conversation history and runtime state | `clio-coder reset --state --dry-run` |
| Clear saved credentials | `clio-coder reset --auth --dry-run` |
| Restore settings defaults | `clio-coder reset --config --dry-run` |
| Clear all user configuration, data, state and cache | `clio-coder reset --all --dry-run` |

A bare `reset` selects **state**, including saved conversations. User resets
leave project `.clio-coder/` directories in place.

**Uninstall.** `npm uninstall -g @iowarp/clio-coder` (or
`pnpm remove -g @iowarp/clio-coder`) removes the package and keeps your data. If
you installed the optional background app, run
`clio-coder gui background uninstall` first. To remove configuration and data
too, inspect `clio-coder uninstall --dry-run`; `--keep-config` and `--keep-data`
preserve selected roots. The
[uninstall guide](docs/guide/installation-and-lifecycle.md#d-uninstallation-clio-coder-uninstall)
covers launchers and per-project cleanup.

</details>

## Documentation

**Ask Clio how to use or extend Clio.** The package ships her documentation,
source, prompt fragments and agent recipes, so she answers from the version you
are running:

> How do I use a different model for workers? Show me the relevant guide and settings.

| Looking for… | Start here |
| --- | --- |
| The complete documentation map | [Documentation index](docs/README.md) |
| Connections, models and settings | [Configuration and targets](docs/guide/configuration-and-targets.md) · [Configuration reference](docs/guide/configuration-reference.md) |
| Commands, shortcuts and output formats | [Commands and modes](docs/guide/commands-and-modes.md) · [Exit codes and output](docs/guide/exit-codes-and-output.md) |
| Installation or connection trouble | [Troubleshooting](docs/guide/troubleshooting.md) · [Doctor](docs/guide/doctor.md) |
| Usage, quotas and cost | [Subscription quota and session usage](docs/guide/commands-and-modes.md#subscription-quota-and-session-usage) |
| Skills, plugins and harness extensions | [Library](library/README.md) · [Authoring plugins](docs/guide/authoring-plugins.md) · [Harness extensions](docs/guide/harness-extensions.md) |
| Design and source ownership | [Architecture](docs/architecture/architecture.md) |

`clio-coder docs` (or `clio-coder docs safety`) opens the bundled pages in your
browser with no model connection. It starts a local server that stops after 15
minutes with no pages open, or with `clio-coder docs --stop`; if you installed
the background app, it uses that instead. The terminal is the primary interface;
`clio-coder gui` is an opt-in alpha.

<details>
<summary><strong>For agents</strong></summary>

**Working on this repository.** Read [CONTRIBUTING.md](CONTRIBUTING.md), then the
relevant section of the [architecture guide](docs/architecture/architecture.md).
Read a local `CLIO-CODER.md` if present; it is optional checkout guidance. Source,
schemas and contract tests settle any disagreement with prose. The contributor
guide lists focused tests, required checks and the version-branch workflow.

**Helping someone use Clio.** Start with `clio-coder --help` and the docs for the
installed version. CLI commands use `clio-coder …`; slash commands such as
`/model` belong inside an interactive session. A README on a development branch
may describe changes that have not shipped; check the [changelog](CHANGELOG.md)
and the matching release tag.

**Finding Clio's own documentation from a running session.** Use
`gateway(op="call", capability="clio_docs", args={query: "your question"})`.
Resolve its citations against the installed **package root**, the parent of the
prompt's `CLIO_DOCS_PATH`; for example, `docs/guide/tool-usage.md` belongs under
that package root. See the
[documentation lookup contract](docs/README.md#where-clio-finds-these-docs-when-it-is-running-in-someone-elses-project).

</details>

## Contribute

A difficult build, an unreliable connection or a workflow that needs too much
babysitting makes a useful bug report. Include your Clio and Node versions,
reproduction steps and the relevant `clio-coder doctor` output, with credentials
and sensitive project data removed.

- [Report an issue or suggest an improvement](https://github.com/iowarp/clio-coder/issues)
- [Set up a development checkout and run the checks](CONTRIBUTING.md)
- [Contribute a skill, agent or workflow](library/README.md)
- [Read the release notes](CHANGELOG.md)

Contributions target the current version branch; `main` advances when a release
ships. Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Acknowledgements

Clio Coder is developed by the [Gnosis Research Center](https://grc.iit.edu) at
[Illinois Tech](https://www.iit.edu), in collaboration with the
[University of Utah](https://www.utah.edu), as part of [IOWarp](https://iowarp.ai).
The IOWarp CLIO architecture is supported by the National Science Foundation
under [Award #2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318),
2024–2029. Principal Investigator: Dr. Xian-He Sun. Co-Principal Investigators:
Dr. Anthony Kougkas, Dr. Jake Hochhalter and Dr. Vivek Srikumar.

Clio stands on generous open-source and research work:

<p>
  <a href="https://github.com/earendil-works/pi"><img alt="Pi agent framework" src="https://img.shields.io/badge/Pi-agent%20framework-241131?style=flat-square" /></a>
  <a href="https://agentclientprotocol.com"><img alt="Agent Client Protocol" src="https://img.shields.io/badge/Agent%20Client%20Protocol-241131?style=flat-square" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="Model Context Protocol" src="https://img.shields.io/badge/Model%20Context%20Protocol-241131?style=flat-square" /></a>
  <a href="https://github.com/anthropics/claude-agent-sdk-typescript"><img alt="Claude Agent SDK" src="https://img.shields.io/badge/Claude%20Agent%20SDK-241131?logo=anthropic&logoColor=white&style=flat-square" /></a>
  <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-241131?logo=nodedotjs&logoColor=white&style=flat-square" /></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-241131?logo=typescript&logoColor=white&style=flat-square" /></a>
  <a href="https://tree-sitter.github.io"><img alt="Tree-sitter" src="https://img.shields.io/badge/Tree--sitter-241131?style=flat-square" /></a>
  <a href="https://biomejs.dev"><img alt="Biome" src="https://img.shields.io/badge/Biome-241131?logo=biome&logoColor=white&style=flat-square" /></a>
  <a href="https://esbuild.github.io"><img alt="esbuild" src="https://img.shields.io/badge/esbuild-241131?logo=esbuild&logoColor=white&style=flat-square" /></a>
  <a href="https://react.dev"><img alt="React" src="https://img.shields.io/badge/React-241131?logo=react&logoColor=white&style=flat-square" /></a>
  <a href="https://vite.dev"><img alt="Vite" src="https://img.shields.io/badge/Vite-241131?logo=vite&logoColor=white&style=flat-square" /></a>
</p>
<p>
  <a href="https://ollama.com"><img alt="Ollama" src="https://img.shields.io/badge/Ollama-147366?logo=ollama&logoColor=white&style=flat-square" /></a>
  <a href="https://lmstudio.ai"><img alt="LM Studio" src="https://img.shields.io/badge/LM%20Studio-147366?style=flat-square" /></a>
  <a href="https://github.com/ggml-org/llama.cpp"><img alt="llama.cpp" src="https://img.shields.io/badge/llama.cpp-147366?style=flat-square" /></a>
  <a href="https://github.com/vllm-project/vllm"><img alt="vLLM" src="https://img.shields.io/badge/vLLM-147366?style=flat-square" /></a>
  <a href="https://github.com/sgl-project/sglang"><img alt="SGLang" src="https://img.shields.io/badge/SGLang-147366?style=flat-square" /></a>
  <a href="https://github.com/lemonade-sdk/lemonade"><img alt="Lemonade" src="https://img.shields.io/badge/Lemonade-147366?style=flat-square" /></a>
  <a href="https://www.litellm.ai"><img alt="LiteLLM" src="https://img.shields.io/badge/LiteLLM-147366?style=flat-square" /></a>
  <a href="https://www.alcf.anl.gov"><img alt="Argonne Leadership Computing Facility" src="https://img.shields.io/badge/Argonne-ALCF-147366?style=flat-square" /></a>
  <a href="https://www.globus.org"><img alt="Globus" src="https://img.shields.io/badge/Globus-147366?style=flat-square" /></a>
  <a href="https://herdr.dev"><img alt="Herdr" src="https://img.shields.io/badge/Herdr-147366?style=flat-square" /></a>
  <a href="https://yazi-rs.github.io"><img alt="Yazi" src="https://img.shields.io/badge/Yazi-147366?style=flat-square" /></a>
</p>

The first row is what Clio is built with; the second is the model servers,
institutional services and terminal tools she connects to. Exact packages are in
[package.json](package.json) and the workspace manifests, and component notices
are in [NOTICE](NOTICE).

CLIO means **Context Layer for Input/Output**, and the name recalls the Greek
muse of history. Explore the wider ecosystem:
[clio-core](https://github.com/iowarp/clio-core) for data and context storage,
and [clio-kit](https://github.com/iowarp/clio-kit) for scientific tool servers.

<p align="center">
  <strong>Clio Coder</strong> · Apache-2.0 · <a href="LICENSE">License</a> · <a href="NOTICE">Notices</a><br />
  <sub>Built for the people who maintain the code that science runs on.</sub>
</p>
