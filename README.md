<p align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" type="image/webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.png" alt="Clio Coder, the coding agent in IOWarp's CLIO ecosystem of agentic science" width="100%" />
  </picture>
</p>

<h1 align="center">Clio Coder</h1>

<p align="center"><strong>The coding agent for the people who maintain the code that science runs on.</strong><br />Your models. Your machines. Work you can inspect.</p>

<p align="center">
  <a href="https://github.com/iowarp/clio-coder/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/tag/iowarp/clio-coder?sort=semver&label=release&color=00d4db&style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?label=npm&color=cb3837&style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/iowarp/clio-coder/ci.yml?branch=main&label=ci&style=flat-square" /></a>
  <a href="#install"><img alt="Node >=22.19" src="https://img.shields.io/badge/node-%3E%3D22.19-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00d4db?style=flat-square" /></a>
  <a href="https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318"><img alt="NSF #2411318" src="https://img.shields.io/badge/NSF-%232411318-241131?style=flat-square" /></a>
</p>


<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#built-for-scientific-software">Why Clio?</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/iowarp/clio-coder/issues">Feedback</a>
</p>

Clio Coder is an open-source coding agent for your terminal. Ask it to explain a
repository, investigate a failing test, or help implement a change. It reads the
project, works with your tools, and shows you what it did.

Built for scientific software and high-performance computing (HPC), Clio works
with the code researchers maintain every day: simulation kernels, numerical
libraries, data pipelines, and mixed-language projects. Use a model on your
workstation, connect to your lab's gateway, or bring a cloud API.

**Experimental, and actively developed.** Keep your work in version control and
review generated changes. Clio helps with the engineering; scientific validation
still needs your expertise. See [release notes](CHANGELOG.md) for current changes.

## Get started

You need **Node.js 22.19 or newer**, Linux or macOS, and a running model server
or API endpoint. Windows support is currently best effort.

```bash
npm install -g @iowarp/clio-coder
cd /path/to/your/project
clio-coder configure
clio-coder
```

In the configuration launcher, choose **Quick Connect**:

1. **Paste your endpoint URL.** For example, `localhost:1234` for LM Studio,
   `localhost:11434` for Ollama, or your lab gateway's URL.
2. **Supply a key and choose a model when asked.** A keyless LM Studio or Ollama
   server with one model skips both questions. Type to search longer model lists.
3. **Review and Connect.** You're ready to start a session.

