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
  Terminal-first. Model-flexible. Agent-aware. Built for HPC and scientific-software developers who want AI assistance on real research code without giving up review, control, or auditability.
</p>

<p align="center">
  <a href="https://github.com/iowarp/clio-coder/releases"><img alt="version" src="https://img.shields.io/badge/version-0.2.2-00d4db?style=flat-square" /></a>
  <a href="#install-from-source"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-147366?style=flat-square" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-241131?style=flat-square" /></a>
  <a href="https://github.com/iowarp/clio-coder/actions"><img alt="ci" src="https://img.shields.io/badge/ci-deterministic-147366?style=flat-square" /></a>
  <a href="#npm-status"><img alt="install" src="https://img.shields.io/badge/npm-not%20published-lightgrey?style=flat-square" /></a>
  <a href="https://iowarp.ai"><img alt="IOWarp CLIO" src="https://img.shields.io/badge/IOWarp-CLIO-00d4db?style=flat-square" /></a>
</p>

---

## Status

Clio Coder is an **experimental alpha**. The current public release is
**v0.2.2**.

v0.2.2 is a source-checkout alpha patch for local model operators. It adds a
reliable local install/uninstall path, neutral first-run configuration examples,
ACP interop, curated skills, stronger skill activation, and recent harness
improvements for throughput telemetry, prompt-envelope reuse, bounded tool
results, and smaller-terminal dashboard controls.

It builds on the v0.2.0 community alpha foundations: durable sessions,
`CLIO.md` project context adoption, target-first runtime routing, fleet
dispatch, typed validation tools, receipts, and local-runtime support.

Expect sharp edges around first-run configuration, local runtime availability,
and model-specific behavior. This is ready for early users who can build from
source, run checks, and report failures with receipts and logs. It is not a
production-stable managed coding assistant.

## What It Does

Clio Coder runs inside real repositories as a supervised terminal harness. It
lets developers ask for inspection, plans, edits, reviews, validation, and
focused fleet-agent work while Clio gates tool access and records what happened.

Core surfaces:

| Surface | Purpose |
| --- | --- |
| Interactive TUI | Work with an assistant without leaving the shell. |
| Target-first configuration | Route chat and fleet dispatch through HTTP/native/pi-ai-backed targets. |
| Built-in agents | Dispatch `scout`, `planner`, `reviewer`, `implementer`, and other focused recipes. |
| Typed tools | Run common git, test, lint, build, package-script, and frontend validation paths without handing the model an unrestricted shell. |
| Receipts and audit logs | Track completed runs, token usage, costs, tool activity, safety decisions, and receipt integrity. |
| Project context | Use checked-in `CLIO.md` as the canonical project guide. |

Clio is built on top of pi-ai. Broad provider/model support comes from pi-ai
and from Clio's generic `openai-compat` and `anthropic-compat` targets; Clio
adds orchestration, local/native runtime ergonomics, target configuration,
fleet dispatch, safety, and receipts rather than mirroring every pi-ai provider
as a separate product surface.

Use it if you run local models such as Ollama, LM Studio, llama.cpp, vLLM, or
SGLang, or if you have ChatGPT Codex OAuth or cloud API keys and want
supervised repository work with auditable outputs.

## Install From Source

Requirements:

- Node.js `>=22.19.0`
- npm
- A model target, such as a local OpenAI-compatible gateway, Ollama, LM Studio,
  llama.cpp, vLLM, SGLang, ChatGPT Codex OAuth, or a cloud API.

Recommended alpha source install:

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
hash -r
clio --version
```

`npm run install:local` runs dependency/build checks and installs a deterministic
symlink at `${CLIO_BIN_DIR:-$HOME/.local/bin}/clio`. It warns if that bin dir is
not on `PATH`. If you edit TypeScript source, run `npm run build` again before
testing `clio`; the local symlink points at `dist/cli/index.js`. For a
reproducible release checkout after v0.2.2 is published, `main` and tag
`v0.2.2` should point at the same commit.

## npm Status

`@iowarp/clio-coder` is not published on npm for v0.2.2. Use the source install
path above unless a future release note explicitly announces registry
availability.

## Uninstall Local Source Install

Preview first, then remove the local symlink and Clio state:

```bash
npm run uninstall:local -- --dry-run
npm run uninstall:local -- --force
hash -r
```

To remove sessions/cache while keeping only the active `settings.yaml` and
`credentials.yaml` files, use:

```bash
npm run uninstall:local -- --force --keep-settings-auth
```

Use `--keep-state` for binary-only unlinking. The script refuses to remove a
`clio` symlink unless it points into the current checkout or an explicitly
accepted path.

## First Run

Start Clio Coder from the repository you want to work on:

```bash
cd /path/to/your/repo
clio doctor --fix
clio configure --list
```

Start one local runtime, then configure a single target with its runtime id and
wire model id. Example for LM Studio:

```bash
clio configure \
  --id local-lmstudio \
  --runtime lmstudio-native \
  --url http://localhost:1234 \
  --model your-model-id \
  --set-orchestrator \
  --set-fleet-default
