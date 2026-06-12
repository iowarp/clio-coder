<p align="center">
  <img src="assets/clio-coder-logo-256.webp" alt="Clio Coder logo" width="128" height="128" />
</p>

<p align="center">
  <picture>
    <source srcset="assets/banner.webp" type="image/webp" />
    <img src="assets/banner.png" alt="Clio Coder, the coding agent in IOWarp's CLIO ecosystem of agentic science" width="100%" />
  </picture>
</p>

<h1 align="center">Clio Coder</h1>

<p align="center"><strong>The coding agent in IOWarp's CLIO ecosystem of agentic science.</strong></p>

<p align="center">
  Terminal-first. Model-flexible. Built for HPC and scientific-software developers who want
  AI assistance on real research code without giving up review, control, or auditability.
</p>

<p align="center">
  <a href="https://github.com/iowarp/clio-coder/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/tag/iowarp/clio-coder?sort=semver&label=release&color=00d4db&style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/iowarp/clio-coder/ci.yml?branch=main&label=ci&style=flat-square" /></a>
  <a href="#requirements"><img alt="Node >=22.19" src="https://img.shields.io/badge/node-%3E%3D22.19-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00d4db?style=flat-square" /></a>
</p>

---

Clio Coder is a supervised coding agent that runs inside your repository from
the terminal. You bring a model: a local runtime such as llama.cpp, Ollama,
LM Studio, vLLM, or SGLang, or a cloud API. Clio brings the harness: an
interactive TUI, typed tools instead of an unrestricted shell, a fleet of
focused agents, durable sessions, and receipts that record what actually
happened.

It is built for developers working on research software and HPC codebases who
want agentic help with inspection, planning, edits, reviews, and validation
while keeping every privileged action gated and auditable.

## Highlights

- **Local-first inference.** The harness is engineered for local models:
  byte-stable prompt prefixes that keep single-slot llama.cpp caches hot,
  bounded tool results, single-threshold compaction, and per-call timing and
  cache telemetry persisted in the session ledger.
- **Target-first model routing.** Configure named targets across local
  runtimes and cloud APIs, probe their health, and route interactive chat and
  fleet dispatch through different targets independently.
- **A supervised tool surface.** Typed git, test, lint, build, package-script,
  and frontend-validation tools replace an unrestricted shell. Bash is
  default-deny, governed by damage-control rules and per-project policy.
- **Built-in agent fleet.** Dispatch `scout`, `planner`, `reviewer`,
  `implementer`, `debugger`, and other focused recipes as bounded workers with
  explicit tool profiles and per-run receipts.
- **Receipts and audit logs.** Every run records token usage, cost, tool
  activity, safety decisions, and receipt integrity, so you can reconstruct
  what the agent did and why.
- **ACP interop.** `clio acp` serves the Agent Client Protocol over stdio for
  ACP frontends, and dispatch can delegate tasks to external ACP agents while
  Clio mediates permissions.
- **Project context and skills.** `clio init` bootstraps a checked-in
  `CLIO.md` as the canonical project guide, and reusable `SKILL.md` guides
  load on demand from per-user and per-project discovery roots, including
  cross-harness layouts.

## Status

Clio Coder is alpha software distributed from source. The current release is
**v0.2.2**. The `@iowarp/clio-coder` package is not yet published to npm;
install from a source checkout as described below. Interfaces may still move
between minor versions, and model-specific behavior varies by target. Release
history lives in the [CHANGELOG](CHANGELOG.md), and every release is gated by
the deterministic `npm run ci:release` suite.

## Requirements

- Node.js `>=22.19.0` and npm
- Linux or macOS (Windows is best effort until a stable release)
- A model target: a local OpenAI-compatible server, Ollama, LM Studio,
  llama.cpp, vLLM, SGLang, ChatGPT Codex OAuth, or a cloud API key

## Install

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
hash -r
clio --version
```

`npm run install:local` verifies dependencies, builds the CLI, and installs a
symlink at `${CLIO_BIN_DIR:-$HOME/.local/bin}/clio`. It warns if that
directory is not on your `PATH`. The symlink executes `dist/cli/index.js`, so
re-run `npm run build` after editing TypeScript sources.

To uninstall, preview first and then remove the symlink and local state:

```bash
npm run uninstall:local -- --dry-run
npm run uninstall:local -- --force
```

Add `--keep-settings-auth` to preserve `settings.yaml` and `credentials.yaml`,
or `--keep-state` to unlink the binary only. Full lifecycle details are in
[docs/installation-and-lifecycle.md](docs/installation-and-lifecycle.md).

## Quick Start

Run Clio from the repository you want to work on. Check your environment,
then configure one target against a running model server. The example below
uses LM Studio; other local runtime ids include `ollama-native`, `llamacpp`,
`vllm`, and `sglang`.

```bash
cd /path/to/your/repo
clio doctor --fix

clio configure \
  --id local-lmstudio \
  --runtime lmstudio-native \
  --url http://localhost:1234 \
  --model your-model-id \
  --set-orchestrator \
  --set-fleet-default

