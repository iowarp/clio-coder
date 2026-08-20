<p align="center">
  <picture>
    <source srcset="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.webp" type="image/webp" />
    <img src="https://raw.githubusercontent.com/iowarp/clio-coder/main/assets/banner.png" alt="Clio Coder, the coding agent in IOWarp's CLIO ecosystem of agentic science" width="100%" />
  </picture>
</p>

<h1 align="center">Clio Coder</h1>

<p align="center"><strong>The coding agent for the people who maintain the code that science runs on.</strong><br />Your models. Your machines. A receipt for everything it did.</p>

<p align="center">
  <a href="https://github.com/iowarp/clio-coder/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/tag/iowarp/clio-coder?sort=semver&label=release&color=00d4db&style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@iowarp/clio-coder"><img alt="npm" src="https://img.shields.io/npm/v/%40iowarp%2Fclio-coder?label=npm&color=cb3837&style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/iowarp/clio-coder/ci.yml?branch=main&label=ci&style=flat-square" /></a>
  <a href="#install"><img alt="Node >=22.19" src="https://img.shields.io/badge/node-%3E%3D22.19-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00d4db?style=flat-square" /></a>
  <a href="https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318"><img alt="NSF #2411318" src="https://img.shields.io/badge/NSF-%232411318-241131?style=flat-square" /></a>
</p>

---

Clio Coder is a terminal coding agent built for scientific and HPC software:
simulation kernels, data pipelines, numerical libraries, and build systems that
take twenty minutes and break in ways no cloud model has ever seen.

You bring the model. A llama.cpp, Ollama, LM Studio, vLLM, or SGLang server on
your own GPU; a cloud API; your ChatGPT or Claude subscription; or an Argonne
Leadership Computing Facility inference gateway. Clio brings the harness around
it: a terminal UI that stays out of your way, twenty typed tools instead of a
raw shell, a fleet of bounded worker agents that can run across your whole
cluster over SSH, durable sessions, and a sealed receipt for every run.

CLIO stands for Context Layer for Input/Output. Clio Coder is the interactive
coding agent in IOWarp's ecosystem of agentic science, named for the Greek muse
of history and built by the Gnosis Research Center at Illinois Tech.

## Get started

```bash
npm install -g @iowarp/clio-coder
clio-coder configure      # pick a model provider or a local server
clio-coder                # start the interactive session in any project directory
```

Requires Node.js `>=22.19.0`. `configure` lists the runtimes, asks for the
endpoint and model, probes it, and saves it as the chat and worker target; bare
`clio-coder` opens the same wizard when nothing usable is configured yet. In the
first session, type a request in plain words or `/help` for the command
palette. `/settings` changes the model later, `/quit` leaves, and
`clio-coder doctor` reports the install's health at any time.

