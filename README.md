<p align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" type="image/webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.png" alt="Clio Coder — IOWarp's terminal coding agent for scientific software" width="100%" />
  </picture>
</p>

<h1 align="center">Clio Coder</h1>

<p align="center">
  <strong>The coding agent for the people who maintain the code that science runs on.</strong><br />
  Your models. Your machines. Work you can inspect.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm version" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?color=00a6ad&style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/iowarp/clio-coder/ci.yml?branch=main&label=CI&style=flat-square" /></a>
  <a href="#get-started"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="Part of IOWarp" src="https://img.shields.io/badge/IOWarp-CLIO-00a6ad?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#what-clio-can-do">Capabilities</a> ·
  <a href="#choose-your-models">Models</a> ·
  <a href="#documentation-you-can-ask-about">Documentation</a> ·
  <a href="#contribute">Contribute</a>
</p>

Clio Coder is an open-source coding agent that lives in your terminal and works
in your real repositories. Ask her to explain a codebase, chase a failing test,
implement a change, or hand pieces of a job to a fleet of workers. Every tool
call is visible, every diff is yours to read, and every result comes with the
evidence behind it.

Clio was built for scientific software and high-performance computing, where
the code is old, the builds are strange, and being wrong is expensive. She is
just as at home with everyday software engineering. Point her at a model on
your laptop, your lab's inference gateway, or a cloud API, and start with one
conversation. Workers, fleets, skills, and MCP servers are there when a task
grows past what one agent should do alone.

**v0.5.3 adds diffusion model support with fill-in-the-middle, an alpha System
One decision surface, and MCP tool discovery that no longer launches a server to
answer a question.**
The terminal is the primary interface. Clio is pre-1.0 software: review her
changes and validate scientific results against your own reference checks.

## Get started

You need **Node.js 22.19 or newer** and a model to talk to. Linux and macOS are
the primary terminal platforms; Windows support is best effort.

```bash
npm install -g @iowarp/clio-coder
cd /path/to/your/project
clio-coder configure
clio-coder
```

Choose **Quick Connect** in the configuration launcher. Paste your endpoint,
provide credentials if the server needs them, pick a model, and review the
connection. LM Studio commonly listens at `localhost:1234` and Ollama at
`localhost:11434`. For subscription sign-in or other provider-specific setup,
use **Settings → Connections**.

Then give Clio something concrete:

> Explain how this repository builds and tests its solver. Find the main entry
> points and suggest one small, useful verification task before changing code.

The default **auto-edit** mode allows workspace edits and recognized test
commands. Other commands and protected operations ask for approval first.
[Configure permissions and limits](docs/guide/configuration-and-targets.md)
when you need a different balance.

<details>
<summary><strong>Installation options</strong></summary>

| Use case | Command |
| --- | --- |
| Install with pnpm | `pnpm add -g @iowarp/clio-coder` |
| Try without a global install | `npx --yes @iowarp/clio-coder@latest` |
| Omit the optional Claude SDK worker dependency | `npm install -g @iowarp/clio-coder --omit=optional` |
| Check your installation | `clio-coder doctor` |

Node.js is still required when another package manager performs the install.
The optional Claude Agent SDK includes a platform-specific binary; ordinary
chat and native workers do not require it.

For the bootstrap installer, source builds, upgrades, and removal, see
[Installation and Lifecycle](docs/guide/installation-and-lifecycle.md).

</details>

## What Clio can do

