<p align="center">
  <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" alt="CLIO Coder, IOWarp's open-source coding agent for scientific computing and HPC" width="100%" />
</p>

# CLIO Coder

**An open-source coding agent for scientific software. It runs on any model you have, shows the checks behind what it says, and tells you honestly whether the work is finished.**

<p align="center">
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm version" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?color=00a6ad&amp;style=flat-square" /></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
</p>


```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
clio-coder
```

No root and no account. The first launch connects a model.

<p align="center">
  <a href="#what-is-clio-coder">What it is</a> ·
  <a href="#why-clio-coder">Why</a> ·
  <a href="#new-in-085">New in 0.8.5</a> ·
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#what-you-can-do">Tour</a> ·
  <a href="#built-for-science-and-hpc">Science and HPC</a> ·
  <a href="#models">Models</a> ·
  <a href="#safety-and-control">Safety</a> ·
  <a href="#for-ai-agents-installing-clio-coder">For AI agents</a> ·
  <a href="https://coder.iowarp.ai">Website</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/animations/anim-fix-a-test.gif" alt="Animated terminal recording of GPT-6 Luna in CLIO Coder: asked why the absolute-zero test fails, the agent searches the project, edits one line of temperature.mjs from kelvin &lt;= 0 to kelvin &lt; 0, runs the declared test check with exit 0, and reports that all 7 tests pass." width="100%" />
</p>

<p align="center"><em>One request, start to finish: find the bug, change one line, run the project's test, report what passed.</em></p>

## What is CLIO Coder?

CLIO Coder is a coding agent you run in your own repository. You describe a
task, and it reads the code, makes the change, runs your project's checks and
reports what passed, what failed and what it never checked.

It is built for people whose code has to be right: simulations, numerical
libraries, data pipelines and HPC workflows. It runs on a GPU in your lab, a
gateway your institution hosts, or a frontier API, and switching models
changes nothing else.

It is one agent with four ways in: the terminal, `clio-coder run` for scripts
and CI, ACP editors, and a desktop app (alpha). It is open source under
Apache-2.0, with no account and nothing sent home.

## Why CLIO Coder

- **Any model, local to frontier.** Ollama, vLLM or llama.cpp on your own
  hardware, a lab gateway, cloud APIs, and the ChatGPT, Claude and GitHub
  Copilot subscriptions you already pay for. `/model` switches mid-session.
- **Claims tied to checks that ran.** It runs your tests, compares numbers
  within a tolerance you set and reruns an analysis from pinned inputs. A
  passing check is recorded as evidence you can open later.
- **Runs that say honestly how they ended.** The agent declares `done`,
  `partly_done` or `not_done`. CLIO Coder records its own assessment beside
  that claim, and a `done` that left unvalidated changes is recorded as
  partly done.
- **A headless CLI that scripts can trust.**
  `clio-coder run --output-format json` prints one versioned result with a
  typed cause for every exit code. Flags bound requests, tool calls, cost and
  time, and `--dry-run` previews a run without calling a model.
- **A safety floor that holds in yolo.** Yolo removes the approval cards. The
  hard blocks on protected paths, the `/rewind` snapshots and the rule that
  only you change project trust and settings all stay. By default yolo also
  keeps the OS sandbox where one is available.
- **Memory that learns only from evidence.** A note is a claim tied to a
  command that succeeded or a file that was read, and it is checked against
  the repository again before it reaches the model.
- **A fleet with sealed receipts.** Send workers to other models, or to
  Claude Code, Codex, OpenCode, Pi and the Antigravity CLI. Every run seals a
  record that `clio-coder telemetry verify` rechecks on any machine.
- **Context that holds on small windows.** Old tool output is evicted to
  records the agent can recall exactly, before any paid summary, so long
  tasks keep working on a 32K local model.

### What to ask of any coding agent

Claude Code, Codex and OpenCode are capable coding agents, and CLIO Coder
dispatches work to each of them. These are the questions worth asking of any
of them, with CLIO Coder's answer:

| Ask | CLIO Coder |
| --- | --- |
| Will it run on the model I have? | `clio-coder configure` connects a local server, a lab gateway, a cloud key or a subscription. A 32K local model and a frontier API get the same tools, rules and checks. |
| Can my script read the result? | `clio-coder run --output-format json "<task>" \| jq '.outcome, .causes'` prints `succeeded`, or `failed` with codes such as `verify_failed` and `max_cost_usd`. |
| Will it tell me when the work is not finished? | `clio-coder run --exit-code --verify "npm test" --fail-on-verify "<task>"` exits 1 when the agent declared partly done, when its "done" left unvalidated changes, or when the check failed. |
| What still applies with approvals off? | An attempt to delete the workspace's `.git`, or to change project trust, settings or CLIO Coder's own state, is refused at every autonomy level. |
| Can I check a run later, somewhere else? | `clio-coder evidence inspect <runId>` shows what a worker ran, changed and verified, and `clio-coder telemetry verify` rechecks the sealed record on another machine. |
| Does it check numbers, not only tests? | A quality policy can require a comparison within a tolerance, a seeded repeat or a reproduction from pinned inputs. `clio-coder claims` lists what agreed and what did not. |

## New in 0.8.5

0.8.5 is the release to upgrade for if anything other than a person reads
CLIO Coder's output. It is one large release with breaking changes, and the
upgrade migrates your settings.

- **Scripts get a contract.** Before 0.8.5 a script parsed a JSONL event
  stream whose last frame had an exit code but no typed cause. Now
  `clio-coder run --output-format json` prints one versioned result with the
  answer, the exit code, typed causes, the checks that ran and the spend.
- **More ways to bound and preview a run.** `--max-requests` and
  `--max-tool-calls` join `--max-cost-usd`, and `--timeout` now takes
  durations such as `15m`. `--dry-run` shows the route, tools and sandbox
  before any model call, and `--output-schema` returns a JSON object CLIO
  Coder has already validated.
- **A run tells you whether it finished.** The agent's declared state and
  CLIO Coder's assessment are sealed together, and `run --exit-code` fails
  the job on anything short of done.
- **The fleet is graded, not trusted.** A dispatch goes to the agent whose job
  it is, including a built-in `reviewer` for diffs. A worker that returns
  without the evidence its role owes is retried once on another model. The
  Antigravity CLI is now also an ACP delegation target, with model and
  thinking selection, steering and quota reporting.
- **Memory earns its place.** Notes are tied to a command that succeeded or a
  file that was read, lessons are rechecked before delivery, and automatic
  memory spending is capped at a share of the session.
- **Everything is reachable from the shell.**
  `clio-coder session history|show|export|fork|compact`, `run --resume` with
  `--fork`, `fleet run --detach` with `fleet wait`, and
  `clio-coder config get|set|unset`. The `data` tool reads Zarr and inspects
  ADIOS2.
- **The agent gets a browser, and you get a second terminal.** The `browser`
  tool loads pages, runs Playwright scripts and takes screenshots inside the
  same sandbox as `bash`, reaching loopback until you grant a host.
  `/attach` lets `clio-coder session attach <id>` watch a running session,
  answer its approvals or steer it, on the same host or over ssh.
- **Fleet runs stay out of your checkout.** A playbook step with scope
  `worktree` runs in one kept task worktree, and `clio-coder fleet land`
  previews and lands the result.
- **You get the model you asked for.** A cloud or subscription target that
  does not list the requested model, or answers with a different one, is
  refused with a typed cause instead of running the turn on something else.
- **Cost that says who pays.** Declare who funds each target, and `/usage`,
  `clio-coder usage report` and the desktop app keep your extra cost, seat
  credits and the API price of the same usage apart. An amount nothing
  measured reads unknown, never zero.
- **Bring your setup.** `clio-coder interop adopt` ports Claude Code and Codex
  command hooks, stdio MCP servers and user instructions.

