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

Clio Coder is an open-source terminal coding agent built with scientific and
high-performance computing software in mind. It is comfortable in the places
where research code actually lives: simulation kernels, numerical libraries,
data pipelines, mixed-language repositories, remote machines, and build or
test cycles that cannot be replaced by a toy example.

You choose the model and where it runs. Clio can use a local server on your own
GPU, a lab gateway, a cloud API, a supported subscription, or different targets
for interactive work and delegated jobs. Around that model it provides project
context, bounded tools, worker agents, durable sessions, safety controls, and
evidence you can inspect after the work is done.

CLIO stands for Context Layer for Input/Output. Clio Coder is the interactive
coding agent in IOWarp's ecosystem of agentic science, developed by the Gnosis
Research Center at Illinois Tech and named for the Greek muse of history.

## Get started

```bash
npm install -g @iowarp/clio-coder
clio-coder configure
cd /path/to/your/project
clio-coder
```

Clio requires Node.js `>=22.19.0`. The configuration wizard helps you choose a
provider or local inference server, verifies the connection, and saves the
target. Starting `clio-coder` with no usable target opens the same setup flow.

In your first session, describe what you want in plain language. Type `/help`
for the command palette, `/settings` to change the active model or operating
posture, and `/quit` when you are done. If anything about the installation
looks wrong, `clio-coder doctor` performs a read-only health check.

