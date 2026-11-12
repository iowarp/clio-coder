<p align="center">
  <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" alt="CLIO Coder, IOWarp's open-source coding agent for scientific computing and HPC" width="100%" />
</p>

# CLIO Coder

**An open-source coding agent for scientific software and HPC, on the models you already have.**

<p align="center">
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm version" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?color=00a6ad&amp;style=flat-square" /></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
</p>

CLIO Coder is a coding agent that runs in your terminal, in scripts, in editors
over ACP and in a desktop app (alpha), and works the same way on a local model,
a lab gateway, a cloud API key or a ChatGPT, Claude or GitHub Copilot
subscription. It is for researchers, research software engineers and developers
who change code that science depends on: simulations, numerical libraries, data
pipelines and HPC workflows, where a change is done only when the checks say so.

- **Every model, one workflow.** Chat on one model and send workers to others:
  a local model for searches, a strong one for review. Your project guidance,
  tools, safety rules and sessions stay the same. No CLIO Coder account.
- **Checks you can inspect.** CLIO Coder runs your tests, compares numbers within a
  stated tolerance, and reruns computations from pinned inputs. It records
  what passed, what failed, and what was never checked.
- **Speaks science.** Reads HDF5, NetCDF and Parquet, keeps results in a
  per-project store, drives Slurm through MCP, and installs on HPC login nodes
  without root.
- **You set the authority.** Approvals, read-only runs, an OS sandbox and
  damage-control rules decide what the agent may touch. Nothing is sent home.

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#what-you-can-do">What you can do</a> ·
  <a href="#models">Models</a> ·
  <a href="#interfaces">Interfaces</a> ·
  <a href="#safety-and-control">Safety</a> ·
  <a href="#for-ai-agents-installing-clio-coder">For AI agents</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://coder.iowarp.ai">Website</a>
</p>

> **Open source, pre-1.0.** The terminal is the primary interface; the desktop
> app is in alpha. Commands and settings can change between minor releases, so
> read the [changelog](CHANGELOG.md) and its Upgrade notes when upgrading.

## Get started

You need a model that supports tool calling. Linux, macOS and WSL are the
primary platforms; native Windows is best effort.

**1. Install.** The installer brings its own Node.js and needs no root:

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

With Node.js 22.19 or newer already installed, npm works too:

```bash
npm install -g @iowarp/clio-coder
```

**2. Start it in a project.**

```bash
cd /path/to/your/project
clio-coder
```

The first launch sets up a model before anything else. CLIO Coder offers what it
found first (a key in your environment, a stored sign-in, a model server on
this machine); otherwise pick what you have: an API key, a subscription, a
model server or gateway, or a setup file from your lab or team. Setup sends the
model one short test message and saves once it answers. Later, `/model`
switches models and `/config` adds another connection.

**3. Ask for something real.** Start read-only:

> Explain how this repository builds and runs its tests, and name its main
> entry points. Do not change files.

Then a focused change with a clear finish line:

> The test in tests/test_solver.py fails. Make the smallest fix, run the
> tests, show me the diff, and tell me anything you could not verify.