| You want to… | Clio brings… | Read more |
| --- | --- | --- |
| **Understand a repository** | File, symbol, and structure navigation over a code index, bounded search with ripgrep, and a generated project handbook (`clio-coder context init`). | [Context engine](docs/architecture/context-engine.md) |
| **Make and prove a change** | Exact edits and diffs, shell execution, streamed scientific processing steps, declared verification checks, numerical comparisons, and performance budgets. | [Tools](docs/guide/tool-usage.md) |
| **Delegate and supervise** | Built-in coding, testing, review, and research recipes; separate worker models; multi-node fleets with placement, gates, steering, and receipts. | [Fleet dispatch](docs/guide/fleet-dispatch.md) |
| **Keep a long task alive** | Context accounting and compaction, a non-destructive working set, proactive task memory, durable history, and fork, resume, and handoff between sessions. | [Context continuity](docs/guide/context-continuity.md) |
| **Reach your tools** | Local MCP servers through one gateway with cached discovery, Slurm through clio-kit, pinned external programs, and terminal panes beside the session. | [MCP and the gateway](docs/guide/tool-usage.md#gateway-discover-and-call-secondary-capabilities) · [Slurm](docs/guide/slurm.md) |
| **Add domain knowledge** | A library of skills, prompts, agents, plugins, and fleets with a marketplace, integrity pins, and portable share archives. Resources from Claude Code, Codex, Copilot CLI, and OpenCode can be adopted in place. | [Library](library/README.md) · [Interop](docs/guide/interop.md) |
| **Inspect what happened** | Tool activity, usage and cost, traces, recorded decisions, evidence bundles, worker receipts, and evidence-aware Git commit trailers. | [Observability](docs/architecture/observability.md) |
| **Know what you have left** | `/usage` shows subscription headroom for connected accounts beside this session's tokens, cost, per-model shares, and worker accounting. | [Quota and usage](docs/guide/commands-and-modes.md#subscription-quota-and-session-usage) |

These capabilities compose. A worker result is a lead you can inspect, a
passing command is evidence of that command's outcome, and neither replaces
scientific validation.

### Work in the terminal

The TUI keeps the conversation, tool activity, diffs, and permission decisions
in one place. Its footer shows the active model, remaining subscription
headroom where a connected account reports one, and context use. Dashboards
provide more detail without taking over the conversation.

| Want to… | Use… |
| --- | --- |
| Find commands and shortcuts | `/help` |
| Choose a model or change settings | `/model`, `/settings` |
| Attach a project file | Type `@` and choose a path |
| Inspect context, memory, or usage | `/context`, `/memory`, `/usage` |
| Browse skills, agents, prompts, and fleets | `/library` or `Alt+L`, `/skills` |
| Inspect workers | `Alt+W` |
| Manage the task board | `/tasks` |
| Branch or recover a conversation | `/tree`, `/fork`, `/resume` |
| Leave the session | `/quit` |

With the default bindings, **Enter** steers an active turn, **Ctrl+Q** queues a
follow-up, and **Escape** interrupts. Permission cards offer separate **Deny**
and **Stop** actions: deny skips the displayed invocation, stop ends the turn.
Worker cards explain when identical calls in the same run can reuse a decision.

Clio includes contextual guidance by default. Use `clio-coder --no-demo` for a
quieter session, or change `interface.demo` in `/settings`. See the full
[command and shortcut reference](docs/guide/commands-and-modes.md).

### Start small, then delegate

Give the main agent a bounded change and its acceptance criteria:

> Add a regression for the boundary case, make the smallest fix, and run the
> relevant checks. Keep the public API unchanged. Do not commit or push.

When an independent second pass would help, run a worker explicitly:

```text
/run verifier Review the current diff and run the relevant existing checks. Do not edit files.
```

Configure a different worker model under **Settings → Fleet**, or author
repeatable multi-step workflows as fleets with `clio-coder fleet`. Local workers
are enough to get started; [SSH placement](docs/guide/fleet-dispatch.md) across
nodes is optional.

### Use the same harness in automation

```bash
clio-coder run --autonomy read-only "Summarize this repository's entry points."
clio-coder run --json "Investigate the failing parser test and report the evidence."
clio-coder acp
```

Headless text mode writes the final answer to stdout and diagnostics to stderr;
`--json` emits JSONL events. `acp` serves Clio to compatible editor hosts over
the Agent Client Protocol. Headless runs cannot answer interactive permission
prompts. See [output and exit codes](docs/guide/exit-codes-and-output.md) and
[ACP integration](docs/architecture/acp.md).

## Choose your models

A saved connection is a **target**. Chat, workers, and optional model-assisted
memory can use different targets and models, so a small fast model can do the
routine work while a stronger one reviews it.

| Where the model runs | Examples |
| --- | --- |
| **Your workstation or server** | Ollama, LM Studio, llama.cpp, vLLM, SGLang, Lemonade |
| **A gateway or compatible API** | LiteLLM, OpenAI-compatible and Anthropic-compatible endpoints |
| **Cloud APIs** | OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, DeepSeek, Amazon Bedrock, Inception Mercury |
| **Subscription sign-in** | ChatGPT through `openai-codex`; Claude through `anthropic-max` |
| **Institutional inference** | Argonne ALCF Sophia and Metis through Globus OAuth |

Model capabilities vary. Clio probes tool calling, context capacity, and
reasoning support per route and records what it measured. Diffusion models such
as Mercury also serve fill-in-the-middle completions through the same
`infill()` path as llama.cpp. Subscription integrations depend on vendor
sign-in support and terms; a gateway controls its own backend placement.

The [connection guide](docs/guide/configuration-and-targets.md) covers setup,
and the [model catalog](docs/architecture/model-catalog.md) explains measured
capabilities and runtime differences. Without a separate memory route, task
memory uses rules rather than another model.

## Documentation you can ask about

**Ask Clio how to use or extend Clio.** Her documentation, prompt fragments,
agent recipes, and source ship with the package. The harness directs questions
about its own features to the installed documentation, so Clio can look up the
version you are actually running instead of guessing from your project's files.

Try: “How do I use a different model for workers?” or “What can you do without
asking me?” Treat her answer as an explanation you can check against the linked
guide and effective settings.

Read the same documentation in your browser:

```bash
clio-coder docs
clio-coder docs safety
```

The pages are rendered locally from the bundled Markdown, with navigation and page
outlines. See the [GUI reference](docs/gui/README.md) for how that local server
starts and stops.

| Looking for… | Start here |
| --- | --- |
| A map of the documentation | [Documentation index](docs/README.md) |
| First connection and effective settings | [Configuration and targets](docs/guide/configuration-and-targets.md) |
| Default settings keys and source pointers for CLI flags, environment variables, and project schemas | [Configuration reference](docs/guide/configuration-reference.md) |
| Commands and keyboard controls | [Commands and modes](docs/guide/commands-and-modes.md) |
| Connection or installation trouble | [Troubleshooting](docs/guide/troubleshooting.md) and `clio-coder doctor` |
| Scientific checks and measurements | [Scientific validation](docs/process/scientific-validation.md) |
| How to extend the harness | [Extensions](docs/guide/harness-extensions.md) and [plugins](docs/guide/authoring-plugins.md) |

## Choose authority, keep the evidence

Clio offers **read-only**, **suggest**, **auto-edit** (the default), and
**full-auto** modes. Full-auto removes routine autonomy prompts; it does not
disable safety-net checks, protected-path rules, or explicit task constraints.
Workers remain bounded by the authority and scope of their assignment, and a
recipe's tool ceiling is a ceiling on what its run can start.

Clio is **not a general operating-system sandbox**. Tool admission, receipts,
and validation help you supervise work; they cannot establish scientific
correctness or make arbitrary shell programs safe. The tracked dollar budget
depends on available usage and pricing data and is not a provider billing cap.

Read the [safety model](docs/architecture/safety-model.md), use reference tests,
and review changes before delivery. Report security problems privately through
[SECURITY.md](SECURITY.md).

## Install

The npm command in [Get started](#get-started) is the shortest path. The
[installation guide](docs/guide/installation-and-lifecycle.md) also covers the
bootstrap installer, upgrades, selective resets, and removal.

<details>
<summary><strong>Build and install a published release from source</strong></summary>

From source, pin the release you intend to run. The following selects v0.5.3
once its release tag is published; for development before the tag, use the
[contributor checkout instructions](CONTRIBUTING.md#set-up-a-checkout).

```bash
git clone --branch v0.5.3 https://github.com/iowarp/clio-coder.git
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
`bash scripts/install-local.sh --dry-run`.

Run `command -v clio-coder` to check which launcher your shell reaches. After
changing `PATH`, use `hash -r` in Bash or `rehash` in Zsh. An older global
installation can otherwise shadow the launcher you just installed.

</details>

<details>
<summary><strong>Update or remove an npm installation</strong></summary>

```bash
npm install -g @iowarp/clio-coder@latest
clio-coder upgrade --post-install
clio-coder doctor
```

`npm uninstall -g @iowarp/clio-coder` removes the package and preserves user data.
If you installed the optional background app service, remove it with
`clio-coder gui background uninstall` before removing the package. For a deliberate
Clio data purge, first inspect `clio-coder uninstall --dry-run`; see the
[lifecycle guide](docs/guide/installation-and-lifecycle.md) for exact scope.

</details>

## Contribute

A difficult build, an unreliable connection, or a workflow that takes too much
babysitting makes a useful bug report. Include your Clio and Node versions,
reproduction steps, and relevant `clio-coder doctor` output. Remove credentials
and sensitive project data.

- [Report an issue or suggest an improvement](https://github.com/iowarp/clio-coder/issues)
- [Set up a development checkout](CONTRIBUTING.md)
- [Read the release notes](CHANGELOG.md)
- [Contribute a skill or workflow](library/README.md)

Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

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

---

<p align="center">
  <strong>Clio Coder</strong> · Apache-2.0 · <a href="LICENSE">License</a> · <a href="NOTICE">Notices</a><br />
  <sub>Built for the people who maintain the code that science runs on.</sub>
</p>