> [!NOTE]
> Add `--omit=optional` to the npm install to skip the Claude Agent SDK's large
> optional binary. Only the `claude-sdk` worker runtime needs it. See
> [Optional dependencies](docs/guide/installation-and-lifecycle.md#optional-dependency-the-claude-agent-sdk).

| If you are… | Continue with… |
| --- | --- |
| Trying Clio on a project | [A first session](#a-first-session) and [Choose where models run](#choose-where-models-run) |
| Responsible for sensitive or expensive work | [Safety and evidence](#safety-and-evidence) |
| Bringing Clio to a workstation or cluster | [Project context](#project-context-that-stays-with-the-project) and [Delegation](#delegate-with-bounds) |
| An agent entering this repository | [For agents working on Clio Coder](#for-agents-working-on-clio-coder) |
| Planning to contribute | [For contributors](#for-contributors) |

## Built for real research software

Clio is not limited to scientific repositories, but research software shapes
its priorities:

- **Bring your own inference.** Run locally with llama.cpp, LM Studio, Ollama,
  vLLM, SGLang, or Lemonade; connect a compatible gateway or cloud provider;
  or use supported ChatGPT and Claude subscription routes. Chat and worker
  fleets can use different targets.
- **Understand before changing.** A project handbook and structural code index
  give the model durable orientation without pouring the whole repository into
  every prompt. Context use, compaction, and recall remain visible.
- **Delegate focused work.** Built-in worker recipes receive explicit tools,
  limits, scopes, and result contracts. Fleet contracts can add review gates,
  resumable steps, and placement across machines over SSH.
- **Keep authority with the operator.** Read-only, suggest, auto-edit, and
  full-auto modes all pass through the same policy boundary. Bash is
  default-deny, and project rules can narrow access further.
- **Leave evidence, not just prose.** Runs record tool activity, model usage,
  routing, safety decisions, timing, and result conformance in receipts and
  durable ledgers that can be inspected later.
- **Fit into existing tools.** Use the interactive terminal, one-shot headless
  commands, JSONL event streams, or the Agent Client Protocol for editor hosts.

The goal is not to make a model infallible. It is to make useful work easier to
direct, easier to constrain, and easier to verify.

## A first session

Run Clio from the repository you want it to work on:

```bash
cd /path/to/your/project
clio-coder
```

The header shows the workspace, active route, and project-context status. Tool
calls appear as they run, edits render as diffs, and the footer keeps context
and activity visible without taking over the terminal.

| You want to… | Use… |
| --- | --- |
| Change the chat model, fleet route, autonomy, or interface | `/settings` |
| Inspect context use or cost | `/context`, `/cost` |
| Reference a workspace file | Type `@` and choose a path |
| Run a shell command whose result may enter model context | `! command` |
| Run a private shell command that is never sent to the model | `!! command` |
| Ask a side question without changing the main session | `/btw <question>` |
| Request a read-only second opinion | `/oracle <question>` |
| Delegate a focused task | `/run coder "..."` |
| Inspect delegated work | `/tasks` or `Alt+W` |
| Branch or resume a conversation | `/tree`, `/fork`, `/resume`, `/new` |
| Carry current state into a fresh session | `/handoff <goal>` |
| Browse agents, prompts, fleets, extensions, and skills | `/resources` |
| Save a self-contained transcript | `/export` |

Pressing Enter while Clio is working steers the active turn; `Alt+Enter` queues
a follow-up; `Esc` cancels. Pasted or multiline text beginning with `!` or `!!`
is treated as prompt text, so a pasted command does not execute unexpectedly.
Private `!!` command and output bytes remain visible in your transcript but are
excluded from model replay, compaction, and context accounting.

The complete interactive and CLI reference is
[Commands and Modes](docs/guide/commands-and-modes.md).

## Choose where models run

Clio stores each model connection as a named **target**: runtime, endpoint,
model, credentials, and any verified capability overrides. Interactive chat,
proactive memory, fleet defaults, and individual worker profiles can route
independently. A LiteLLM target keeps the gateway in charge of physical routing,
authentication, and backend residency; distinct model routes can share one URL.
Set `context.memory.target` and `context.memory.model` to opt into a dedicated
memory model. Unset memory roles remain rules-only; a configured route can fall
back to active chat when unavailable and request capacity permits.
`context.compaction.model` selects a dedicated summary model; leaving it unset
uses active chat. An invalid explicit compaction model fails visibly.

| Target family | Supported routes |
| --- | --- |
| Local inference | llama.cpp, LM Studio, Ollama, vLLM, SGLang, Lemonade |
| Compatible endpoints | OpenAI-compatible and Anthropic-compatible servers; LiteLLM gateways |
| Cloud APIs | OpenAI, Anthropic, Google, Groq, Mistral, DeepSeek, OpenRouter, Amazon Bedrock |
| Institutional gateways | Argonne ALCF Sophia and Metis over Globus OAuth |
| Subscriptions | ChatGPT Plus/Pro through `openai-codex`; Claude Pro/Max through `anthropic-max` |
| Worker integrations | Claude SDK, Claude Code, experimental Google Antigravity delegation, and configured ACP agents |

The interactive wizard is the easiest path:

```bash
clio-coder configure
clio-coder targets --probe
```

The same setup can be scripted. The model id must match what the server
advertises unless you deliberately pass `--force`:

```bash
clio-coder configure \
  --id local-lmstudio \
  --runtime lmstudio \
  --url http://127.0.0.1:1234 \
  --model your-model-id \
  --set-orchestrator \
  --set-fleet-default

clio-coder targets use local-lmstudio
clio-coder targets --probe
```

Local hardware, quantization, context windows, tool calling, and reasoning
behavior vary substantially by model and serving runtime. Clio records what it
can probe, but it does not turn one successful configuration into a universal
claim. Start with the measured field notes in the
[Model Catalog](docs/architecture/model-catalog.md), then keep the serving configuration with
your own results.

> [!NOTE]
> Subscription OAuth routes use the vendors' existing coding-agent credential
> paths. Whether a subscription may be used outside a vendor's first-party
> application depends on that vendor's current terms. Enable those routes at
> your discretion.

The full target, auth, profile, and routing reference is
[Configuration and Targets](docs/guide/configuration-and-targets.md). The ALCF route
has a separate [setup guide](docs/architecture/alcf-provider.md).

## Project context that stays with the project

Clio uses several layers of context, each with a different job:

- **`CLIO-CODER.md`** is the human-owned project handbook loaded for each
  session. `clio-coder context init` can draft it from the repository and adopt
  existing `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor, or Copilot guidance
  with provenance. You can edit and version it like any other project file.
- **The codewiki** is a structural index produced by
  `clio-coder context index`. It lets `code_nav` locate files and symbols
  without broad, expensive reads.
- **The working set** keeps durable tool results in the session ledger while
  controlling which bodies remain in the model window. Evicted content can be
  recalled by reference; history is not silently rewritten.
- **Skills** are focused `SKILL.md` procedures loaded when needed. The shipped
  catalog pins content hashes, and `clio-coder skills eval <name>` can run a
  skill's executable checks.
- **Task memory** surfaces bounded reminders during long work and keeps durable
  lessons behind explicit review and approval.

Start with:

```bash
clio-coder context init
clio-coder context
```

Project-generated runtime state lives under the gitignored `.clio-coder/`
directory. See [Context Engine](docs/architecture/context-engine.md),
[Working Set](docs/architecture/context-working-set.md), and
[Proactive Memory](docs/guide/proactive-memory.md) for the detailed contracts.

The local skills marketplace may offer a matching shipped skill during a
request. Every promotion install requires an explicit bound operator answer,
including in full-auto. Promotion installs retain their catalog source gate,
and installation does not activate the skill. Active
project and user skill trees are operator-owned: main and worker tool admissions
refuse direct and recognized shell mutations. Draft skill changes outside those
roots, then use the operator's installation or update workflow. This bounded
command inspection does not confine arbitrary programs or dynamic shell paths.
Manual installs remain available for a source you deliberately choose. See
[Skills Marketplace](docs/guide/skills-marketplace.md).

For a repository architecture map, run `clio-coder context index` followed by
`clio-coder context map`. The latter writes a deterministic JSON seed from the
index's directory areas and imports. The operator-installed `archify` remote
skill validates and delivers the interactive diagram; Clio ships its wrapper
and pinned install metadata, while the renderer comes from upstream. Source
citations require a pinned GitHub revision. Validation can still report
composition warnings that need human edits.

## Delegate with bounds

Clio's orchestrator can send focused assignments to worker agents instead of
stretching one conversation across every task. A worker receives a declared
role, tool profile, scope, budget, target, and typed result contract. Reviewers
and judges remain read-only.

On one machine:

```text
/run tester "Run the focused tests for the parser and explain any failure."
/tasks
```

For repeatable workflows, fleet contracts describe steps, dependencies,
writers, and review gates:

```bash
clio-coder fleet new validation-pass --from build-test
clio-coder fleet validate validation-pass
clio-coder fleet graph validation-pass
clio-coder fleet run validation-pass
```

The same worker protocol can run over SSH on declared nodes. Placement and
capacity are explicit, a node can be drained without killing active work, and
completed steps can be resumed from durable evidence. Shared workspaces must
appear at the same absolute path on every node, and `localhost` always means
the node where that worker runs.

Read [Fleet Dispatch](docs/guide/fleet-dispatch.md) for configuration and invariants,
or follow the [Fleet Demo Runbook](docs/process/fleet-demo-runbook.md) for an end-to-end
example.

## Safety and evidence

Clio has one tool-admission path and four operator-visible autonomy levels:

| Level | What Clio may do |
| --- | --- |
| `read-only` | Inspect only; execution and mutation are denied. |
| `suggest` | Prepare mutations and wait for approval. |
| `auto-edit` | Apply file edits; execution and dispatch still pass their gates. |
| `full-auto` | Run approved action classes unattended, still inside safety-net and project-policy limits. |

The safety net applies at every level. Bash starts from a default-deny rule
pack; reads and observations are bounded; writes are serialized; protected
paths and project policy can narrow authority further. A worker can never gain
more authority than the process that dispatched it.

Every completed run seals a receipt over the facts Clio actually observed:
routing, model usage, priced cost where known, tool calls, safety decisions,
worker identity, timing, and result conformance. Inspect the same evidence from
the CLI or TUI:

```bash
clio-coder evidence list
clio-coder evidence inspect <evidence-id>
clio-coder trace phases <run-id>
clio-coder trace tail <run-id>
```

`clio-coder usage report` preserves known failed-compaction spending and labels
missing coverage. Adapter prices are estimates, and numeric spending ceilings
bound the known sum; absent telemetry does not prove a call was free. Eval's
provider-health checks are opt-in and separate from task success. Partial or
mixed session/stdout evidence and inherited fork history are not reconciled;
full reconciliation is deferred to v0.4.5 or later, and 0.4.3 does not add an
automatic cost-comparison rejection. See the
[Eval Runner](docs/process/eval-runner.md#token-accounting--provenance) for source
and timing limits.

Evidence helps you audit a run; it does not prove that generated code is
scientifically correct. Domain validation, reference results, and human review
remain part of the job. The detailed boundaries are in
[Safety Model](docs/architecture/safety-model.md), [Observability](docs/architecture/observability.md),
and [Scientific Validation](docs/process/scientific-validation.md).

## Headless and editor use

The interactive TUI and automation surfaces use the same engine:

```bash
clio-coder run "Summarize this repository's entry points."
clio-coder run "<task>" --json
clio-coder run "<task>" --agent coder
clio-coder acp
```

Text mode reserves stdout for the final answer. `--json` emits JSONL events for
scripts, and `acp` serves Clio over stdio to Agent Client Protocol hosts. Exit
codes and output guarantees are documented in
[Exit Codes and Output](docs/guide/exit-codes-and-output.md) and
[ACP](docs/architecture/acp.md).

## Settings and local state

User configuration is a strict `version: 2` YAML document organized into seven
durable areas: `chat`, `fleet`, `targets`, `context`, `safety`, `interface`, and
`integrations`. The same names are accepted as `/settings` deep links. Use the
Settings Center for ordinary changes; use the YAML inventory when you need a
reviewable lab or fleet configuration.

`clio-coder upgrade` migrates older settings before strict readers load them,
writes the result atomically, and keeps the original `settings.yaml.v1.bak`.
Conflicting old and new paths stop the migration instead of guessing.

Experimental pane, dock, and files-pane integrations are opt-in and off by default;
Clio does not start or download them unless you explicitly enable
`interface.panes`.

Use `clio-coder paths --json` to locate configuration, durable data, state, and
cache on the current machine. See the complete
[Settings Inventory](docs/guide/configuration-and-targets.md#settings-inventory) and
[Artifact Placement](docs/architecture/artifact-placement.md).

## Install

Requirements:

- Node.js `>=22.19.0` and npm
- Linux or macOS; Windows support is currently best effort
- At least one local, institutional, subscription, or cloud model target

### Install from npm

```bash
npm install -g @iowarp/clio-coder
clio-coder configure
clio-coder --version
```

### Install from source

From source, pinned to this version:

```bash
git clone --branch v0.4.3 https://github.com/iowarp/clio-coder.git
cd clio-coder
npm ci
npm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
"$HOME/.local/bin/clio-coder" --version
```

`npm run install:local` builds and links the launcher at
`${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}/clio-coder`. Run
`command -v clio-coder` to see which installation the bare command reaches;
your shell may otherwise keep resolving an older launcher earlier on `PATH`.
Clone the default branch instead only when you deliberately want the current
development tree.

Upgrade and diagnose without deleting state:

```bash
clio-coder upgrade
clio-coder doctor
clio-coder doctor --fix
```

To remove it, preview first:

```bash
clio-coder uninstall --dry-run
clio-coder uninstall --remove-binary --force
```

The full directory, permission, reset, migration, and uninstall behavior is in
[Installation and Lifecycle](docs/guide/installation-and-lifecycle.md).

## Project status

The latest release is available from npm as
[`@iowarp/clio-coder`](https://www.npmjs.com/package/@iowarp/clio-coder) and
from [GitHub Releases](https://github.com/iowarp/clio-coder/releases/latest).
The exact release history belongs in the [CHANGELOG](CHANGELOG.md).

Clio Coder is still experimental. Interfaces may change between minor
versions, and model behavior varies by target and serving configuration. Keep
important work under version control, review proposed changes, and treat
model-dependent results as measurements rather than promises.

### Troubleshooting

| Problem | First check |
| --- | --- |
| `clio-coder: command not found` | Run `command -v clio-coder`; make sure the npm global bin or `${CLIO_CODER_BIN_DIR:-$HOME/.local/bin}` is on `PATH`, then run `hash -r`. |
| No usable model target | Run `clio-coder configure`, then `clio-coder targets --probe`. |
| A local server does not answer | Verify the server process, URL, advertised model id, and `clio-coder targets` health row. |
| Cloud or subscription authentication fails | Run `clio-coder auth status <target-or-runtime>` and repeat the appropriate login flow. |
| A fleet node receives no work | Run `clio-coder doctor`; inspect node preflight, shared path, target reachability, and drain status. |
| Local state appears damaged | Run read-only `clio-coder doctor` first; use `doctor --fix` only for the repairs it offers. |

When reporting a problem, include `clio-coder --version`, `node --version`,
`clio-coder doctor`, and `clio-coder targets`. Redact credentials, private
prompts, proprietary code, and sensitive logs. The
[Troubleshooting Guide](docs/guide/troubleshooting.md) is keyed to user-facing errors.

## For agents working on Clio Coder

If you are an AI agent entering this repository, orient narrowly before making
changes:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md), then the guide for the subsystem you
   will touch in the [documentation index](docs/README.md). If a local
   `CLIO-CODER.md` exists, read it for checkout-specific instructions.
2. Start at the owning entry point. The main source roots are `src/cli/`,
   `src/core/`, `src/domains/`, `src/engine/`, `src/entry/`,
   `src/interactive/`, `src/tools/`, and `src/worker/`.
3. Use `rg` and focused reads. Do not infer current behavior from release notes
   or a similarly named legacy path.
4. Treat source, schema validation, and contract tests as authoritative when a
   document disagrees. Fix the document in the same change.
5. Run the narrowest relevant test while iterating, then the repository gate
   before handing work back.

Useful orientation:

| Concern | Start here |
| --- | --- |
| Source layout and domain boundaries | [Architecture](docs/architecture/architecture.md) |
| CLI and slash-command contracts | [Commands and Modes](docs/guide/commands-and-modes.md) |
| Tool schemas and bounded results | [Tool Usage](docs/guide/tool-usage.md) |
| Dispatch admission and worker mechanics | [Fleet Dispatch](docs/guide/fleet-dispatch.md), [Worker Dispatch](docs/architecture/worker-dispatch-mechanics.md) |
| Configuration schema and target resolution | [Configuration and Targets](docs/guide/configuration-and-targets.md) |
| Sessions, context, and persistence | [Session Lifecycle](docs/architecture/session-lifecycle.md), [Context Engine](docs/architecture/context-engine.md) |
| Safety and evidence | [Safety Model](docs/architecture/safety-model.md), [Observability](docs/architecture/observability.md) |

## For contributors

The most valuable contributions often begin with a real obstacle in your own
research or software work. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup,
architecture boundaries, commit conventions, and review expectations. Report
security issues through [SECURITY.md](SECURITY.md), not a public issue.

```bash
npm ci
npm run dev          # rebuild on source changes
npm run ci           # types, hygiene, build, deterministic tests
npm run ci:release   # CI plus distribution and package audit
```

| Check | Command |
| --- | --- |
| Types | `npm run typecheck` |
| Formatting, lint, and architecture hygiene | `npm run lint` |
| One contract file | `npm run test:file -- tests/contracts/<name>.test.ts` |
| Deterministic suite | `npm test` |
| Distribution package | `node scripts/check-release.mjs` |

Local imports end in `.js`, tests use `node:test`, and compile-time domain
boundaries are enforced by repository hygiene checks. Live target measurements
and the reference suites under `evals/` are explicit operator runs; they are
not hidden inside deterministic CI.

## Documentation

The [documentation index](docs/README.md) groups guides for users, operators,
researchers, and contributors. From a source checkout, `clio-coder docs` serves
the interactive blueprints locally. Frequently used pages:

| Topic | Guide |
| --- | --- |
| Install, upgrade, reset, uninstall | [Installation and Lifecycle](docs/guide/installation-and-lifecycle.md) |
| Targets, auth, settings, fleet profiles | [Configuration and Targets](docs/guide/configuration-and-targets.md) |
| Commands, keybindings, and modes | [Commands and Modes](docs/guide/commands-and-modes.md) |
| Project context and context windows | [Context Engine](docs/architecture/context-engine.md) |
| Safety rules and autonomy | [Safety Model](docs/architecture/safety-model.md) |
| Fleet and multi-node execution | [Fleet Dispatch](docs/guide/fleet-dispatch.md) |
| Receipts, traces, and evidence | [Observability](docs/architecture/observability.md) |
| Exact CLI output contracts | [Exit Codes and Output](docs/guide/exit-codes-and-output.md) |

## Heritage

Clio Coder is developed by the
[Gnosis Research Center](https://grc.iit.edu) at the
[Illinois Institute of Technology](https://www.iit.edu) in collaboration with
the University of Utah. IOWarp and the CLIO architecture are funded by the
National Science Foundation under
[Award #2411318](https://www.nsf.gov/awardsearch/showAward?AWD_ID=2411318) for
2024 through 2029. Principal Investigator: Dr. Xian-He Sun. Co-Principal
Investigators: Dr. Anthony Kougkas, Dr. Jake Hochhalter, and Dr. Vivek
Srikumar.

Clio Coder is one part of a larger ecosystem:
[clio-core](https://github.com/iowarp/clio-core) is the tiered data and context
storage layer, and [clio-kit](https://github.com/iowarp/clio-kit) provides
[Model Context Protocol](https://modelcontextprotocol.io) servers for
scientific data and computing tools.

It builds on the **Pi Agent Framework** from
[Earendil Works](https://github.com/earendil-works), the **Anthropic Claude
Agent SDK** for supported Claude worker runs, the **Agent Client Protocol** for
editor frontends, and **Globus Auth** for ALCF inference gateways. The repository
also ships a local eval engine and reviewable reference suites under `evals/`
for reproducible, operator-run measurements.

---

<p align="center">
  Licensed under Apache-2.0. See <a href="LICENSE">LICENSE</a> and <a href="NOTICE">NOTICE</a>.<br />
  <sub>Built for the people who maintain the code that science runs on.</sub>
</p>