CLIO Coder asks before commands it cannot sandbox or recognize, and before outward
actions such as `git push`. Ask it about itself too, such as "how do I send
workers to a different model?": it searches its own bundled documentation.
`/help` lists commands, `clio-coder doctor` checks the installation, and
[your first hour](docs/README.md#your-first-hour) walks through the next
steps. If your shell cannot find `clio-coder`, follow the installer's `PATH`
instruction, then run `command -v clio-coder` to see which file the bare name
reaches.

<details>
<summary><strong>Other package managers, and building from source</strong></summary>

```bash
pnpm add -g @iowarp/clio-coder
bun add -g @iowarp/clio-coder         # still runs on Node.js 22.19+ from PATH
npx --yes @iowarp/clio-coder@latest   # no global install
```

The installer skips the optional Claude Agent SDK (about 224 MB); Claude setup
offers it on first use, or install it up front with
`curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --include-claude-sdk`.

From source, build the release tag:

```bash
git clone --branch v0.8.0 https://github.com/iowarp/clio-coder.git
cd clio-coder
corepack enable pnpm
pnpm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
"$HOME/.local/bin/clio-coder" --version
command -v clio-coder
```

See the [contributor guide](CONTRIBUTING.md) for development on the version branch.

</details>

<details>
<summary><strong>HPC login nodes, native Windows, and rollback</strong></summary>

The native installer supports x64 Linux with glibc 2.17 or newer, including
HPC login nodes, and leaves system Node unchanged. It installs under
`~/.local/share/clio-coder-install` (macOS: `~/Library/Application
Support/clio-coder/install`) with the launcher at `~/.local/bin/clio-coder`.
It checks Node downloads against `SHASUMS256.txt` and verifies the release
signature when `gpgv` or `gpg` is available. If the website is unreachable,
use `https://github.com/iowarp/clio-coder/releases/latest/download/install.sh`.
On Linux it offers the desktop app; `--gui` or `--no-gui` answers up front.
[HPC clusters](docs/guide/hpc-clusters.md) covers proxies, older glibc,
mirrors, and air-gapped sites.

On native Windows, run `irm https://coder.iowarp.ai/install.ps1 | iex` in
PowerShell. It needs no administrator rights and writes the launcher to
`%USERPROFILE%\.local\bin\clio-coder.exe`. Release checks only boot the
package on Windows, so interactive use there is best effort.

`clio-coder upgrade --rollback` restores the version you had before the last
upgrade.

</details>

<details>
<summary><strong>Updates, rollback, reset, and uninstall</strong></summary>

| Goal | Command |
| --- | --- |
| Update now | `clio-coder upgrade`, or `/upgrade` in the terminal |
| Restore the previous installer version | `clio-coder upgrade --rollback` |
| Turn off background updates | Install with `--no-auto-update`, or set `CLIO_CODER_AUTO_UPDATE=0` |
| Clear sessions but keep settings | `clio-coder reset --state` |
| Start model setup over | `clio-coder reset --settings` |
| Remove CLIO Coder, keeping settings and credentials | `clio-coder uninstall --keep-config` |
| Remove everything | `clio-coder uninstall` |
| Remove an installer copy left behind after switching to npm, pnpm, or Bun | `clio-coder uninstall --inactive` |

An installer install checks its channel at most once a day while idle,
installs a newer release beside the current one, and switches over at the
next start; `/resume` picks your conversation back up. npm, pnpm, and Bun
installs show a notice instead. Updates prune versions and runtimes nothing
uses any more, keeping the current and previous version.
Reset and uninstall preview what they remove and ask first, never delete a
directory they cannot prove is CLIO Coder's, and finish by saying what they
removed and what they kept. See [installation and lifecycle](docs/guide/installation-and-lifecycle.md).

</details>

## What you can do

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/tui-boot.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/tui-boot.webp" alt="CLIO Coder terminal at start: the CLIO Coder wordmark beside the selected model and autonomy, the workspace with its Git state, and the composer reporting the Qwen 3.8 model ready." width="100%" /></a>
</p>

**Change scientific code and prove it.** Say what "done" means: tests, a
numerical comparison with a tolerance, a performance budget. CLIO Coder runs the
checks and keeps the results as evidence; `clio-coder evidence list` and
`/view` show them. A `reproduce` check reruns an analysis from sha256-pinned
inputs, and `clio-coder claims` lists what was supported or refuted.

**Work with real data.** The `data` tool inspects HDF5, NetCDF and Parquet
files with summary statistics, so the agent reasons about real outputs instead
of guessing. The project store keeps results and datasets outside the working
tree, shared with workers and linked worktrees, with a record of where each
file came from: `clio-coder store put results run-042/summary.parquet`, then
`clio-coder store stat results:summary.parquet`. See the [store guide](docs/guide/store.md).

**Run on clusters.** Install on a login node without root, work behind a proxy
or on an air-gapped site, and submit and watch Slurm jobs through MCP. A lab
can publish one setup file, and `clio-coder configure --import <path-or-https-url>`
connects everyone to the same gateway. See
[HPC clusters](docs/guide/hpc-clusters.md) and [Slurm](docs/guide/slurm.md).

**Split the work across models.** Workers run on other targets with a fixed
permit for their tools and return a receipt. `/council` puts one task to a
roster of read-only members, `/poll 3 <question>` asks independent agents for a
vote, and `/oracle` asks a read-only advisor to challenge a decision. Claude
Code, Codex, OpenCode and Pi can be workers too, and they follow your project's
rules. See [fleet dispatch](docs/guide/fleet-dispatch.md).

**Automate it.** `clio-coder run "<task>"` is one headless turn for scripts and
CI. `--json` streams JSONL that ends with one `run_end` frame, exit codes say
what the host decided, `--max-cost-usd` and `--timeout` bound the run, and
`--read-only` guarantees no file changes. See
[exit codes and output](docs/guide/exit-codes-and-output.md).

**Climb a metric, compare models.** `clio-coder research` runs CLIO Coder's agent
in worktrees to move one measured number, such as wall time, and keeps a change
only when interleaved trials and a bootstrap interval show a real gain and every
gate check passes. `clio-coder arena` runs one prompt on 2 to 4 models, shows
their work blind, and builds standings from your votes. See
[research and arena](docs/guide/research-and-arena.md).

**Know what it cost.** `/usage` shows spend per target and the cost per
verified outcome. Sessions, evidence, and telemetry stay on your machine.

**Add skills and tools.** Install reviewed packs from the bundled library,
including `hpc`, `science-data`, `literature`, and `life-science`:

```bash
clio-coder library search slurm
clio-coder library install plugin:hpc --with-requirements
```

CLIO Coder also loads MCP servers, skills, agents, prompts, and its own
process-isolated extensions. See the [library](docs/guide/resource-library.md)
and [extensions](docs/guide/harness-extensions.md).

### New in 0.8.0

- **Safe to share one folder.** A second terminal gets its own session and panes, and the sandbox hides other tools' logins, shell histories, browser profiles and token files.
- **Headless `run` you can automate on.** One `run_end` frame, meaningful exit codes, cost caps that trip, proxies honored.
- **A per-project store** for results and datasets, with a record of where each file came from.
- **Reports you review first.** `/report` shows the masked draft before anything is sent, and a share is encrypted and kept in your own gist.
- **Setup and installs that work the first time**, including `configure --import` for a lab's setup file, an HPC login-node guide and a full uninstall.
- **A fullscreen terminal you can copy from.** A mouse selection pastes what was written, not the screen.

0.8.0 changes some exit codes, defaults and permissions. Read the
[Upgrade notes](CHANGELOG.md#upgrade-notes) before upgrading.

## Models

A saved connection is a **target**. Chat and workers can use different
targets, models, and thinking levels, and `/model` switches the conversation.

| Connection | Supported |
| --- | --- |
| Local and self-hosted | Ollama, LM Studio, llama.cpp, vLLM, SGLang, Lemonade |
| Gateways | LiteLLM, any OpenAI-compatible or Anthropic-compatible API |
| Cloud APIs | OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, DeepSeek, Amazon Bedrock, Inception |
| Subscriptions | ChatGPT (`openai-codex`), Claude (`anthropic-max`), GitHub Copilot (`copilot-sdk`) |
| Institutional | Argonne ALCF Sophia and Metis through Globus |
| Other coding agents, as workers | Claude Code, Codex, OpenCode, Pi, Antigravity |

Start with a model whose tool calling works reliably on your runtime; a
supported protocol does not guarantee every model's quality. The providers
you configure receive the requests sent to them. See
[configuration and targets](docs/guide/configuration-and-targets.md) and the
[model catalog](docs/architecture/model-catalog.md).

## Interfaces

| Surface | Start with | Best for |
| --- | --- | --- |
| **Terminal** (primary) | `clio-coder` | Interactive coding, diffs, approvals, worker activity |
| **Desktop** (alpha) | `clio-coder gui` | A visual workspace with usage, artifacts, evidence, and sessions |
| **Scripts and CI** | `clio-coder run "task"` | Unattended runs; `--json` streams JSONL |
| **Editors** | `clio-coder acp` | Agent Client Protocol clients |

All surfaces share the same connections, project context, and tool policy.
See [commands and modes](docs/guide/commands-and-modes.md),
[the GUI guide](docs/guide/gui.md), and [interoperability](docs/guide/interop.md).

## Safety and control

CLIO Coder edits files and runs commands with your permissions. You decide how much
of that it may do on its own.

| Control | What it does |
| --- | --- |
| **Approvals** | Reads, edits, and sandboxed or recognized commands run; other commands and outward actions such as `git push` ask first. |
| **Read-only** | `--read-only` leaves every user file exactly as it was. CLIO Coder may still write its own logs and memory. |
| **Sandbox** | Workers and the main session's shell commands run in an OS sandbox (bubblewrap on Linux) when one is available. It hides credential files, other agents' logins, shell histories, browser profiles, CLIO Coder's own config directory and your project's secret files, and contained commands write their own tool cache instead of yours. `safety.sandbox: required` refuses to run them without it. |
| **Yolo** | For work you leave running: nothing waits for you. It is contained by default, so the sandbox, snapshots and safety judge stay on, and a call that would have asked you is refused back to the agent. |
| **Damage control** | Hard blocks and protected paths apply at every autonomy level. |
| **Secrets** | Credentials are masked in command output and approval cards. |
| **Project trust** | A repository's own CLIO Coder configuration waits for your approval on one card before it loads, and project settings can only tighten safety. |

Command scanning is static and has limits; the sandbox is the real boundary
where it applies, and each release lists its
[known limits](CHANGELOG.md#known-limits). A passing check proves only what
that check exercised. See the [safety model](docs/architecture/safety-model.md)
and [quality policies](docs/guide/quality-policy.md). To report a
vulnerability, follow [SECURITY.md](SECURITY.md).

## No call-home. Sharing is explicit.

CLIO Coder sends nothing home in the background, ever. Sessions, evidence and
telemetry stay on your machine, and the providers you configure receive only
the requests you send them.

When something goes wrong, `/report` (or `clio-coder report`) drafts a report,
masks paths, host names and secrets, and shows you the exact text before
anything is sent. When you want to help improve the harness from real usage,
you share one item at a time, by running the command yourself:
`clio-coder report ... --bundle mechanics --consent debug --share` or
`clio-coder telemetry share ... --send --consent debug`. Each share is
previewed, encrypted so that only the maintainers can open it, uploaded as a
secret gist in your own GitHub account, and deletable with `forget` or on
github.com; once it is 180 days old, your next `clio-coder report` or
`clio-coder telemetry share` deletes it. Your agent never shares for you. See
[Share with the maintainers](docs/guide/troubleshooting.md#share-with-the-maintainers).

## For AI agents: installing CLIO Coder

If a user asked you to install, set up or drive CLIO Coder, follow these
steps. Every command here is non-interactive; steps that need the human are
listed at the end.

1. **Install** without root. `--no-gui` skips the desktop-app question:

   ```bash
   curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --no-gui
   ```

   With Node.js 22.19 or newer on `PATH`, `npm install -g @iowarp/clio-coder`
   also works. On native Windows: `irm https://coder.iowarp.ai/install.ps1 | iex`.

2. **Verify** the launcher the installer wrote:

   ```bash
   export PATH="$HOME/.local/bin:$PATH"
   "$HOME/.local/bin/clio-coder" --version
   command -v clio-coder
   ```

   The installer does not edit shell profiles unless given `--modify-path`.
   If `command -v` prints nothing or another file, tell the user to add
   `~/.local/bin` to `PATH` in their shell profile, or rerun the installer
   with `--modify-path` if they agree.

3. **Connect a model.** Ask the user what they use, then save it as a
   *target* (a named connection) and make it the chat default:

   ```bash
   clio-coder configure --list    # every runtime id and what it needs

   # A local Ollama server
   clio-coder configure --id local --runtime ollama \
     --url http://127.0.0.1:11434 --model <model> --set-orchestrator

   # A lab gateway (LiteLLM or another OpenAI-compatible server)
   clio-coder configure --id lab --runtime litellm \
     --url https://gateway.example.org --model <model> \
     --api-key-env LAB_API_KEY --set-orchestrator

   # A cloud API key the user already exports
   clio-coder configure --id work --runtime anthropic \
     --model <model> --api-key-env ANTHROPIC_API_KEY --set-orchestrator

   # A setup file the user's lab or site publishes
   clio-coder configure --import <path-or-https-url> --yes

   # GitHub Copilot, once the user has signed in (see the end of this list)
   clio-coder tools install copilot-sdk
   clio-coder configure --id copilot --runtime copilot-sdk \
     --model <model> --set-orchestrator
   ```

   `clio-coder models --target <id>` lists the model ids a target offers, and
   `clio-coder targets --probe` checks each connection. Add `--verify` to a
   `configure --id` line to send one test request and save only if the model
   answers. Never write a key into a file or onto a command line yourself:
   `--api-key-env` names a variable, and CLIO Coder reads it at call time.

4. **Check the installation:** `clio-coder doctor` lists problems first, and
   `clio-coder doctor --fix` makes the repairs it can make safely. It exits 0
   when nothing needs attention and 1 when a problem remains.

5. **Smoke test** in the user's project. `--read-only` guarantees no file
   changes; exit code 0 means the model answered:

   ```bash
   clio-coder run --read-only "Summarize this repository and how to run its tests."
   ```

**Driving `clio-coder run`.** One call is one headless turn. It denies
anything that would need an approval and has no way to ask a question, so put
limits and decisions in the task text.

| Flag | Effect |
| --- | --- |
| `--read-only` | Deny every write, command and delegation. |
| `--json` | Stream JSONL on stdout: a `session` header first, one `run_end` frame last, carrying `exitCode` and `outcome`. Read the result from `run_end`. |
| `--timeout <seconds>` | Wall-clock limit for the run; exit 124 on expiry. |
| `--max-cost-usd <N>` | Stop when priced spend reaches the cap; exit 4. |
| `--target <id>`, `--model <id>` | One-run connection and model. |
| `--cwd <dir>` | Run as if started in `<dir>`. |
| `--session <id>`, `--continue` | Append the turn to an existing session. |
| `--verify "<cmd>"` | An acceptance check for this run, repeatable. |

| Exit code | Meaning |
| --- | --- |
| 0 | The run settled cleanly. |
| 1 | The run failed: an error, a refused command that left nothing done, a failed verifier verdict, or a worker result that was not merged. |
| 2 | Usage or configuration: an unknown flag, target or model, no usable chat route, or a task piped to bare `clio-coder`. |
| 3 | A dispatched worker was ended by permission refusals, or a yolo run was ended by repeated safety-judge blocks. |
| 4 | The priced spend ceiling, `--max-cost-usd` or a yolo run's autonomous budget stopped the run. |
| 124 | `--timeout` expired. |
| 129, 130, 143 | SIGHUP, SIGINT or SIGTERM ended the run. |
| 141 | The reader of stdout went away. |

The answer goes to stdout. Notices, the `observed:` line (tool calls,
refusals, writes and checks the harness saw) and errors go to stderr.

**Files and where to look.**

- `clio-coder paths --json` prints the resolved config, data, state and cache
  directories. User settings are `settings.yaml` in the config directory.
- A project's own files live in `.clio-coder/` at the repository root, and its
  handbook is `CLIO-CODER.md`. `clio-coder context init` drafts one.
- `clio-coder --help` and `clio-coder <command> --help` are the command
  reference. The guides in [docs/](docs/README.md) ship inside the package;
  start with [exit codes and output](docs/guide/exit-codes-and-output.md),
  [commands and modes](docs/guide/commands-and-modes.md) and
  [troubleshooting](docs/guide/troubleshooting.md), which is indexed by exact
  error message.
- To report a problem you hit, `clio-coder report bug --title "<title>" --dry-run`
  previews the masked report and sends nothing. Sending is the user's decision.

**Leave these to the human:**

- Subscription sign-ins open a browser on a desktop; over SSH or without a
  display they print a link to open on another device, with a code to enter
  there or to paste back:
  `clio-coder auth login openai-codex` (ChatGPT),
  `clio-coder auth login anthropic-max` (Claude), or
  `clio-coder auth login alcf` (Argonne). For GitHub Copilot, the user signs in
  with `copilot login` or `gh auth login`; then you can run the Copilot lines
  in step 3. A headless run cannot see a login kept only in the system
  keychain, and `clio-coder doctor` names the login it sees.
- The interactive terminal (`clio-coder`), the setup wizard
  (`clio-coder configure` with no flags), and approving project trust.
- Sending a report or sharing a diagnostic bundle.

<details>
<summary><strong>Working on this repository instead</strong></summary>

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[architecture guide](docs/architecture/architecture.md). The tracked
`CLIO-DEV.md` gives checkout guidance. Contributions target the
current version branch; `main` advances with releases.

</details>

## Documentation

| You want to… | Start here |
| --- | --- |
| Get productive in the first hour | [Your first hour](docs/README.md#your-first-hour) |
| Install, connect, troubleshoot | [Installation](docs/guide/installation-and-lifecycle.md) · [HPC clusters](docs/guide/hpc-clusters.md) · [Connect a model](docs/guide/configuration-and-targets.md) · [Troubleshooting](docs/guide/troubleshooting.md) |
| Find a command or setting | [Commands and modes](docs/guide/commands-and-modes.md) · [Configuration reference](docs/guide/configuration-reference.md) · [Environment variables](docs/guide/environment-variables.md) |
| Script it | [Exit codes and output](docs/guide/exit-codes-and-output.md) · [Tool usage](docs/guide/tool-usage.md) |
| Define checks or coordinate workers | [Quality policies](docs/guide/quality-policy.md) · [Fleet dispatch](docs/guide/fleet-dispatch.md) · [Store](docs/guide/store.md) |
| Understand what it may touch | [Safety model](docs/architecture/safety-model.md) |
| Explore the implementation | [Architecture](docs/architecture/architecture.md) · [Documentation map](docs/README.md) |

The same guides are on the [website](https://coder.iowarp.ai/docs.html).

## Contribute and get help

Questions are welcome in
[Discussions](https://github.com/iowarp/clio-coder/discussions), and no
question is too basic. To report a bug or ask for a feature, run `/report`
inside CLIO Coder or `clio-coder report` in a shell: it fills in your version
and setup, masks private details, and shows you the text before it is sent. You
can also open an [issue](https://github.com/iowarp/clio-coder/issues) by hand.
Experience reports from scientific projects, local models and clusters are
especially welcome.

[Issues](https://github.com/iowarp/clio-coder/issues) ·
[Discussions](https://github.com/iowarp/clio-coder/discussions) ·
[Contributor guide](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) ·
[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · coder@iowarp.ai

## Acknowledgements

CLIO Coder is developed by the [Gnosis Research Center](https://grc.iit.edu) at
[Illinois Tech](https://www.iit.edu), in collaboration with the
[University of Utah](https://www.utah.edu), as part of [IOWarp](https://iowarp.ai).
The IOWarp CLIO architecture is supported by the National Science Foundation
under collaborative awards
[OAC-2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318) and
[OAC-2411319](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411319), 2024–2029.

CLIO Coder builds on the [Pi agent framework](https://github.com/earendil-works/pi),
[ACP](https://agentclientprotocol.com), and [MCP](https://modelcontextprotocol.io).
Its panes are powered by [herdr](https://github.com/herdrdev/herdr) (Apache-2.0),
whose license ships beside the installed binary.
Dependency and component notices are in [NOTICE](NOTICE).

CLIO means **Context Layer for Input/Output**. Related IOWarp projects include
[clio-core](https://github.com/iowarp/clio-core) for data and context storage and
[clio-kit](https://github.com/iowarp/clio-kit) for scientific tool servers.