Clio uses [recommended defaults](docs/guide/configuration-and-targets.md#recommended-defaults):
workspace edits with command approval, one worker at a time, a $5 tracked session
budget, and a regular terminal interface. Other settings can wait. Escape goes
back during setup; `clio-coder configure --settings` opens the full menu.

**New in 0.4.7:** A unified Library for reusable workflows, operator extensions,
safer keyboard controls, and a compact welcome header. See the
[changelog](CHANGELOG.md) for release details and [Install](#install) for source
builds and other package managers.

## Built for scientific software

| What matters | How Clio helps |
| --- | --- |
| **Your models and infrastructure** | Connect local inference, institutional gateways, or cloud APIs. Use different models for different jobs when you need to. |
| **Understanding the project** | Keep project guidance and a searchable code index alongside the repository, so long sessions have a useful starting point. |
| **Multi-agent work** | Delegate focused tasks to coding, testing, and review agents. Start on one machine; configure workers over SSH for larger workflows. |
| **Work you can check** | Inspect edits, tool activity, usage, and recorded run results. Keep reference tests and scientific checks in the loop. |

You can start with one model and one conversation. Distributed workers,
additional tools, and elaborate workflows are optional.

Try a first request:

> Explain how this repository builds and tests its numerical solver. Identify
> the main entry points and suggest a small verification task before changing code.

## A first session

Run `clio-coder` inside your project and describe the task in plain language.
Tool calls appear as they run, and edits appear as diffs.

| Want to… | Use… |
| --- | --- |
| Find commands | `/help` |
| Change models or settings | `/settings` |
| Browse reusable recipes | `Alt+L` or `/library` |
| Check context use or cost | `/context`, `/cost` |
| Include a project file | Type `@` and choose a path |
| See delegated tasks | `/tasks` |
| Leave the session | `/quit` |

<details>
<summary><strong>More session controls and shortcuts</strong></summary>

| Want to… | Use… |
| --- | --- |
| Run a shell command | `! command` |
| Run a private shell command excluded from model context | `!! command` |
| Ask a side question | `/btw <question>` |
| Request a read-only second opinion | `/oracle <question>` |
| Delegate a focused task | `/run tester "Run the parser tests and explain any failure."` |
| Branch or resume a conversation | `/tree`, `/fork`, `/resume`, `/new` |
| Carry current state into a fresh session | `/handoff <goal>` |
| Open a Library category | `/skills`, `/agents`, `/prompts` |
| Load a specialized skill | `/skill <name>` |
| Export the transcript | `/export` |

Enter steers an active turn; `Ctrl+Q` queues a follow-up; Escape cancels.
Pasted multiline text beginning with `!` or `!!` is treated as prompt text.
Private shell output remains visible to you but is excluded from model replay
and compaction. See [Commands and Modes](docs/guide/commands-and-modes.md).

</details>

## Choose where models run

Start with the model service you already have. Clio supports local engines
including **Ollama, LM Studio, llama.cpp, vLLM, SGLang, and Lemonade**; lab
services such as **LiteLLM gateways and Argonne ALCF inference**; and cloud
providers including **OpenAI, Anthropic, Google, and OpenRouter**.

Quick Connect handles discoverable HTTP endpoints. For subscription sign-in,
AWS credentials, or manual model setup, use **Settings → Targets & Auth**.
The [connection guide](docs/guide/configuration-and-targets.md) covers each route.

<details>
<summary><strong>Provider coverage, separate worker models, and scripted setup</strong></summary>

A saved connection is called a **target**. Chat uses one target; workers may
share it or use their own.

| Connection family | Supported routes |
| --- | --- |
| Local inference | llama.cpp, LM Studio, Ollama, vLLM, SGLang, Lemonade |
| Compatible APIs | OpenAI-compatible and Anthropic-compatible endpoints; LiteLLM |
| Cloud APIs | OpenAI, Anthropic, Google, Groq, Mistral, DeepSeek, OpenRouter, Amazon Bedrock |
| Institutional gateways | Argonne ALCF Sophia and Metis through Globus OAuth |
| Subscriptions | ChatGPT through `openai-codex`; Claude through `anthropic-max` |
| Worker integrations | Claude SDK, Claude Code, experimental Antigravity delegation, and configured ACP agents |

To script setup, use the model ID advertised by your server:

```bash
clio-coder configure \
  --id local-lmstudio \
  --runtime lmstudio \
  --url http://127.0.0.1:1234 \
  --model your-model-id \
  --set-orchestrator \
  --set-fleet-default
clio-coder targets --probe
```

Models differ in tool calling, reasoning, context capacity, and hardware needs.
Start with the measured notes in the [Model Catalog](docs/architecture/model-catalog.md).
Subscription integrations depend on the vendor's current terms and sign-in
support. See the [ALCF guide](docs/architecture/alcf-provider.md) for institutional access.

Advanced settings can route memory, compaction, and worker profiles separately.
Without a separate memory route, memory stays rules-only; compaction uses the
chat model. A LiteLLM gateway retains control of physical backend routing.

</details>

## Grow into larger workflows

Clio can help with everyday development or coordinate several agents across a
research workflow. Add structure when it helps your project.

<details>
<summary><strong>Project guidance, code navigation, and reusable skills</strong></summary>

`CLIO-CODER.md` is your editable project handbook. Clio can draft it from the
repository and adopt guidance from existing agent instruction files. A code
index helps locate files and symbols; skills provide focused procedures when
needed.

```bash
clio-coder context init
clio-coder context index
clio-coder context
```

Generated project state lives under `.clio-coder/`. During longer work, Clio
manages which observations stay in the model's context while retaining durable
history. Skill installation and promotion require operator approval.

Read about [project context](docs/architecture/context-engine.md),
[working sets](docs/architecture/context-working-set.md),
[memory](docs/guide/proactive-memory.md), and
[skills](docs/guide/skills-marketplace.md). For an architecture map,
`clio-coder context map` produces a seed that the optional `archify` skill can render.

</details>

<details>
<summary><strong>Domain plugins and materials research</strong></summary>

Install a complete workflow with its prompts, agents, skills, scripts and references:

```bash
clio-coder library search
clio-coder library install plugin:materio --user
```

In a new session, start with `/materio:help` or
`/materio:identify-research`. The workflow progresses through
supplied-paper literature review, lab feasibility, research tasks, verified
execution, and a text handoff to WTF-P for paper planning. Researchers retain
control of assumptions and scientific decisions.

The [Library](library/README.md) bundles skills, agent recipes, prompts, fleets,
and plugins with Clio-Coder. It verifies complete package pins and supports
previews, updates, removal and drift checks. Its portable skills can also be
installed in Claude Code and discovered by Codex; Clio-Coder can review and
import supported packages from those hosts. The [interop guide](docs/guide/interop.md)
documents the measured formats and their limits. [Plugin usage](docs/guide/plugins.md),
[package authoring](docs/guide/authoring-plugins.md), and
[harness extensions](docs/guide/harness-extensions.md) describe the plugin and
harness-extension contracts. WTF-P installs as a plugin with `clio-coder library
install`; remove an older extension copy with `clio-coder extensions remove wtfp`.

</details>

<details>
<summary><strong>Multi-agent workflows and workers over SSH</strong></summary>

Give workers focused assignments with defined tools, file scopes, and budgets.
Reviewers and judges remain read-only. For a repeatable build-and-test workflow:

```bash
clio-coder fleet new validation-pass --from build-test
clio-coder fleet validate validation-pass
clio-coder fleet graph validation-pass
clio-coder fleet run validation-pass
```

A fleet describes the steps, dependencies, and review gates. Declared SSH nodes
can run the same worker protocol, with explicit placement and capacity. Shared
workspaces must have the same absolute path on each node; `localhost` refers
to the node running the worker. Start with one worker before expanding.

See [Fleet Dispatch](docs/guide/fleet-dispatch.md) and the
[Fleet Demo Runbook](docs/process/fleet-demo-runbook.md).

</details>

<details>
<summary><strong>Automation, editor connections, and recorded results</strong></summary>

```bash
clio-coder run "Summarize this repository's entry points."
clio-coder run "<task>" --json
clio-coder run "<task>" --agent coder
clio-coder acp
```

Headless text mode writes the final answer to stdout and diagnostics to stderr.
`--json` emits JSONL events. `acp` connects editor hosts through the Agent Client
Protocol. Interactive approval prompts cannot be answered headlessly; worker
requests that need permission are denied by default.

Inspect recorded runs with:

```bash
clio-coder evidence list
clio-coder evidence inspect <evidence-id>
clio-coder trace phases <run-id>
clio-coder usage report
```

See [output and exit codes](docs/guide/exit-codes-and-output.md),
[ACP](docs/architecture/acp.md), and [Observability](docs/architecture/observability.md).

</details>

## Safety and scientific validation

Clio lets you choose how much authority to give it. The default allows workspace
edits and requires approval for unrecognized commands. Read-only and more
autonomous modes are available; the safety policy applies at every level.
Workers cannot gain more authority than the session that launched them.

Recorded tool activity and run results help you review the work. They do not
establish scientific correctness. Validate numerical results, inspect changes,
and use your project's reference tests. Usage estimates depend on available
pricing and telemetry; the tracked session budget is not a provider billing cap.

Read the [Safety Model](docs/architecture/safety-model.md) and
[Scientific Validation](docs/process/scientific-validation.md) for the boundaries.

## Install

The npm command in [Get started](#get-started) is the shortest path. Other
package managers install the same CLI; Node.js is required for all of them.

<details>
<summary><strong>Other package managers and the optional Claude SDK</strong></summary>

| Package manager | Install |
| --- | --- |
| pnpm | `pnpm add -g @iowarp/clio-coder` |
| Bun | `bun add -g @iowarp/clio-coder` |
| Yarn Classic | `yarn global add @iowarp/clio-coder` |

Without a global install, use `npx --yes @iowarp/clio-coder@latest`,
`pnpm dlx @iowarp/clio-coder@latest`, or `bunx @iowarp/clio-coder@latest`.
Modern Yarn supports `yarn dlx -p @iowarp/clio-coder@latest clio-coder`.
Keep Node on `PATH`; Bun manages installation but the CLI runs on Node.

The optional Claude Agent SDK includes a large platform-specific binary.
Only the `claude-sdk` worker runtime needs it. To skip it:

```bash
npm install -g @iowarp/clio-coder --omit=optional
```

For pnpm use `--no-optional`; for Bun use `--omit=optional`. Reinstall with
optional dependencies enabled if you need the SDK later. Release `.tgz` files
can also be installed with your package manager. See
[Installation and Lifecycle](docs/guide/installation-and-lifecycle.md).

</details>

<details>
<summary><strong>Build from source</strong></summary>

From source, the latest stable release uses the pinned pnpm workflow:

```bash
git clone --branch v0.4.7 https://github.com/iowarp/clio-coder.git
cd clio-coder
corepack enable pnpm
pnpm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
"$HOME/.local/bin/clio-coder" --version
```

The installer resolves dependencies, builds, and links the CLI into
`${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}`. If Corepack is unavailable, install
pnpm with `npm install -g pnpm@10.34.5`. Use `--dry-run` to preview installation,
`--skip-deps` after syncing dependencies, or
`bash scripts/install-local.sh --skip-deps --no-build` for an existing build.

Run `command -v clio-coder` to check which launcher your shell reaches. After
changing `PATH`, use `hash -r` in Bash or `rehash` in Zsh.

For development without a launcher, run `pnpm install --frozen-lockfile`,
`pnpm run build`, and `node dist/cli/index.js`. `pnpm run dev` rebuilds on edits;
restart Clio to load the new build.

</details>

<details>
<summary><strong>Update, repair, reset, or uninstall</strong></summary>

Use the package manager that installed Clio. For npm:

```bash
npm install -g @iowarp/clio-coder@latest
clio-coder upgrade --post-install
clio-coder doctor
```

For source installs, update your checkout and rerun `pnpm run install:local`.
`clio-coder doctor` checks local health without modifying files;
`doctor --fix` repairs the structures and permissions it supports.
`clio-coder configure --edit` validates settings edits and can repair malformed YAML.

To remove the npm package, use `npm uninstall -g @iowarp/clio-coder`.
Removing the package preserves Clio's user data. For a deliberate data purge,
preview `clio-coder uninstall --dry-run`; `uninstall --remove-binary` also
removes a local source launcher. Per-project files are preserved.

`clio-coder reset --help` lists selective reset options. Use `--dry-run` before
a reset. The [lifecycle guide](docs/guide/installation-and-lifecycle.md) explains
exactly which settings, credentials, and session directories each option affects.

</details>

## Optional interfaces

The terminal is the main starting point. Source checkouts also include a
desktop/browser interface and a local viewer for recorded runs.

<details>
<summary><strong>Desktop and browser GUI</strong></summary>

The GUI in `apps/workbench/` uses your existing Clio configuration. It requires
Deno `>=2.9.5`, workspace dependencies, and `clio-coder` on `PATH`.

```bash
cd apps/workbench
deno task browser       # build and serve on localhost:4173
deno task gui:install   # optional standalone local application
```

The installed launcher is `clio-coder-gui`. Linux, including WSL2, is tested;
native Windows launch is unavailable. Prebuilt GUI downloads are not distributed.
The GUI keeps its own recent-project list; Clio owns sessions and authentication.

See the [GUI guide](apps/workbench/README.md) for installation, state locations,
updates, and removal. There is no `clio-coder workbench` subcommand.

</details>

<details>
<summary><strong>Read-only trace viewer</strong></summary>

From a source checkout:

```bash
clio-coder trace ui --port 4600
```

The viewer binds to `127.0.0.1` and reads the local trace database without
modifying it. The npm package does not include this app. See the
[trace viewer guide](apps/trace-viewer/README.md).

</details>

## Help and documentation

If setup fails, start with `clio-coder doctor` and
`clio-coder configure --section diagnostics`. To discover commands, use
`clio-coder --help`; `--help --all` includes developer tools.

| Looking for… | Start here |
| --- | --- |
| Setup, settings, and connections | [Configuration guide](docs/guide/configuration-and-targets.md) |
| Commands and keyboard shortcuts | [Commands and Modes](docs/guide/commands-and-modes.md) |
| Installation or connection problems | [Troubleshooting](docs/guide/troubleshooting.md) |
| Scientific checks and measurements | [Scientific Validation](docs/process/scientific-validation.md) |
| Architecture and advanced workflows | [Documentation index](docs/README.md) |

When opening an issue, include Clio and Node versions, the relevant doctor
output, and steps to reproduce. Remove credentials and sensitive project data.

## Contributing

Experiences from real research projects are especially useful: a difficult
build, an unreliable model connection, or a workflow that needs better support.
Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and review expectations.
Report security issues through [SECURITY.md](SECURITY.md).

<details>
<summary><strong>Developer commands and guidance for coding agents</strong></summary>

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run dev          # rebuild on source changes
pnpm run ci           # types, lint, build, tests
pnpm run ci:release   # includes package and distribution checks
```

Local imports end in `.js`; tests use `node:test`. Run a focused test with
`pnpm run test:file tests/contracts/<name>.test.ts`. Model-dependent evaluations
under `evals/` are explicit operator runs, separate from deterministic CI.

For agents entering this repository: read `CONTRIBUTING.md`, the local
`CLIO-CODER.md` when present, and the owning subsystem's documentation. Use
focused source reads; treat the schema and behavior contracts as authoritative.
Update conflicting documentation with the code and run the appropriate checks.

Start with [Architecture](docs/architecture/architecture.md),
[Tool Usage](docs/guide/tool-usage.md), and
[Worker Dispatch](docs/architecture/worker-dispatch-mechanics.md).

</details>

## Acknowledgements

Clio Coder is developed by the [Gnosis Research Center](https://grc.iit.edu) at
[Illinois Tech](https://www.iit.edu), in collaboration with the University of
Utah, as part of [IOWarp](https://iowarp.ai). The IOWarp CLIO architecture is
supported by the National Science Foundation under
[Award #2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318),
2024–2029. Principal Investigator: Dr. Xian-He Sun; Co-Principal Investigators:
Dr. Anthony Kougkas, Dr. Jake Hochhalter, and Dr. Vivek Srikumar.

This experiment builds on generous work across the open-source and AI communities:

- **Agent foundations:** [Earendil Works' Pi framework](https://github.com/earendil-works/pi),
  [Anthropic's Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript),
  and the [Agent Client Protocol](https://agentclientprotocol.com).
- **Models and infrastructure:** OpenAI, Anthropic, Google, and the other model
  providers; Ollama, LM Studio, llama.cpp, vLLM, SGLang, Lemonade, and LiteLLM;
  and Argonne ALCF and Globus for institutional inference access.
- **The software underneath:** Node.js, Microsoft's TypeScript and node-pty,
  Tree-sitter, Meta's React, Deno, Vite, esbuild, Biome, and the maintainers of
  our parsing, rendering, and image libraries.
- **Optional terminal tools:** [Herdr](https://herdr.dev),
  [Yazi](https://yazi-rs.github.io), and [croc](https://github.com/schollz/croc).

Clio uses some of these directly and connects to others through optional
integrations. Exact packages are recorded in [package.json](package.json) and
the workspace manifests; component notices are in [NOTICE](NOTICE).

CLIO means **Context Layer for Input/Output**; the name also recalls the Greek
muse of history. Explore the wider ecosystem:
[clio-core](https://github.com/iowarp/clio-core) for data and context storage,
and [clio-kit](https://github.com/iowarp/clio-kit) for scientific tool servers.

---

<p align="center">
  Apache-2.0 · <a href="LICENSE">License</a> · <a href="NOTICE">Notices</a><br />
  <sub>Built for the people who maintain the code that science runs on.</sub>
</p>
