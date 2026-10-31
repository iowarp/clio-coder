<p align="center">
  <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" alt="Clio Coder — IOWarp's coding agent for scientific software" width="100%" />
</p>

# Clio Coder

**A coding agent for scientific software.**<br />
Your models. Your machines. Work you can inspect.

<p align="center">
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm version" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?color=00a6ad&amp;style=flat-square" /></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
</p>

Clio Coder helps you understand and change the code that science runs on:
simulation kernels, numerical libraries, data pipelines, and mixed-language
builds. Connect a local model, your institution's inference service, or a
supported cloud provider. Explore the repository, make a focused change, and
run its tests, numerical comparisons, and performance checks. Review the diff
and recorded results before deciding what to keep.

Start with one conversation. Add workers, reusable procedures, and scientific
tools as the task grows. Clio also supports everyday software engineering.

<p align="center">
  <a href="#get-started"><strong>Get started</strong></a> ·
  <a href="#see-clio-in-action">See it work</a> ·
  <a href="#capabilities">Capabilities</a> ·
  <a href="#interfaces">Interfaces</a> ·
  <a href="#models">Models</a> ·
  <a href="#control-and-inspect-the-work">Control</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://coder.iowarp.ai">Website</a>
</p>

> **Open source, pre-1.0.** The terminal is the primary interface; the desktop
> app is in alpha. Commands and settings can change between minor releases.
> See the [changelog](CHANGELOG.md) when upgrading.

## Get started

You need **a model that supports tool calling**. Linux, macOS, and WSL are the
primary platforms; native Windows is best effort.

### 1. Install and open your project

The recommended installer brings its own Node.js 24 and needs no root:

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
```

Follow the installer's `PATH` instruction if your shell cannot find the command.
Then open a repository you know:

```bash
cd /path/to/your/project
clio-coder
```

Already have **Node.js 22.19 or newer**? Use npm instead:

```bash
npm install -g @iowarp/clio-coder
```

### 2. Connect a model

On a new machine, Clio opens setup. Choose **Guided setup**, select a detected
connection or the source you recognize, choose a model, and save.

| You have | Start with |
| --- | --- |
| Ollama, LM Studio, or another supported local app | **An app on this computer** |
| A local, lab, or institutional model-server endpoint | **A model server**, or **Connect by endpoint** when you know its URL |
| A supported subscription login | **An AI subscription** |
| A provider API key | **A provider account** |
| An installed coding-agent CLI | **An installed coding agent** for a worker connection, alongside a configured chat model |

An existing setup opens chat on its saved route, or tries an available route
when the saved one is missing. Use `/config` to rerun setup and `/model` to
change the conversation's model.

### 3. Ask for something useful

Start by learning the repository before editing:

> Explain how this repository builds and runs its tests. Identify the main
> entry points and suggest one verification task. Do not change files yet.

Then give a focused change with an acceptance criterion:

> Investigate the failing numerical check. Make the smallest fix that
> preserves the public API, run the relevant existing checks, and show me the
> diff. Report anything you could not verify.

Follow the tool calls and read the findings. When Clio runs a check, inspect its
recorded result alongside the proposed change. `/help` lists commands;
`/settings` changes saved defaults; `clio-coder doctor` checks the installation
and connections.

<details>
<summary><strong>Other package managers, no-install use, and building from source</strong></summary>

```bash
# pnpm
pnpm add -g @iowarp/clio-coder

# Bun; clio-coder still runs on Node.js 22.19 or newer from PATH
bun add -g @iowarp/clio-coder

# Run without a global install
npx --yes @iowarp/clio-coder@latest

# Include the optional Claude Agent SDK at install time
curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --include-claude-sdk
```

The installer skips the Claude Agent SDK, about 224 MB, by default. Interactive
Claude setup can offer it on first use.

From source, build the release tag:

```bash
git clone --branch v0.6.6 https://github.com/iowarp/clio-coder.git
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
<summary><strong>HPC hosts, installer locations, and download verification</strong></summary>