clio targets use local-lmstudio
clio targets --probe
clio
```

Other common local runtime ids are `ollama-native`, `llamacpp`, `vllm`, and
`sglang`; use `your-model-id` from that runtime's model list. Add
`--context-window <tokens>`, `--max-tokens <tokens>`, or `--reasoning true` only
when you know those model-specific overrides.

Quick headless smoke after the target probes healthy:

```bash
clio run "Summarize this repository layout and identify the main entry points."
```

Inside the TUI, verify onboarding with:

```text
/targets
/agents
/skills
```

## Skills

Skills are reusable `SKILL.md` guides the model loads on demand. Clio discovers
runtime skills from per-user and per-project roots (including `.clio/skills` and
cross-harness layouts such as `.claude/skills` and `.codex/skills`), surfaces
them in a catalog, and loads a body on request through `read_skill`. Manage them
with `clio skills list | inspect | validate | create`.

This repository also ships a curated **skills marketplace** under
[skills/](skills/README.md): maintainer-approved skills that carry provenance
frontmatter (`registry-id`, `source-url`, `audit`). The first wave is
`context-prime` (orient at session start), `context-handoff` (brief the next
session), `clio-dev` (self-development boundary), and `clio-test` (the v0.2.2
test harness). The catalog is not a discovery root, so nothing auto-loads;
activate a skill explicitly:

```bash
skills/install.sh context-handoff   # link into .clio/skills (project scope)
clio skills list                    # confirm Clio sees it
```

See [skills/README.md](skills/README.md) for the catalog, install options, and
how to contribute a skill.

## Documentation

The README is only the release entry point. Detailed docs live under [docs/](docs/README.md).

| Need | Read |
| --- | --- |
| Commands, slash commands, operating posture, keybindings, dispatch, verification, and troubleshooting | [docs/commands-and-modes.md](docs/commands-and-modes.md) |
| Runtime targets, local model configuration, fleet profiles, and auth | [docs/configuration-and-targets.md](docs/configuration-and-targets.md) |
| Safety posture, default-deny Bash, project policy, and typed validation | [docs/safety-model.md](docs/safety-model.md) |
| Built-in agent recipes and dispatch admission | [docs/built-in-agents.md](docs/built-in-agents.md) |
| Prompt envelope reuse, provider tool delivery, and bounded tool results | [docs/prompt-envelope-and-tools.md](docs/prompt-envelope-and-tools.md) |
| Sessions, receipts, evidence, and memory | [docs/evidence-and-memory.md](docs/evidence-and-memory.md) |
| Extension packages and share archives | [docs/extensions-and-sharing.md](docs/extensions-and-sharing.md) |
| Source layout and boundary invariants | [docs/architecture.md](docs/architecture.md) |

## Release Verification

Deterministic maintainer gate:

```bash
npm run ci:release
```

This runs typecheck, Biome checks, build, contract/smoke/boundary tests, and
`check-dist` packaging verification. Live model validation is separate,
manual, and opt-in:

```bash
CLIO_LIVE_SMOKE=1 \
CLIO_LIVE_TARGET=openai-compat \
CLIO_LIVE_RUNTIME=openai-compat \
CLIO_LIVE_MODEL=your-model \
CLIO_LIVE_BASE_URL=http://localhost:8080/v1 \
npm run test:live
```

Manual v0.2.2 release-prep evidence covers deterministic CI commands, local
source install/uninstall smoke checks, interactive TUI checks, dispatch work,
destructive-delete refusal, and opt-in live model smoke. Treat live checks as
operator-run release evidence, not guarantees that every local model behaves the
same way.

## Local Model Performance Notes

llama.cpp and similar local backends often expose one prefix-cache slot. Clio keeps the compiled session prompt and provider tool schemas byte-stable so prompt prefixes can be reused across turns and across sessions when the backend slot still holds the same prefix.

Dispatch traffic and compaction can invalidate that slot. The next turn records `expectedColdReasons` and shows one dim notice. Session forensics report per-call cache verdicts as `hot`, `partial`, `cold`, or `small`:

```bash
node scripts/turn-report.mjs --session <id>
```

## Troubleshooting

| Problem | Try this |
| --- | --- |
| `clio: command not found` | Run `npm run install:local`, then `hash -r`; confirm `${CLIO_BIN_DIR:-$HOME/.local/bin}` is on `PATH`. |
| No model target is available | Run `clio configure`, then `clio targets --probe`. |
| Local model does not respond | Confirm the local runtime is running and the target URL is correct. |
| Cloud model auth fails | Check `clio auth status <target>` and verify the relevant API key or login flow. |
| Source changes do not appear | Re-run `npm run build`; the linked CLI points at `dist/`. |
| State appears corrupted | Run `clio doctor`; if needed, run `clio doctor --fix`. |

For issue reports, include:

```bash
clio --version
node --version
clio doctor
clio targets
```

Redact secrets, private prompts, logs, and proprietary code.

## Development

Contributor guidance lives in [CONTRIBUTING.md](CONTRIBUTING.md). The short
version:

```bash
npm ci
npm run ci
```

Use `npm run ci:release` before release artifacts. Do not imply production
stability, npm publication, or broad local-model guarantees without live proof.

## Lineage

Clio Coder is part of the IOWarp CLIO family.

- [clio-core](https://github.com/iowarp/clio-core): Chimaera-based context storage runtime.
- [clio-kit](https://github.com/iowarp/clio-kit): MCP servers for scientific data, including HDF5, Slurm, ParaView, Pandas, ArXiv, NetCDF, FITS, Zarr, and more.

Apache-2.0. See [LICENSE](LICENSE).