|  | You are | Start here |
| --- | --- | --- |
| 🔬 | A researcher or developer who wants to use it | [Your models](#your-models-your-choice) → [At the keyboard](#at-the-keyboard) → [Safety](#safety-you-can-read) |
| 🤖 | An AI agent that just landed in this repository | [For agents](#for-agents) |
| 🛠️ | A developer who wants to contribute | [For contributors](#for-contributors) |

## Why Clio

Most coding agents ask you to trust a remote model with a shell. Clio makes a
different bet: the harness should be strong enough that a 20B model on your own
GPU is genuinely useful, and honest enough that you can reconstruct every
decision afterward.

- **The model never gets a shell by default.** Twenty typed tools in seven
  policy planes. Bash is default-deny behind
  [damage-control rules](damage-control-rules.yaml) and per-project policy,
  reads are bounded, writes are queued and reviewable, and every privileged
  call passes through one admission path the model cannot talk its way around.
- **Local models are the design target, not a fallback.** Clio keeps the
  compiled prompt and tool schemas byte-stable so a llama.cpp prefix cache
  stays hot across turns and sessions, bounds every tool result so one `grep`
  cannot blow the window, and records a per-call cache verdict in the ledger
  so you can see when and why the cache went cold.
- **Work goes to bounded workers, not one long context.** The orchestrator
  dispatches focused agents with explicit tool profiles, call budgets, cost
  ceilings, and typed result contracts. A worker that cannot produce a
  conforming answer fails loudly instead of returning confident prose.
- **Your cluster is the runtime.** Declare your nodes and the same worker
  protocol tunnels over SSH with the same prompts, the same safety matrix, and
  the same receipts. Placement is deterministic and pinnable; capacity is
  governed by durable leases that survive process death.
- **Everything is auditable.** Every run seals a receipt covering tokens,
  priced cost, tool activity, safety decisions, routing, worker attestation,
  and result conformance. Nothing in the audit trail is reconstructed from
  prose.
- **Science is a first-class domain.**
  [clio-kit](https://github.com/iowarp/clio-kit) adds MCP servers for HDF5,
  Slurm, ParaView, Pandas, NetCDF, FITS, Zarr, and ArXiv, and the shipped
  skills catalog includes scientific debugging and experiment-protocol guides.

## Your models, your choice

Clio treats models as named **targets**: a runtime, an endpoint, a model, and
credentials. Interactive chat and fleet dispatch can route through different
targets independently, so a strong orchestrator can direct cheap local muscle,
or the reverse.

| Runtime id | Serves |
| --- | --- |
| `llamacpp`, `llamacpp-anthropic`, `llamacpp-completion` | llama.cpp and llama-swap routers |
| `lmstudio` | LM Studio |
| `ollama-native` | Ollama |
| `vllm`, `sglang` | vLLM and SGLang |
| `lemonade`, `lemonade-anthropic` | Lemonade |
| `openai-compat`, `anthropic-compat` | Any OpenAI- or Anthropic-shaped endpoint |
| `openai`, `anthropic`, `google`, `groq`, `mistral`, `deepseek`, `openrouter`, `bedrock` | Cloud APIs |
| `alcf` | Argonne's Sophia and Metis gateways over Globus OAuth ([guide](docs/alcf-provider.md)) |
| `anthropic-max`, `openai-codex` | Your Claude Pro/Max or ChatGPT Plus/Pro subscription |
| `claude-sdk`, `claude-code`, `antigravity-code` | Claude Code and Google Antigravity as workers behind Clio's permission gate |

**One GPU with 24 GB or more?** Serve **Qwen3.8-27B** (the
`unsloth/Qwen3.8-27B-GGUF` quantizations) and point both the chat and fleet
targets at it. It is the model this release was hardened against on llama.cpp
and LM Studio: a 4-bit quantization at 131072 context fits in 24 GB with a
q8_0 KV cache, tool calls and reasoning parse cleanly on both runtimes, and
Clio's `thinkingLevel` drives the model's reasoning effort per request. Start
llama.cpp with `--jinja --reasoning on`; LM Studio needs nothing beyond loading
the model. Quantization and context-window details for this and other families
live in [docs/model-catalog.md](docs/model-catalog.md).

Scripting the same setup the wizard performs:

```bash
clio-coder configure --id local-lmstudio --runtime lmstudio \
  --url http://localhost:1234 --model your-model-id \
  --set-orchestrator --set-fleet-default
clio-coder targets --probe

clio-coder auth login anthropic-max     # or: openai-codex
clio-coder configure --id claude-sub --runtime anthropic-max --model claude-sonnet-5 --set-orchestrator
```

> [!NOTE]
> Connecting a Claude Pro/Max subscription over OAuth uses the same path as
> Claude Code. Using subscription credentials outside a vendor's first-party
> apps may not align with their terms of service. Enable at your own
> discretion.

The full reference, including fleet profiles, per-agent target bindings, and
keeping a small scout model resident beside your main model, is
[docs/configuration-and-targets.md](docs/configuration-and-targets.md).

## At the keyboard

Run `clio-coder` from the repository you want to work on. The session opens on a
one-line header that names where Clio is working, which route answers, and
whether project context is ready, and then the transcript owns the screen.
Tool calls render as live rows with their verdicts, successful edits render as
numbered diffs, and `!` runs a shell command in the same transcript.

| You want to | Type |
| --- | --- |
| Change model, target, thinking level, autonomy, or terminal options | `/settings`, `/model`, `/thinking` |
| See what is in the context window and what it costs | `/context`, `/cost` |
| Branch, revisit, or pick up a session | `/tree`, `/fork`, `/resume`, `/new` |
| Delegate to a fleet agent and watch it work | `/run coder "..."`, `/tasks`, `Alt+W` |
| Load a skill or bootstrap project context | `/skill <name>`, `/context init` |
| Save a self-contained HTML transcript | `/export` (an explicit `.md` path keeps Markdown) |
| Everything else | `/help` |

Enter while Clio is running steers the current turn; `Alt+Enter` queues a
follow-up; `Esc` cancels. Settings → Terminal offers an opt-in fullscreen mode
with a sticky composer beneath an independently scrollable transcript; regular
terminal scrollback is the default. The complete command and keybinding
reference is [docs/commands-and-modes.md](docs/commands-and-modes.md).

Outside the TUI, the same engine runs headless and speaks to editors:

```bash
clio-coder run "Summarize this repository layout and its entry points."   # one turn
clio-coder run "<task>" --json                                            # JSONL events for scripts
clio-coder run "<task>" --agent coder                                     # one fleet agent, with a receipt
clio-coder acp                                                            # Agent Client Protocol over stdio
```

## Safety you can read

One tool surface, one admission path. What changes is the autonomy level, set
in `/settings` or per run with `--autonomy`.

| Level | Behavior |
| --- | --- |
| `read-only` | Inspection only. Every mutation and execution is denied. |
| `suggest` | Mutations are proposed and parked for your approval. |
| `auto-edit` | File edits proceed; execution and dispatch still gate. |
| `full-auto` | Approved classes proceed unattended, still inside damage-control rules. |

Every notice names its mechanism so you always know who stopped a call:
`[safety-net]` for level-independent blocks, `[approval]` for parked calls,
`[autonomy]` for read-only denials, and `[middleware]` for hook diagnostics.
Workers can never exceed the orchestrator's authority; a dispatch can only
narrow it, and reviewers and judges always run read-only. Details:
[docs/safety-model.md](docs/safety-model.md).

## One machine or the whole cluster

Clio's orchestrator delegates to bounded workers. Declare a fleet and those
workers run on other machines over SSH while every guarantee holds: one
admission path, one autonomy matrix, one receipt chain. The implicit `local`
node is always present.

```yaml
fleet:
  nodes:
    - id: node-a
      host: node-a.example.net
      maxWorkers: 2
    - id: node-b
      host: node-b.example.net
      maxWorkers: 1
```

`clio-coder doctor` preflights every node, `clio-coder fleet list|run|status`
drives and observes work, and `clio-coder fleet drain|resume` closes or reopens
admission without interrupting running work. Nodes share the project
filesystem at the same absolute path, and a target URL resolves on the node the
worker runs on, so `localhost` means that node's own inference server. The
end-to-end walkthrough, including a recorded multi-node demo, is in
[docs/fleet-dispatch.md](docs/fleet-dispatch.md) and
[docs/fleet-demo-runbook.md](docs/fleet-demo-runbook.md).

## Teach it your project

**`CLIO-CODER.md`** is the project handbook Clio loads on every session.
`clio-coder context init` drafts one from your actual source tree and can adopt
existing `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor, and Copilot context
with provenance. It is yours to edit and version; Clio's own runtime state
stays in a gitignored `.clio-coder/`. A `CLIO-CODER.override.md` in a
subdirectory replaces inherited guidance for that subtree.

**The codewiki** from `clio-coder context index` is a structural map the
`code_nav` tool navigates, so a model finds a symbol without reading half the
repository into its window.

**Skills** are reusable `SKILL.md` guides the model loads on demand, discovered
from per-user and per-project roots including `.claude/skills` and
`.codex/skills`. The shipped [catalog](skills/README.md) pins content hashes so
an installed copy verifies against its audited source, and
`clio-coder skills eval <name>` runs a skill's executable evals instead of
trusting the prose.

**Task memory** keeps long runs from drifting: a rules-only tier with no model
calls watches tool and lifecycle hooks and surfaces advisory reminders at the
right boundaries, `/memory` inspects it, and durable lessons are reviewed with
`clio-coder memory list|propose|approve|reject|prune`. Design notes:
[docs/proactive-memory.md](docs/proactive-memory.md).

## Install

- Node.js `>=22.19.0` and npm
- Linux or macOS. Windows is best effort until a stable release.
- At least one model target from the table above

From npm, [Get started](#get-started) is the whole install. `clio-coder upgrade`
moves an existing install to the latest release; `--channel=beta` follows a
dist-tag instead.

From source, pinned to this release:

```bash
git clone --branch v0.3.2 https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
"$HOME/.local/bin/clio-coder" --version
```

`npm run install:local` builds the CLI, links it at
`${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}/clio-coder`, and initializes the home.
Put the `export PATH` line in your shell profile. If an older install is on your
`PATH`, `command -v clio-coder` shows which file the bare name reaches; the
installer warns when it finds one.

To remove it, preview first:

```bash
clio-coder uninstall --dry-run
clio-coder uninstall --remove-binary --force
```

Full lifecycle details, including `reset` and the upgrade path, are in
[docs/installation-and-lifecycle.md](docs/installation-and-lifecycle.md).

## Status

The current release is **v0.3.2**, installable from npm as
[`@iowarp/clio-coder`](https://www.npmjs.com/package/@iowarp/clio-coder) or
from source. Clio Coder is still experimental: we ship quickly, interfaces may
change between minor versions, and model-specific behavior varies by target, so
keep important repositories under version control and review what it proposes.
Release notes live in the [CHANGELOG](CHANGELOG.md); every release is gated by
the deterministic `npm run ci:release` suite.

### Troubleshooting

| Problem | Try this |
| --- | --- |
| `clio-coder: command not found` | Run `npm run install:local`, then `hash -r`; confirm `${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}` is on `PATH`. |
| No model target is available | Run `clio-coder configure`, then `clio-coder targets --probe`. |
| Local model does not respond | Confirm the server is running and the target URL is correct; `clio-coder targets` shows what Clio sees. |
| Cloud model auth fails | Check `clio-coder auth status <target>` and verify the API key or login flow. |
| A fleet node never gets work | Run `clio-coder doctor`; per-node preflight reports filesystem parity and target facts. |
| State appears corrupted | Run `clio-coder doctor`, then `clio-coder doctor --fix`. |

When filing an issue, include `clio-coder --version`, `node --version`,
`clio-coder doctor`, and `clio-coder targets`. Redact secrets, private prompts,
logs, and proprietary code. [docs/troubleshooting.md](docs/troubleshooting.md)
is keyed by exact user-facing messages.

---

# For agents

If you are an AI agent operating inside this repository or driving Clio as a
tool, start here.

**Orient from the index, not from a wide read.** `clio-coder context index`
builds a codewiki over the roughly 1,200 source and test files; use `code_nav`
in `entries`, `path`, or `symbol` mode first. The indexed entry points are
`src/cli/index.ts`, `src/domains/agents/index.ts`,
`src/domains/components/index.ts`, `src/domains/config/index.ts`,
`src/domains/context/bootstrap.ts`, `src/domains/context/index.ts`,
`src/domains/dispatch/index.ts`, and `src/domains/eval/index.ts`. Then read the
local `CLIO-CODER.md`; it carries the project-specific invariants and traps
that are not obvious from the source. `docs/` is source-aligned: when prose and
source disagree, trust source, tests, and `CHANGELOG.md`.

**The tool surface** is twenty tools in seven planes. Each plane is one policy
unit covering action class, size posture, result schema, and concurrency rule.

| Plane | Tools | Posture |
| --- | --- | --- |
| OBSERVE | `read`, `grep`, `find`, `ls`, `code_nav`, `context`, `credential_present` | Read class, parallel, bounded by a truncation envelope |
| MUTATE | `write`, `edit` | Write class, sequential, queued through the file-mutation queue |
| EXECUTE | `bash`, `git`, `verify` | Containment posture; `bash` is default-deny, `git` is read-only inspection |
| ORCHESTRATE | `dispatch`, `monitor`, `steer`, `tasks`, `ledger` | Dispatch class, sequential except read-only `monitor` |
| RETRIEVE | `web_fetch` | Network read, parallel |
| INTERACT | `ask_user` | Host-owned operator interview |
| ARTIFACT | `artifact` | Plans, reviews, and reports as durable artifacts |

Every observation carries a truncation envelope with offload paths and next
hints, so a large result is bounded rather than silently cut. Parameters and
payloads: [docs/tool-usage.md](docs/tool-usage.md).

**Dispatch** goes through one tool, one admission chain, and one autonomy
matrix. `task` runs one assignment; `tasks: [...]` fans out; `mode:
"sequential"` and `mode: "pipeline"` chain steps; `detach: true` returns ids to
collect later with `monitor` in `collect` mode; `review: {...}` adds a
read-only verifier gate; `mode: "compete"` runs two to four candidates in
scratch worktrees behind a read-only judge. Every dispatch carries a typed
`ExecutionRole` and answers a typed result contract; a cited line in a
`scout-report` must fall inside a span the run actually read. The built-in
fleet is `architect`, `coder`, `tester`, `verifier`, `debugger`, `documenter`,
`scout`, `researcher`, `provenance`, and `git-master`
([docs/built-in-agents.md](docs/built-in-agents.md)); pin an id from it, since
`agent: "auto"` is a fallback, not a router.

**Every run seals a receipt** covering routing intent, the resolved route,
worker attestation, priced cost, phase timing, tool activity, safety decisions,
and result conformance. `clio-coder evidence inspect` and `/view verify <runId>`
check them; `clio-coder trace` reads the same store.
[docs/observability.md](docs/observability.md) has the shapes.

```bash
clio-coder run "<task>" --json                 # one headless turn, JSONL events
clio-coder acp                                 # ACP v1 over stdio
clio-coder fleet run <contract>                # run a fleet DAG contract
clio-coder evidence build|inspect|list         # deterministic evidence artifacts
clio-coder eval validate|run|report|compare|gate
```

---

# For contributors

The fastest way in is to fix something you hit while using Clio on your own
research code. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, architecture
invariants, branch and commit conventions, and the review rubric; security
reports go through [SECURITY.md](SECURITY.md), not public issues.

```bash
npm ci
npm run dev          # tsup watch build
npm run ci           # typecheck, lint and hygiene, skills pin check, build, tests
npm run ci:release   # ci plus the dist and package audit that gates a release
```

| Check | Command |
| --- | --- |
| Types | `npm run typecheck` |
| Style and domain boundaries | `npm run lint` |
| One suite | `npm run test:file -- tests/contracts/<name>.test.ts` |
| Everything | `npm run test` |

Conventions worth knowing before your first PR: local imports end in `.js`,
tests use `node:test`, `any` needs a tracking issue, and compile-time
boundaries between domains are enforced by the hygiene lint rather than by
convention. Read [docs/architecture.md](docs/architecture.md) before adding a
cross-domain import. Live model validation (`npm run test:live`) and the
SWE-bench, SciCode, and Terminal-Bench harnesses under `benchmarks/` are
separate and opt-in, because no deterministic suite can promise that every
local model behaves identically.

## Documentation

The full set lives under [docs/](docs/README.md), and `clio-coder docs` serves it
locally with interactive blueprints. The pages people reach for most:

| Topic | Guide |
| --- | --- |
| Commands, slash commands, keybindings, operating posture | [commands-and-modes.md](docs/commands-and-modes.md) |
| Targets, local model configuration, fleet profiles, auth | [configuration-and-targets.md](docs/configuration-and-targets.md) |
| Model catalog, quantizations, context windows, quirks | [model-catalog.md](docs/model-catalog.md) |
| Safety posture, default-deny Bash, damage-control rules | [safety-model.md](docs/safety-model.md) |
| Multi-node fleet dispatch and the demo runbook | [fleet-dispatch.md](docs/fleet-dispatch.md), [fleet-demo-runbook.md](docs/fleet-demo-runbook.md) |
| Built-in agents and dispatch admission | [built-in-agents.md](docs/built-in-agents.md) |
| Context window, token accounting, compaction | [context-engine.md](docs/context-engine.md) |
| Sessions, the ledger, `/tree`, `/fork`, `/resume` | [session-lifecycle.md](docs/session-lifecycle.md) |
| Receipts, evidence, and `clio-coder trace` | [observability.md](docs/observability.md) |
| The twenty tools, parameter by parameter | [tool-usage.md](docs/tool-usage.md) |
| Exit codes, `--help`, and `--json` contracts | [exit-codes-and-output.md](docs/exit-codes-and-output.md) |
| Install, upgrade, reset, uninstall | [installation-and-lifecycle.md](docs/installation-and-lifecycle.md) |
| Adding a runtime or inference server | [provider-adapter-cookbook.md](docs/provider-adapter-cookbook.md) |
| Source layout and domain boundaries | [architecture.md](docs/architecture.md) |

## Heritage

Clio Coder is developed by the [Gnosis Research Center](https://grc.iit.edu)
at the [Illinois Institute of Technology](https://www.iit.edu) in collaboration
with the University of Utah. IOWarp and the CLIO architecture are funded by the
National Science Foundation under
[Award #2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318) for
2024 through 2029. Principal Investigator: Dr. Xian-He Sun. Co-Principal
Investigators: Dr. Anthony Kougkas, Dr. Jake Hochhalter, and Dr. Vivek
Srikumar.

Clio Coder is the interactive coding orchestrator in a larger ecosystem:
[clio-core](https://github.com/iowarp/clio-core) is the tiered data and context
storage layer, and [clio-kit](https://github.com/iowarp/clio-kit) is a suite of
[Model Context Protocol](https://modelcontextprotocol.io) servers exposing 150+
tools for scientific computing.

It is built on the **Pi Agent Framework** from
[Earendil Works](https://github.com/earendil-works)
([pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai),
[pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui), and
[pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)),
the **Anthropic Claude Agent SDK** for Claude Code worker runs, the **Agent
Client Protocol** for editor frontends, and **Globus Auth** for ALCF's inference
gateways. Subagents and prompt techniques are evaluated against
[SWE-bench](https://www.swebench.com) and SciCode, with structured execution
evidence matched against baselines to catch silent regressions.

---

<p align="center">
  Licensed under Apache-2.0. See <a href="LICENSE">LICENSE</a> and <a href="NOTICE">NOTICE</a>.<br />
  <sub>Built for the people who maintain the code that science runs on.</sub>
</p>