The native installer supports x64 Linux with glibc 2.17 or newer, including
HPC login nodes. Its private runtime leaves system Node unchanged.

| Platform | Default install root | Launcher |
| --- | --- | --- |
| Linux | `~/.local/share/clio-coder-install` | `~/.local/bin/clio-coder` |
| macOS | `~/Library/Application Support/clio-coder/install` | `~/.local/bin/clio-coder` |

If the website is unreachable, use the installer attached to the GitHub release:

```bash
curl -fsSL https://github.com/iowarp/clio-coder/releases/latest/download/install.sh | sh
```

The installer checks Node downloads against SHASUMS256.txt and attempts
release-signature verification when `gpgv` or `gpg` is available.

On a Linux terminal, the installer also offers the desktop app. Pass `--gui`
or `--no-gui` to answer up front. See [HPC clusters](docs/guide/hpc-clusters.md)
for proxies, older glibc, mirrors, and airgapped sites, and
[installation and lifecycle](docs/guide/installation-and-lifecycle.md) for
runtime and launcher management.

</details>

<details>
<summary><strong>Native Windows installation — best effort</strong></summary>

WSL uses the Unix installation path. Native Windows has a separate installer:

```powershell
irm https://coder.iowarp.ai/install.ps1 | iex
```

From CMD:

```cmd
curl.exe -fsSL https://coder.iowarp.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

The native installers need no administrator rights. They install under
`%LOCALAPPDATA%\clio-coder\install` and write the launcher to
`%USERPROFILE%\.local\bin\clio-coder.cmd`. PowerShell adds that launcher
directory to your user `PATH` unless you pass `-NoModifyPath`.

Use the current stable release. Native installer verification remains limited:
the optional release job boots the packed candidate on Windows, but does not
verify the complete installer lifecycle. Interactive native terminal use is
best effort; see the [installation guide](docs/guide/installation-and-lifecycle.md).

</details>

<details>
<summary><strong>Beta releases, development snapshots, and returning to stable</strong></summary>

`beta` follows release candidates and newer stable releases:

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh -s -- --channel beta
npm install -g @iowarp/clio-coder@beta
clio-coder upgrade --channel beta
```

In PowerShell:

```powershell
& ([scriptblock]::Create((irm https://coder.iowarp.ai/install.ps1))) -Channel beta
```

**New dev snapshots are currently disabled** while CI trusted publishing is
unavailable. The `dev` channel may point to an existing published version; it
is not a promise of a fresh snapshot of the development branch. Snapshot
version support remains in the release tooling for when publishing resumes.

Return to stable with `clio-coder upgrade --channel latest`, or rerun the
installer with `--channel latest` (`-Channel latest` in PowerShell). This can
install stable even when its version is lower than the prerelease. The notice
names recorded dated lifecycle migrations; switching binaries does not undo
those migrations.

For managed installs, `clio-coder upgrade --rollback` returns to the previous
supported binary and disables background updates. Global npm, pnpm, and Bun
users can select `@iowarp/clio-coder@latest` through their package manager.

</details>

<details>
<summary><strong>Updates, version pins, rollback, reset, and uninstall</strong></summary>

| Goal | Command or setting |
| --- | --- |
| Update on demand | `clio-coder upgrade`, or `/upgrade` inside the terminal |
| Follow stable | `clio-coder upgrade --channel latest` |
| Restore the previous managed binary | `clio-coder upgrade --rollback` |
| Disable background installation | `--no-auto-update` or `CLIO_CODER_AUTO_UPDATE=0` |
| Pin a managed install | Install an exact version with `--version` |
| Clear session state while keeping the launcher | `clio-coder reset` |
| Remove Clio's settings, credentials, data, state, and caches | `clio-coder uninstall` |
| Preserve settings and credentials during uninstall | Add `--keep-config` |
| Also remove the managed launcher, runtime, and installed versions | Add `--remove-binary` |