clio targets use local-lmstudio
clio targets --probe
```

Once the target probes healthy, try a headless turn, then start the TUI:

```bash
clio run "Summarize this repository layout and identify the main entry points."
clio
```

Inside the TUI, `/targets`, `/agents`, and `/skill` confirm what the session
can see. The full command and slash-command reference is in
[docs/commands-and-modes.md](docs/commands-and-modes.md), and target
configuration in depth is covered by
[docs/configuration-and-targets.md](docs/configuration-and-targets.md).

## Project Context: CLIO.md

Clio loads a checked-in `CLIO.md` as the canonical project guide on every
session. Run `clio init` in your repository to bootstrap one: the bootstrap
agent grounds it in your real source structure and can adopt existing
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor, and Copilot context with
provenance and conflict reporting.

This repository's own [CLIO.md](CLIO.md) is the maintained reference example
of the format: one identity paragraph, up to six verifiable conventions, up
to three build-enforced hard invariants, and a handful of dense custom
sections covering architecture boundaries, workflow traps, and artifact
policy.

## Skills

Skills are reusable `SKILL.md` guides the model loads on demand. Clio
discovers them from per-user and per-project roots, including `.clio/skills`
and cross-harness layouts such as `.claude/skills` and `.codex/skills`, and
loads bodies on request through `read_skill`. Manage them with
`clio skills list | inspect | validate | create`.

This repository also ships a curated skills catalog under
[skills/](skills/README.md): maintainer-reviewed skills with provenance
frontmatter. Nothing in the catalog auto-loads; activate a skill explicitly:

```bash
skills/install.sh context-handoff   # link into .clio/skills (project scope)
clio skills list                    # confirm Clio sees it
```

## Documentation

The README is the entry point; the full documentation set lives under
[docs/](docs/README.md).

| Topic | Guide |
| --- | --- |
| Commands, slash commands, keybindings, dispatch, troubleshooting | [commands-and-modes.md](docs/commands-and-modes.md) |
| Runtime targets, local model configuration, fleet profiles, auth | [configuration-and-targets.md](docs/configuration-and-targets.md) |
| Install, upgrade, reset, uninstall, state layout | [installation-and-lifecycle.md](docs/installation-and-lifecycle.md) |
| Autonomy levels, approvals, the safety net, project policy | [safety-model.md](docs/safety-model.md) |
| Context window resolution, compaction, token accounting | [context-engine.md](docs/context-engine.md) |
| Built-in agent recipes and dispatch admission | [built-in-agents.md](docs/built-in-agents.md) |
| Prompt envelope reuse, tool delivery, bounded tool results | [prompt-envelope-and-tools.md](docs/prompt-envelope-and-tools.md) |
| Sessions, receipts, evidence, memory | [evidence-and-memory.md](docs/evidence-and-memory.md) |
| Extension packages and share archives | [extensions-and-sharing.md](docs/extensions-and-sharing.md) |
| Source layout and boundary invariants | [architecture.md](docs/architecture.md) |

## Local Model Performance

llama.cpp and similar backends often expose a single prefix-cache slot. Clio
keeps the compiled session prompt and provider tool schemas byte-stable so
that slot can be reused across turns and sessions. When dispatch traffic or
compaction invalidates the slot, the next turn records the expected-cold
reasons and shows one dim notice. Per-call cache verdicts (`hot`, `partial`,
`cold`, `small`) are persisted in the session ledger and can be inspected
with:

```bash
node scripts/turn-report.mjs --session <id>
```

See [docs/context-engine.md](docs/context-engine.md) for how the context
engine measures and protects the prompt prefix.

## Release Verification

Every release is gated by a deterministic suite:

```bash
npm run ci:release
```

It runs typecheck, Biome checks, the production build, the contract, smoke,
and boundary test suites, and `check-dist` packaging verification. Live model
validation is separate, manual, and opt-in:

```bash
CLIO_LIVE_SMOKE=1 \
CLIO_LIVE_TARGET=openai-compat \
CLIO_LIVE_RUNTIME=openai-compat \
CLIO_LIVE_MODEL=your-model \
CLIO_LIVE_BASE_URL=http://localhost:8080/v1 \
npm run test:live
```

Treat live checks as operator-run release evidence, not a guarantee that every
local model behaves identically.

## Troubleshooting

| Problem | Try this |
| --- | --- |
| `clio: command not found` | Run `npm run install:local`, then `hash -r`; confirm `${CLIO_BIN_DIR:-$HOME/.local/bin}` is on `PATH`. |
| No model target is available | Run `clio configure`, then `clio targets --probe`. |
| Local model does not respond | Confirm the local runtime is running and the target URL is correct. |
| Cloud model auth fails | Check `clio auth status <target>` and verify the relevant API key or login flow. |
| Source changes do not appear | Re-run `npm run build`; the linked CLI points at `dist/`. |
| State appears corrupted | Run `clio doctor`; if needed, run `clio doctor --fix`. |

When filing an issue, include the output of:

```bash
clio --version
node --version
clio doctor
clio targets
```

Redact secrets, private prompts, logs, and proprietary code.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for
setup, architecture invariants, branch and commit conventions, and the review
rubric. The fast local gate is:

```bash
npm ci
npm run ci
```

Security reports go through the channels described in
[SECURITY.md](SECURITY.md), not public issues.

## Lineage

Clio Coder is part of the IOWarp CLIO family:

- [clio-core](https://github.com/iowarp/clio-core): Chimaera-based context
  storage runtime.
- [clio-kit](https://github.com/iowarp/clio-kit): MCP servers for scientific
  data, including HDF5, Slurm, ParaView, Pandas, ArXiv, NetCDF, FITS, and
  Zarr.

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