**What breaks.** Each command and flag has one spelling, and earlier
spellings are gone: `run` reads stdin only when you pass `-`,
`--output-format` replaces `--json`, and `--resume` replaces `--session`.
Read the [breaking changes](CHANGELOG.md#breaking-changes) and
[upgrading](CHANGELOG.md#upgrading) first.

> **Pre-1.0.** The terminal is the primary interface, and the desktop app is
> in alpha. Commands and settings can change between minor releases.

## Get started

You need a model that supports tool calling. Linux, macOS and WSL are the
primary platforms, and native Windows is best effort.

**1. Install.** The installer brings its own Node.js and needs no root:

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

With Node.js 22.19 or newer already installed, npm works too:

```bash
npm install -g @iowarp/clio-coder
```

**2. Start it in a project.** The first launch connects a model: it offers
what it found on this machine, or you pick an API key, a subscription, a
model server or a setup file from your lab.

```bash
cd /path/to/your/project
clio-coder
```

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/tui-boot.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/tui-boot.webp" alt="CLIO Coder terminal at start: the CLIO Coder wordmark beside the selected model and autonomy, the workspace with its Git state, and the composer reporting the GPT-6-luna model ready." width="100%" /></a>
</p>

**3. Ask for something real.** Start read-only, then give it a change with a
clear finish line:

> Explain how this repository builds and runs its tests. Do not change files.

> The test in tests/test_solver.py fails. Make the smallest fix, run the
> tests, show me the diff, and tell me anything you could not verify.

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/site/assets/tui-verify.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/site/assets/tui-verify.webp" alt="CLIO Coder in the terminal on GPT-6 Luna: it reads two files, runs the failing test check, edits one line with the diff shown, and reruns the check, which passes." width="100%" /></a>
</p>

CLIO Coder asks before commands it cannot sandbox or recognize, and before
outward actions such as `git push`. Ask it about itself and it searches its
own documentation. `/help` lists commands, `clio-coder doctor` checks the
installation, and [your first hour](docs/README.md#your-first-hour) covers
what comes next.

If your shell cannot find `clio-coder`, follow the installer's `PATH`
instruction, then run `command -v clio-coder` to see which file the bare name
reaches.

<details>
<summary><strong>Other package managers, and building from source</strong></summary>

```bash
pnpm add -g @iowarp/clio-coder
bun add -g @iowarp/clio-coder         # still runs on Node.js 22.19+ from PATH
npx --yes @iowarp/clio-coder@latest   # no global install
```

The installer skips the optional Claude Agent SDK (about 224 MB). Claude setup
offers it on first use, or install it up front with
`curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --include-claude-sdk`.

From source, build the release tag:

```bash
git clone --branch v0.8.4 https://github.com/iowarp/clio-coder.git
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
<summary><strong>HPC login nodes and native Windows</strong></summary>

The installer supports x64 Linux with glibc 2.17 or newer, including HPC login
nodes. It puts the launcher at `~/.local/bin/clio-coder` and checks what it
downloads. If the website is unreachable, use
`https://github.com/iowarp/clio-coder/releases/latest/download/install.sh`.
On Linux the installer offers the desktop app, and `--gui` or `--no-gui`
answers up front. [HPC clusters](docs/guide/hpc-clusters.md) covers proxies,
older glibc, mirrors and air-gapped sites.

On native Windows, run `irm https://coder.iowarp.ai/install.ps1 | iex` in
PowerShell. It needs no administrator rights. Release checks only boot the
package on Windows, so interactive use there is best effort, and WSL is the
recommended route.

</details>

<details>
<summary><strong>Update, roll back, reset, and uninstall</strong></summary>

| Goal | Command |
| --- | --- |
| Update now | `clio-coder upgrade`, or `/upgrade` in the terminal |
| Go back to the version before the last upgrade | `clio-coder upgrade --rollback` |
| Turn off background updates | Install with `--no-auto-update`, or set `CLIO_CODER_AUTO_UPDATE=0` |
| Clear sessions but keep settings | `clio-coder reset --state` |
| Start model setup over | `clio-coder reset --settings` |
| Remove CLIO Coder, keeping settings and credentials | `clio-coder uninstall --keep-config` |
| Remove everything | `clio-coder uninstall` |

An installer install checks for a newer release at most once a day while
idle and switches over at the next start. A user-writable npm, pnpm, Bun or
Volta install on Linux or macOS updates after its last session quits; other
installs show a notice. Reset and uninstall preview what they remove and ask first.
See [installation and lifecycle](docs/guide/installation-and-lifecycle.md).

</details>

## What you can do

| You want to | Do this |
| --- | --- |
| Change code and show that it works | State what done means, such as your tests or a tolerance. Results are kept as evidence: `/view`, `clio-coder evidence list`. [Quality policies](docs/guide/quality-policy.md) |
| Keep a record of what held up | Each judged numerical or reproduction check becomes a claim. `clio-coder claims` lists what agreed and what did not. [Claims ledger](docs/architecture/evidence-and-memory.md#claims-ledger) |
| Put several models on one task | `/run reviewer <task>` sends a worker, `/council` gives a group one task, `/poll 3 <question>` takes a vote. [Fleet dispatch](docs/guide/fleet-dispatch.md) |
| Automate it | `clio-coder run --output-format json --max-cost-usd 2 --timeout 15m "<task>"`. [Exit codes and output](docs/guide/exit-codes-and-output.md) |
| Improve a measured number | `clio-coder research` tries changes in worktrees and keeps one only when repeated trials show a gain and every check passes. [Research and arena](docs/guide/research-and-arena.md) |
| Compare models | `clio-coder arena` shows 2 to 4 models' work blind, and `clio-coder campaign run` runs one seeded project across a roster. |
| Tell it once | Type `remember that ...` or `from now on ...`. [Memory](docs/guide/proactive-memory.md#tell-clio-coder-what-to-remember) |
| Know what it cost | `/usage` shows spend per connection, and `/context` shows what fills the window. |
| Run a pipeline with nobody at the keyboard | An extension defines interview steps, and `clio-coder run --answers answers.yaml` answers them from a file. [Scripted answers](docs/guide/harness-extensions.md#checkpoints-and-scripted-answers) |
| Add skills and tools | Install packs such as `hpc`, `hoare`, `science-data` and `literature`, or connect MCP servers. [Library](docs/guide/resource-library.md) · [Extensions](docs/guide/harness-extensions.md) |

## Built for science and HPC

A change to research code is done only when the checks say so. CLIO Coder is
built around that.

- **Login nodes, no root.** One command installs under your home directory on
  x64 Linux with glibc 2.17 or newer. It works behind a proxy and on
  air-gapped sites.
- **Your site's models.** A model server on a compute node, a lab gateway, or
  Argonne ALCF through Globus. A lab publishes one setup file, and
  `clio-coder configure --import <path-or-https-url>` connects everyone.
- **Scientific data.** The `data` tool reads HDF5, NetCDF, Parquet and Zarr
  with summary statistics and inspects ADIOS2 output, so the agent reasons
  about real results.
- **The `hpc` pack.** Skills for Slurm arrays and sweeps, Lmod and Spack,
  parallel HDF5 and MPI-IO, Darshan and ChronoLog, driving the cluster's own
  tools.
- **Correctness reviews.** The `hoare` pack reviews C, C++, Python and Fortran
  functions with Hoare logic, one check per proof obligation.
- **Shared systems.** Session files are owner-only, and the sandbox hides your
  credentials and shell history from the commands the agent runs.

```bash
clio-coder library install plugin:hpc --with-requirements
clio-coder library install plugin:hoare
```

Start with [HPC clusters](docs/guide/hpc-clusters.md), then
[Slurm](docs/guide/slurm.md) and the [store](docs/guide/store.md).

## Models

A saved connection is a **target**. Chat and workers can use different
targets, models and thinking levels, and `/model` switches the conversation.

<p align="center">
  <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/animations/anim-model-switch.gif" alt="Animated terminal recording of the /model picker in CLIO Coder: one session moves from gpt-6-luna to claude-haiku-5-5 and claude-opus-5-5 on a Claude subscription, then gpt-6.1-sol on a ChatGPT subscription, and back to gpt-6-luna." width="100%" />
</p>

| Connection | Supported |
| --- | --- |
| Local and self-hosted | Ollama, LM Studio, llama.cpp, vLLM, SGLang, Lemonade |
| Gateways | LiteLLM, any OpenAI-compatible or Anthropic-compatible API |
| Institutional | Argonne ALCF Sophia and Metis through Globus |
| Cloud APIs | OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, DeepSeek, Inception |
| Subscriptions | ChatGPT (`openai-codex`), Claude (`anthropic-max`), GitHub Copilot (`copilot-sdk`) |
| Other coding agents, as workers | Claude Code, Codex, OpenCode, Pi, Antigravity |

Start with a model whose tool calling works reliably on your runtime. See
[configuration and targets](docs/guide/configuration-and-targets.md).

## Interfaces

| Surface | Start with | Best for |
| --- | --- | --- |
| **Terminal** (primary) | `clio-coder` | Interactive coding, diffs, approvals, worker activity |
| **Scripts and CI** | `clio-coder run --output-format json "task"` | Unattended runs with a JSON result and typed exit codes |
| **Editors** | `clio-coder acp` | Agent Client Protocol clients |
| **Desktop** (alpha) | `clio-coder gui` | Many tasks in one window, with usage, artifacts and evidence |

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-conversation.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-conversation.webp" alt="CLIO Coder desktop conversation reporting seven passing calibration tests and a reference-temperature table" width="100%" /></a>
</p>

See [commands and modes](docs/guide/commands-and-modes.md),
[the GUI guide](docs/guide/gui.md) and [interoperability](docs/guide/interop.md).

## Safety and control

CLIO Coder edits files and runs commands with your permissions. You decide
how much it may do on its own.

| Control | What it does |
| --- | --- |
| **Approvals** | Reads, edits, and sandboxed or recognized commands run. Other commands and outward actions such as `git push` ask first. |
| **Read-only** | `--read-only` leaves every user file exactly as it was. |
| **Sandbox** | Shell commands and workers run in an OS sandbox (bubblewrap on Linux) when one is available. It hides credential files, other agents' logins and your project's secret files. `safety.sandbox: required` refuses to run without it. |
| **Yolo** | For work you leave running. Approval cards never wait. By default yolo keeps the OS sandbox where one is available, and snapshots and the safety judge stay on. |
| **Undo** | `/rewind` restores files from the snapshot taken before a change. |
| **Damage control** | Hard blocks and protected paths apply at every autonomy level. |
| **Project trust** | A repository's own CLIO Coder configuration waits for your approval, and project settings can only tighten safety. |

Command scanning is static and has limits, and the sandbox is the real
boundary where it applies. Each release lists its
[known limits](CHANGELOG.md#known-limits). See
[sandbox and safety](docs/guide/sandbox-and-safety.md) and the
[safety model](docs/architecture/safety-model.md). To report a vulnerability,
follow [SECURITY.md](SECURITY.md).

## No call-home

CLIO Coder sends nothing home in the background. Sessions, evidence and
telemetry stay on your machine, and the providers you configure receive only
the requests you send them. `/report` drafts a bug report, masks paths, host
names and secrets, and shows you the exact text before anything is sent. See
[Share with the maintainers](docs/guide/troubleshooting.md#share-with-the-maintainers).

## For AI agents: installing CLIO Coder

If a user asked you to install, set up or drive CLIO Coder, follow the steps
in the block below. Every command there is non-interactive, and the steps
that need the human are listed at the end.

<details>
<summary><strong>Install, connect a model, and drive <code>clio-coder run</code></strong></summary>

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
anything that would need an approval, and nobody answers its questions unless
`--answers <file.yaml>` scripts them, so put limits and decisions in the task
text.

| Flag | Effect |
| --- | --- |
| `--read-only` | Refuse writes and edits, run shell commands only in the read-only OS sandbox (refused where none is available), and delegate only to runtimes that enforce read-only. |
| `--output-format json\|stream-json` | `stream-json` streams JSONL on stdout: a `session` header first, one `run_end` envelope last, carrying `exitCode`, `outcome` and `result.text`; `json` writes the envelope alone. Read the result from `run_end`. |
| `--timeout <duration>` | Wall-clock limit for the run, such as `90s` or `15m`; exit 124 on expiry. |
| `--max-cost-usd <N>` | Stop when priced spend reaches the cap; exit 4. |
| `--max-requests <N>`, `--max-tool-calls <N>` | Cap the main agent's model requests and tool calls; exit 4. |
| `--dry-run` | Print the route, tools, sandbox and limits, then exit 0 without calling a model. |
| `--target <id>`, `--model <id>` | One-run connection and model. |
| `--cwd <dir>` | Run as if started in `<dir>`. |
| `--resume <id\|prefix\|name>`, `--continue` | Append the turn to an existing session. `--fork` branches a new session from it. |
| `--verify "<cmd>"` | An acceptance check for this run, repeatable. `--fail-on-verify` exits 1 when one fails. |
| `--exit-code` | Exit 1 when the run was assessed `partly_done` or `not_done`. |
| `--output-schema <file.json>` | Require the answer to be one JSON object valid against the schema; exit 1 on a mismatch. |
| `-` | Read the task from stdin. Stdin is ignored without it. |
| `--answers <file.yaml>` | Answer the author-only questions (extension interviews and `operator_only` questions) from this file. |

| Exit code | Meaning |
| --- | --- |
| 0 | The run settled cleanly. |
| 1 | The run failed: an error, a refused command that left nothing done, a failed verifier verdict, or a worker result that was not merged. |
| 2 | Usage or configuration: an unknown flag, target or model, no usable chat route, or a task piped to bare `clio-coder`. |
| 3 | A dispatched worker was ended by permission refusals, or a yolo run was ended by repeated safety-judge blocks. |
| 4 | The priced spend ceiling, `--max-cost-usd`, `--max-requests`, `--max-tool-calls` or a yolo run's autonomous budget stopped the run. |
| 5 | `--answers` met an author question the file did not script. |
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

</details>

<details>
<summary><strong>Working on this repository instead</strong></summary>

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[architecture guide](docs/architecture/architecture.md). The tracked
`CLIO-DEV.md` gives checkout guidance. Contributions target the
current version branch; `main` advances with releases.

</details>

## Documentation

The README is the short version. The guides carry the detail, and CLIO Coder
can search them for you from inside a session.

| You want to… | Start here |
| --- | --- |
| Get productive in the first hour | [Your first hour](docs/README.md#your-first-hour) |
| Run on a cluster | [HPC clusters](docs/guide/hpc-clusters.md) · [Slurm](docs/guide/slurm.md) · [Store](docs/guide/store.md) |
| Install, connect, troubleshoot | [Installation](docs/guide/installation-and-lifecycle.md) · [Connect a model](docs/guide/configuration-and-targets.md) · [Troubleshooting](docs/guide/troubleshooting.md) |
| Find a command or setting | [Commands and modes](docs/guide/commands-and-modes.md) · [Configuration reference](docs/guide/configuration-reference.md) · [Environment variables](docs/guide/environment-variables.md) |
| Script it | [Exit codes and output](docs/guide/exit-codes-and-output.md) · [Tool usage](docs/guide/tool-usage.md) |
| Define checks or coordinate workers | [Quality policies](docs/guide/quality-policy.md) · [Fleet dispatch](docs/guide/fleet-dispatch.md) |
| Understand what it may touch | [Sandbox and safety](docs/guide/sandbox-and-safety.md) · [Safety model](docs/architecture/safety-model.md) |
| Explore the implementation | [Architecture](docs/architecture/architecture.md) · [Documentation map](docs/README.md) · [Wiki](https://github.com/iowarp/clio-coder/wiki) |

The same guides are on the [website](https://coder.iowarp.ai/docs.html).

## Contribute and get help

Questions are welcome in
[Discussions](https://github.com/iowarp/clio-coder/discussions), and no
question is too basic. To report a bug or ask for a feature, run `/report`
inside CLIO Coder or `clio-coder report` in a shell. It fills in your version
and setup, masks private details, and shows you the text before it is sent.
You can also open an [issue](https://github.com/iowarp/clio-coder/issues) by
hand. Experience reports from scientific projects, local models and clusters
are especially welcome.

[Issues](https://github.com/iowarp/clio-coder/issues) ·
[Discussions](https://github.com/iowarp/clio-coder/discussions) ·
[Contributor guide](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) ·
[Changelog](CHANGELOG.md) · [Security](SECURITY.md)

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

CLIO means **Context Layer for Input/Output**. CLIO Coder is the coding agent
of the CLIO family. Related IOWarp projects include
[CLIO Core](https://github.com/iowarp/clio-core) for data and context storage
and [CLIO Kit](https://github.com/iowarp/clio-kit) for scientific tool servers.