An idle interactive session checks a managed install's channel at most once a
day. It installs a newer release beside the current one and switches the
launcher; the running session keeps its loaded version until restart. Resume
your conversation afterward with `/resume`. An exact version pin holds the
install there until you explicitly choose to follow a channel again.

For global npm, pnpm, and Bun installations, the terminal checks for updates
and shows a notice. `clio-coder upgrade` updates an npm install; for pnpm and
Bun it prints the package-manager command. Rollback changes the binary and
disables background updates; it does not undo changes made to your project.

See [installation and lifecycle](docs/guide/installation-and-lifecycle.md)
before removing an installation that contains work you want to retain.

</details>

## See Clio in action

**Follow one task from a request to recorded checks.** This real desktop
session runs the temperature-calibration example and shows seven passing tests
beside the conversation, with the recorded check output available for inspection.

[**Watch the verification — 33 seconds, MP4**](https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/recordings/gui-calibration.mp4)
· [GIF preview](https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/recordings/gui-calibration-preview.gif)

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-artifacts.png"><picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-artifacts-light.webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-artifacts.webp" alt="A real calibration task with seven passing tests and recorded verification output beside the conversation" width="1000" />
  </picture></a>
</p>

The capture shows an earlier browser layout. The current desktop groups task
controls in a task rail and Session column. Open an image for its full
resolution.

<details>
<summary><strong>Explore the terminal and desktop captures</strong></summary>

The terminal presents the conversation, tool calls, diffs, approvals, and
worker activity in one workspace. This retained boot capture shows an earlier
development build, before a task has run:

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/tui-boot.png"><img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/tui-boot.webp" alt="Clio Coder terminal boot, showing the project, Git state, model, composer, and context information in an earlier development build" width="1000" /></a>
</p>

The desktop offers a visual workspace for conversations and inspection:

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-overview.png"><picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-overview-light.webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-overview.webp" alt="Clio Coder browser overview with project selection and conversation navigation" width="1000" />
  </picture></a>
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-conversation.png"><picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-conversation-light.webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/screenshots/gui-conversation.webp" alt="An earlier desktop conversation layout with project sessions, model selection, and task controls" width="1000" />
  </picture></a>
</p>

</details>

## Why Clio Coder

Scientific code brings its own constraints: a lab's inference gateway, a
mixed-language toolchain, numerical tolerances, long-running checks, and
collaborators who need to understand a change. Clio gives those requirements
an explicit place in the coding workflow.

| What matters to your team | What Clio provides |
| --- | --- |
| **Choose where inference runs** | Supported local servers, institutional gateways, cloud APIs, and subscription connections. Chat and workers can use different models. |
| **Check the change against the project** | Declared tests and builds, numerical comparisons with explicit tolerances, and performance checks against a budget or baseline. |
| **Delegate a focused assignment** | Workers with declared tools, scope, model, and execution limits; independent implementation, verification, or review within a larger task. |
| **Inspect the work afterward** | Tool activity, diffs, recorded checks, usage, and worker receipts with reported outcomes and limitations. |

There is no Clio Coder account to create. You supply the model connections;
provider charges and access requirements still apply. Use one familiar model
first, then decide whether another model or a worker would help. Supported
coding-agent integrations let you keep using tools you already know.

## Capabilities

Start with the work you need to do. Add coordination and configuration when
they make that work easier.

| Your goal | How Clio helps |
| --- | --- |
| **Understand an unfamiliar codebase** | Read and search source, inspect Git history, navigate a Tree-sitter codemap, and use project instructions to identify relevant code and build steps. |
| **Implement a focused change** | Edit files, follow tool activity, inspect diffs, and run the project's declared tests and builds. |
| **Investigate numerical or performance regressions** | Compare numerical results within stated tolerances and run performance checks against explicit criteria. |
| **Get an independent review** | Give a worker a focused assignment with its own model, tools, and scope; inspect its result and receipt. |
| **Continue a long investigation** | Resume or branch conversations, recall observations, inspect context, and prepare a handoff. |
| **Coordinate a larger job** | Compose parallel, sequential, and review workflows; use isolated task worktrees and inspect compiled fleet plans. |
| **Connect scientific infrastructure** | Use MCP servers, including clio-kit Slurm workflows, through the tool gateway. |
| **Reuse a team's procedure** | Install or author skills, agents, prompts, fleets, plugins, and executable extensions. |

A useful progression is **orient → bound the change → implement → verify →
review**. Write down the expected behavior and what should remain unchanged.
Ask for the existing checks first, then add the reference criteria your
scientific problem needs. Before keeping a result, inspect the changes and
what remains unverified.

For a separate review inside the same conversation:

```text
/run verifier Review the current diff and run the relevant existing checks. Do not edit files.
```

A worker offers another pass over the problem. Its value depends on the
assignment, model, evidence, and checks; agreement between agents alone does
not validate a result.

<details>
<summary><strong>Verification, numerical comparisons, and quality policies</strong></summary>

The `verify` capability runs declared project checks and reports their
outcomes. Builds and tests can establish a concrete software property;
numerical comparisons need a reference and tolerance, and performance checks
need a baseline or budget with meaningful conditions.

A repository quality policy can map changed paths to required checks. Freshness
is evaluated against the inputs each check declares as covered. A recorded
pass becomes stale when those covered inputs change; a policy does not infer
that one test validates every file in a repository.

For numerical work, state the quantity, reference, tolerance, and comparison
conditions. For performance, record the workload and environment.

See [quality policies](docs/guide/quality-policy.md) and
[tool usage](docs/guide/tool-usage.md).

</details>

<details>
<summary><strong>Workers, fleets, and model roles</strong></summary>

Worker recipes declare the assignment, tools, model, and result contract.
Choose a separate reviewer model when another perspective would help.

Fleet workflows compose assignments in parallel, sequential, review, compete,
or council shapes. Task worktrees can separate edits, and compiled plans make
the proposed work available for review before execution. Worktrees separate Git edits; authority and sandboxing remain separate controls.

Worker receipts preserve recorded outcomes, validation, usage, and limitations.
Model identity records the requested model and provider observations when available.

SSH nodes are experimental. Add, install, and test them through
`clio-coder fleet nodes`; dispatch requires a passing recorded readiness test
for the project. See [workers and fleets](docs/guide/fleet-dispatch.md) and
[execution boundaries](#control-and-inspect-the-work).

</details>

<details>
<summary><strong>Project guidance, context, continuity, and memory</strong></summary>

A `CLIO-CODER.md` handbook gives Clio standing project instructions: build
commands, conventions, constraints, and useful validation criteria. Layered
rules and a structural codemap help orient a task; retrieval brings in detail
when needed. Partial instruction coverage appears as a brief terminal notice.

```bash
clio-coder context init
```

Review the generated guidance for your project before relying on it.

Long sessions retain a ledger while working-set selection keeps the active
model context within its budget. Inspect `/context`, recall observations,
resume earlier work, branch a conversation, or prepare a handoff. Context
limits still belong to the active model connection, and a summary does not
make every earlier detail available at once.

Memory proposals can carry recorded evidence for operator review and approval.
Use `/memory` to inspect the memory surface. See
[project context](docs/architecture/project-context.md) and
[context continuity](docs/guide/context-continuity.md).

</details>

<details>
<summary><strong>Everyday commands and keyboard controls</strong></summary>

| Task | Command |
| --- | --- |
| Find commands and shortcuts | `/help` |
| Switch the conversation's model | `/model` |
| Rerun connection setup or change defaults | `/config`, `/settings` |
| Attach a workspace file | Type `@` and choose a path |
| Inspect artifacts, context, memory, or usage | `/view`, `/context`, `/memory`, `/usage` |
| Browse reusable resources | `/library` or <kbd>Alt</kbd> + <kbd>L</kbd> |
| Inspect workers and operator tasks | `/fleet`, `/tasks` |
| Branch or recover a conversation | `/tree`, `/fork`, `/resume` |
| Export a transcript | `/export`, `/export notes.md` |

During a terminal turn, <kbd>Enter</kbd> queues a message for the next steering
slot. <kbd>Alt</kbd> + <kbd>K</kbd> opens that queue to edit, reorder, remove, or
defer messages. <kbd>Escape</kbd> interrupts; <kbd>Alt</kbd> + <kbd>S</kbd>
interrupts with your draft. On permission cards, **Deny** skips a call and
**Stop** ends the turn. <kbd>Ctrl</kbd> + <kbd>G</kbd>, then <kbd>Y</kbd>, toggles
the session's autonomy.

See [commands and modes](docs/guide/commands-and-modes.md) for complete behavior.

</details>

## Interfaces

Use the same model connections, project context, and tool policy from the
surface that fits the task. Settings can be shared, while each conversation
has its own task and session state.

| Surface | Start with | Best suited to |
| --- | --- | --- |
| **Terminal — primary** | `clio-coder` | Interactive coding, investigation, steering, diffs, approvals, and worker activity |
| **Desktop/browser — alpha** | `clio-coder gui` | A visual task workspace with usage, artifacts, evidence, and session inspection |
| **Scripts and CI** | `clio-coder run "your task"` | Unattended tasks with text or structured output |
| **Editors and other hosts** | `clio-coder acp` | Agent Client Protocol integrations, subject to client capabilities |

The desktop is served from your machine and opens in a browser. Its Session
column brings together model health, context, spend, branches, artifacts,
workers, and notices. The terminal remains the fullest interactive surface;
client support determines which ACP extensions an editor can expose.

For automation, give the task its decisions and limits up front. A headless
run has no operator to answer questions or permissions, and permission asks
are denied. Text output goes to stdout, diagnostics to stderr, and `--json`
streams JSONL for a consuming script.

<details>
<summary><strong>Desktop installation, task lifecycle, and background services</strong></summary>

Keep multiple tasks open, with up to four active turns. Idle tasks park after
five minutes and resume when shown again.

`clio-coder gui` reuses an installed desktop service when available; otherwise
it starts a private server tied to the terminal. On Linux,
`clio-coder gui background install` adds the desktop launcher and login service
through a systemd user session. Focusing one existing window requires the
installed Chrome or Edge app; the native Linux launcher opens a browser tab
per launch.

See the [GUI guide](docs/guide/commands-and-modes.md#graphical-application) for
background services, private servers, and lifecycle commands.

</details>

<details>
<summary><strong>Headless output, tool limits, and ACP integrations</strong></summary>

```bash
clio-coder run "Summarize this repository's entry points. Do not change files."
clio-coder run --json --timeout 300 "Run the existing parser tests and report the results."
```

`--allow-tools` limits the main agent's capabilities. `--delegate-tools`
separately limits what dispatched workers may hold. Put missing decisions in
the prompt rather than expecting an unattended run to interview someone.
Specify output and verification criteria for the consuming script.

ACP clients can provide attended approvals and questions. Clio sends live
usage, plan, and workspace updates; its extensions expose artifacts, worker
receipts, shell commands, and steering-queue controls. An editor only exposes
the features it implements. Using Clio as an ACP server is distinct from
asking Clio to delegate to an external ACP agent.

See [output formats](docs/guide/exit-codes-and-output.md) and
[agent interoperability](docs/guide/interop.md).

</details>

## Models

**Bring the inference access that fits your work.** A saved connection is a
**target**: a local server, institutional gateway, provider account, or another
supported runtime. Chat and workers can use different targets, models, and
thinking settings. `/model` changes the conversation; **Settings → Fleet**
configures worker defaults.

| Connection | Supported runtimes and services |
| --- | --- |
| Local and self-hosted | Ollama, LM Studio, llama.cpp, vLLM, SGLang, Lemonade |
| Gateways | LiteLLM, OpenAI-compatible and Anthropic-compatible APIs |
| Cloud APIs | OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, DeepSeek, Amazon Bedrock, Inception Mercury |
| Subscription sign-in | ChatGPT through `openai-codex`; Claude through `anthropic-max` |
| Institutional inference | Argonne ALCF Sophia and Metis through Globus OAuth |

Start with a model whose tool calling works reliably on your chosen runtime.
A supported protocol does not establish every model's capabilities. Once the
main conversation works, try a worker model for a specific assignment and
judge its output against the same acceptance criteria. A different model can
provide another perspective; its speed or agreement is not a quality guarantee.

<details>
<summary><strong>Serving limits, capabilities, and packaged local profiles</strong></summary>

Serving limits come from the live inference server, explicit target settings,
or a labeled cloud-catalog estimate. A profile's maximum context is not the
loaded serving window. An unreported window stays unknown. Live reports
determine tool calling, vision, and reasoning support; a target override can
lower those capabilities but cannot raise them.

The five packaged local profiles are **gpt-oss-20b, Qwen3.8-27B, Gemma 4
26B-A4B, Nemotron 3.5 Lightning 30B-A3B, and Qwen3.5-4B**, checked against their
upstream model cards and templates. Profiles describe upstream behavior,
rather than benchmark performance or a guarantee for every runtime and
quantization. Add your own profiles in the config directory's
`model-profiles.yaml`.

See [connections and targets](docs/guide/configuration-and-targets.md) and the
[model catalog](docs/architecture/model-catalog.md) for model inheritance,
capabilities, context limits, and custom profiles.

</details>

<details>
<summary><strong>External coding agents, data flow, and cost figures</strong></summary>

Clio can delegate through supported managed connectors for Claude Code, Codex,
OpenCode, Pi, and Antigravity. The installed CLI, subscription access, supported
commands, and governance vary by connector.  See
[agent interoperability](docs/guide/interop.md) before enabling write-capable
external delegation.

Sessions and evidence are stored locally. Configured inference providers
receive the requests sent to them; network tools and external agents can have
their own outbound activity. Choose connections and tool authority to match
your project's requirements. Local operation is not a blanket promise that no
request leaves the machine.

Usage and cost displays should be read with their provenance. A rate can be
declared for a target, estimated from a catalog, known free of inference
billing, or unknown. A proxy without declared rates can remain unknown; local
inference still has hardware and operating costs.

</details>

## Control and inspect the work

**Choose the authority. Review the evidence.** Clio can edit files and execute
commands with your operating-system permissions. Its runtime policy controls
which tool calls are admitted; your tests, reference data, performance budgets,
and review determine whether a result is acceptable.

| Control | What to expect |
| --- | --- |
| **Approvals** | Workspace reads, edits, and recognized checks are admitted by default; unfamiliar commands and outward actions request permission. The first test runner after generated edits asks once in an attended session. |
| **Project trust** | Project plugins and extensions wait for workspace approval. Review project safety grants before trusting them. |
| **Worker authority** | Workers receive defined tools and permissions. Native commands can use an available OS sandbox; external agents have different enforcement boundaries. |
| **Inspection** | Follow tool activity, review diffs and recorded checks, inspect usage and worker receipts, and read what remains unverified. |

Yolo removes ordinary approval prompts, while protected paths, hard blocks,
and damage-control rules still apply. Static command scanning has limits;
OS sandbox coverage depends on the execution path and backend. Native worker
commands and supported main-session Yolo scripts can use a sandbox. Other
main-session commands and external agent loops do not gain that isolation.

A passing check establishes what that check actually exercised. A receipt
preserves recorded execution facts. Neither replaces a suitable scientific
reference or a human decision to accept the change. See the
[safety model](docs/architecture/safety-model.md) and
[quality policies](docs/guide/quality-policy.md).

<details>
<summary><strong>Yolo, project trust, and the limits of command scanning</strong></summary>

Approval cards identify the tool, target, effect, and requester. Bash approvals
describe the command's consequence. Approving the first test runner after an
edit covers the rest of that attended session. **Deny** skips a call; **Stop**
ends the turn.

Damage-control rules recognize commands by their text and arguments. They
recognize outward deletion through `rm`, `rmdir`, `unlink`, and supported
`find` forms, including several quoting and wrapper spellings. This is not a
complete interpretation of arbitrary programs: an interpreter, `eval`, an
indirect command name, or another utility can express the same effect without
matching that static rule. A recognized command refusal is not a substitute
for filesystem isolation.

Supported script-file executions in a main session's Yolo can run inside the
OS sandbox. Their write policy differs from a worker's: workspace and approved
scratch/cache roots can be writable, Git operations have specific protections,
and networking remains enabled. Backend availability and the sandbox setting
still determine whether this path is sandboxed, unsandboxed, or refused.

Approve project plugins and extensions with `clio-coder config trust plugins`
or `clio-coder config trust extensions`. An ignored project copy does not
shadow your own trusted copy. Inspect project safety grants with
`clio-coder config trust safety`.

</details>

<details>
<summary><strong>Native workers, external agents, and sandbox coverage</strong></summary>

Each worker Clio runs on a configured target receives an immutable permit for
its tools, asks, and Git allowance. A mismatched digest or a spec exceeding
that permit is refused before the worker starts a model call.

Native worker commands use an OS sandbox when `safety.sandbox: auto` finds a
backend. Linux uses bubblewrap. The macOS `sandbox-exec` (Seatbelt) profile is
experimental and has not been tested on macOS. Set `safety.sandbox: required`
to refuse commands when a backend is unavailable.

Native worker writes are confined to their roots and scratch space. Bubblewrap
provides a private `/tmp`; Seatbelt uses shared system temporary directories.
The repository's `.git` and `.clio-coder` remain read-only to those worker
commands. Network is off unless the worker holds `web_fetch` or
`safety.sandboxNetwork` is enabled.

Claude SDK workers, CLI subprocess workers, and ACP peers do not receive the
native worker's OS sandbox. An ACP peer runs its own tool loop; Clio enforces
the permission requests it sends under the configured `toolGovernance`.
A CLI subprocess target, or an ACP peer with `toolGovernance: agent-managed`,
needs `trustedUnmediated: true` for write-capable work. Its receipt records the
permit Clio would have applied without claiming full-loop enforcement.

</details>

<details>
<summary><strong>Information-flow rules — advanced and opt-in</strong></summary>

Rules in `.clio-coder/safety.yaml` can restrict named paths or tool content to
approved model recipients. Restrictions follow workers, resume, and compaction, including at Yolo.
Projects without rules keep the default behavior. The format may change; see
the [safety model](docs/architecture/safety-model.md).

</details>

## Extend Clio

Teach Clio your project's procedures and connect the tools your work needs.
Project guidance can explain how to build, what to preserve, and which checks
matter. Reusable resources carry that knowledge into recurring assignments.
Executable extensions can add command tools and supported runtime behavior.

| Resource | Use it for |
| --- | --- |
| **Skills** | Reusable instructions and supporting resources for a class of work |
| **Agents** | A focused role with an assignment and execution configuration |
| **Prompts** | Repeatable task instructions |
| **Fleets and workflows** | Coordinating related assignments and review steps |
| **Plugins** | Bundled procedures and resources |
| **Harness extensions** | Executable tools and supported runtime integrations |

Browse with `/library` or the CLI. Project plugins and extensions require
workspace trust before they load. Begin with one procedure you repeat, inspect
its contents and permissions, and add executable behavior only when the task
needs it.

<details>
<summary><strong>Library commands and experimental features</strong></summary>

```bash
clio-coder library search review
clio-coder library install skill:ast-grep
```

Library packages can be pinned and checked for drift. Read the
[library guide](library/README.md) and
[harness extension guide](docs/guide/harness-extensions.md) before authoring or
installing executable components.

| Experimental feature | Availability and limits |
| --- | --- |
| **System One** | Fast decision engines at typed sites; decisions require fitted cuts. Do not assume an unvalidated engine provides calibrated judgments. |
| **Steering triage** | `chat.steering.triage` is off by default; a side model can classify queued messages, defer unrelated work, or interrupt for a confident stop request. |
| **Speculative dispatch** | `fleet.speculativeDispatch` is off by default. |
| **SSH worker nodes** | Explicitly configured nodes need a passing recorded project readiness test before dispatch. |
| **Docks and music** | Off by default and require Herdr; music additionally requires cliamp and explicit integration settings. |

Worker, file, and music docks use <kbd>Alt</kbd> + <kbd>W</kbd>, <kbd>Alt</kbd> +
<kbd>E</kbd>, and <kbd>Alt</kbd> + <kbd>A</kbd>. They hide without stopping their
process; a second tap within 400 ms closes the dock. `/music` needs
`integrations.music.enabled`; model-controlled music also needs
`integrations.music.agentControl`.

See [System One](docs/guide/system-one.md) and the
[experimental articles](https://coder.iowarp.ai/experimental.html) for activation
requirements and the limits of each feature.

</details>

## Documentation

Choose the next question you need answered. Public guides explain installation
and everyday workflows; architecture pages explain implementation boundaries.
The authored guides also ship in the npm package for use from your editor or
through Clio's offline documentation lookup.

| You want to… | Start here |
| --- | --- |
| Install, connect, and troubleshoot | [Public documentation](https://coder.iowarp.ai/docs.html) · [Connections](docs/guide/configuration-and-targets.md) |
| Find a command or output format | [Commands and modes](docs/guide/commands-and-modes.md) · [Output formats](docs/guide/exit-codes-and-output.md) |
| Define checks or coordinate workers | [Quality policies](docs/guide/quality-policy.md) · [Fleet dispatch](docs/guide/fleet-dispatch.md) |
| Understand context and continuity | [Project context](docs/architecture/project-context.md) · [Context continuity](docs/guide/context-continuity.md) |
| Add reusable resources or executable behavior | [Library](library/README.md) · [Harness extensions](docs/guide/harness-extensions.md) |
| Explore the implementation | [Architecture](docs/architecture/architecture.md) · [Complete documentation map](docs/README.md) |

Ask Clio about its own configuration, source, and commands through the offline
`clio_docs` capability. Generated [GitHub Wiki](https://github.com/iowarp/clio-coder/wiki)
pages are separate development reference, and can lag behind the source.

<details>
<summary><strong>For agents reading this repository or helping with an installed Clio Coder</strong></summary>

For repository work, read [CONTRIBUTING.md](CONTRIBUTING.md) and the relevant
architecture guide. A local `CLIO-CODER.md` provides checkout guidance when
present. Resolve implementation questions from source, schemas, and focused
behavioral checks. Release maintenance updates shipped facts; broader product
copy changes deserve a separate editorial review.

For an installed Clio, start with `clio-coder --help` and its bundled docs.
CLI commands use `clio-coder …`; slash commands run inside a conversation.
Retrieve documentation through
`gateway(op="call", capability="clio_docs", args={query: "your question"})`.
Citations resolve relative to the installed package root; see the
[lookup contract](docs/README.md#where-clio-coder-finds-these-docs-when-it-is-running-in-someone-elses-project).

</details>

## Contribute and get help

Clio Coder is pre-1.0 software under active development. Useful reports describe
the task, expected behavior, actual result, Clio and Node versions, and a
reproduction. Relevant diagnostics help distinguish a model limitation from a
connection, tool, or application defect. Redact credentials and private project
data before sharing a report.

Contributions target the current version branch; `main` advances with releases.
Use the contributor guide for the development workflow and scope of checks.
Questions and experience reports from scientific projects help shape the work.

[Issues](https://github.com/iowarp/clio-coder/issues) ·
[Discussions](https://github.com/iowarp/clio-coder/discussions) ·
[Contributor guide](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) ·
[Changelog](CHANGELOG.md)

Report security concerns through [SECURITY.md](SECURITY.md).
General questions: coder@iowarp.ai.

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
