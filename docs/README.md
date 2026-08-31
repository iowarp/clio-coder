<p align="center">
  <img src="../assets/clio-coder-logo-128.webp" alt="Clio Coder logo" width="96" height="96" />
</p>

# Clio Coder Documentation

These pages document `v0.3.7` of Clio Coder, an open-source coding orchestrator within the [IOWarp](https://iowarp.ai) scientific computing platform, created by the [Gnosis Research Center](https://grc.iit.edu) at the [Illinois Institute of Technology](https://www.iit.edu).

They are source-aligned guides: when prose and source disagree, prefer the
current source, tests, and `CHANGELOG.md`.

## Start Here

| Need | Guide |
| --- | --- |
| Commands, slash commands, operating posture, keybindings, dispatch, verification, and troubleshooting | [commands-and-modes.md](commands-and-modes.md) ([Interactive Blueprint](html/commands_blueprint.html)) |
| Context window resolution, per-model probe capabilities, token accounting, per-turn snapshots, compaction, and context priming | [context-engine.md](context-engine.md) ([Interactive Blueprint](html/context_blueprint.html)) |
| Non-destructive working-set eviction, markers, eviction policies, recall by ref, and the `contextEviction` / `contextRecall` records | [context-working-set.md](context-working-set.md) |
| Runtime targets, local model configuration, fleet profiles, and auth | [configuration-and-targets.md](configuration-and-targets.md) ([Interactive Blueprint](html/configuration_blueprint.html)) |
| Every environment variable the runtime reads: guardrail overrides, directory layout, debug toggles, and internal plumbing | [environment-variables.md](environment-variables.md) ([Interactive Blueprint](html/environment_blueprint.html)) |
| Argonne ALCF Sophia/Metis inference targets over Globus OAuth | [alcf-provider.md](alcf-provider.md) ([Interactive Blueprint](html/alcf_blueprint.html)) |
| Installation, upgrade, reset, uninstallation, configuration folders, and permissions | [installation-and-lifecycle.md](installation-and-lifecycle.md) ([Interactive Blueprint](html/lifecycle_blueprint.html)) |
| Safety posture, default-deny Bash, project policy, damage-control rules, and typed validation | [safety-model.md](safety-model.md) ([Interactive Blueprint](html/safety_blueprint.html)) |
| Source layout, compile-time boundaries, domain loading, and runtime data flow | [architecture.md](architecture.md) ([Interactive Blueprint](html/architecture_blueprint.html)) |
| Why the dispatch domain is not split, which invariants cross the obvious seams, and why direct subpath imports are permitted | [dispatch-architecture-rationale.md](dispatch-architecture-rationale.md) ([Interactive Blueprint](html/dispatch_rationale_blueprint.html)) |
| Typed dispatch intent: the producer and persisted-contract compatibility tables, refusal reason codes, and the legacy-inference retirement criterion | [dispatch-typed-intent.md](dispatch-typed-intent.md) |
| Prompt envelope reuse, provider tool delivery, and bounded tool results | [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md) ([Interactive Blueprints: prompt_envelope](html/prompt_envelope_blueprint.html), [tools](html/tools_blueprint.html)) |
| In-depth reference for all 20 worker tools: parameters, typical payloads, and error examples | [tool-usage.md](tool-usage.md) ([Interactive Blueprint](html/tool_usage_blueprint.html)) |
| Developer guide to implementing custom model runtimes and inference server integrations | [provider-adapter-cookbook.md](provider-adapter-cookbook.md) ([Interactive Blueprint](html/provider_adapter_blueprint.html)) |
| Built-in agent recipes, discovery roots, frontmatter schema, and dispatch admission | [built-in-agents.md](built-in-agents.md) ([Interactive Blueprint](html/agents_blueprint.html)) |
| Artifact browsing, receipt verification, dispatch diagnostics, and observability routing | [observability.md](observability.md) ([Interactive Blueprint](html/observability_blueprint.html)) |
| Evidence-aware Git commit role trailers, managed-hook safety, and how platforms render the identity | [git-commit-provenance.md](git-commit-provenance.md) |
| Where every generated file lands: the working tree, `.clio-coder/`, and the XDG dirs, by audience | [artifact-placement.md](artifact-placement.md) ([Interactive Blueprint](html/artifact_placement_blueprint.html)) |
| Evidence directory structures, findings, and operator-approved memory retrieval | [evidence-and-memory.md](evidence-and-memory.md) ([Interactive Blueprint](html/memory_blueprint.html)) |
| Local YAML eval suites, reports, comparisons, and command evidence | [eval-runner.md](eval-runner.md) ([Interactive Blueprint](html/eval_blueprint.html)) |
| Prompt and skill resources, extension manifests, and portable share archives | [extensions-and-sharing.md](extensions-and-sharing.md) ([Interactive Blueprint](html/extensions_blueprint.html)) |
| Skills Hub marketplace discovery, install actions, and publishing flow | [skills-marketplace.md](skills-marketplace.md) ([Interactive Blueprint](html/skills_blueprint.html)) |
| Runtime model refresh, catalog sources, local/cloud model quirks, and benchmarking notes | [model-catalog.md](model-catalog.md) ([Interactive Blueprint](html/models_blueprint.html)) |
| Active component snapshots and the experimental middleware hook/effect contract | [middleware-and-components.md](middleware-and-components.md) ([Interactive Blueprint](html/middleware_blueprint.html)) |
| Advisory validation-contract patterns for scientific artifacts and HPC assumptions | [scientific-validation.md](scientific-validation.md) ([Interactive Blueprint](html/validation_blueprint.html)) |
| Falsifiable Change Manifest JSON templates, auditability, and `clio-coder evolve` | [evolution.md](evolution.md) ([Interactive Blueprint](html/evolution_blueprint.html)) |
| Source-first docs workflow, mapping matrix, and alpha wording guidance | [documentation-guide.md](documentation-guide.md) ([Interactive Blueprint](html/documentation_blueprint.html)) |
| Typed resource catalogs, private synchronization, installation roots, and library CLI | [resource-library.md](resource-library.md) |
| Interface layout, colors palette, Unicode character vocabulary, and drawing choreography | [tui-design.md](tui-design.md) ([Interactive Blueprint](html/tui_design_blueprint.html)) |
| NDJSON parent-child socket protocols, watchdog timers, and exit status mapping | [worker-dispatch-mechanics.md](worker-dispatch-mechanics.md) ([Interactive Blueprint](html/worker_dispatch_blueprint.html)) |
| Multi-node fleet dispatch: process-safe admission, attested workers, measured routing, activation, agent automation, topologies, and receipts | [fleet-dispatch.md](fleet-dispatch.md) ([Interactive Blueprint](html/fleet_dispatch_blueprint.html)) |
| Multi-process capacity leases, heartbeat TTLs, cross-process locks, and cluster drain controls | [capacity-and-scheduling.md](capacity-and-scheduling.md) ([Interactive Blueprint](html/capacity_scheduling_blueprint.html)) |
| Executable multi-node demo with reviewer gate and receipt provenance walkthrough | [fleet-demo-runbook.md](fleet-demo-runbook.md) |
| Session lifecycle, on-disk ledger format v4, `/tree` active-path lineage, `/fork`, `/resume`, checkpoints, and recovery | [session-lifecycle.md](session-lifecycle.md) ([Interactive Blueprint](html/session_lifecycle_blueprint.html)) |
| Agent Client Protocol (ACP) server over stdio, tool mediation, non-stall permissions, and error taxonomy | [acp.md](acp.md) ([Interactive Blueprint](html/acp_blueprint.html)) |
| Version registry and migration policies for all 9 serialized artifact schemas | [artifact-versions.md](artifact-versions.md) ([Interactive Blueprint](html/artifact_versions_blueprint.html)) |
| Process exit code taxonomy, `--help` standard, machine-readable JSON streaming, and headless output contracts | [exit-codes-and-output.md](exit-codes-and-output.md) ([Interactive Blueprint](html/exit_codes_blueprint.html)) |
| Actionable error remediation and diagnostics keyed by exact user-facing messages | [troubleshooting.md](troubleshooting.md) ([Interactive Blueprint](html/troubleshooting_blueprint.html)) |
| Canonical definitions of 45 core architectural concepts mapped to `src/` types | [glossary.md](glossary.md) ([Interactive Blueprint](html/glossary_blueprint.html)) |
| Complete source-to-documentation mapping matrix and subsystem coverage status | [documentation-coverage.md](documentation-coverage.md) |
| Issue-driven development lifecycle: file-ticket through release, label taxonomy, and dogfooding setup | [development-pipeline.md](development-pipeline.md) |
| Proactive task memory architecture, session task bank, intervention rules, and handoff carrying | [proactive-memory.md](proactive-memory.md) ([Interactive Blueprint](html/memory_blueprint.html)) |
| WAL SQLite trace mirror database schema, rowid cursor queries, rebuildability, and CLI trace subcommands | [trace-store.md](trace-store.md) ([Interactive Blueprint](html/trace_blueprint.html)) |
| Private context index determinism and target smoke matrices | [evals-internal.md](evals-internal.md) ([Blueprint](html/evals_internal_blueprint.html)) |
| Point-in-time inventory of legacy environment variables (Historical Appendix) | [config-knobs-audit.md](config-knobs-audit.md) ([Interactive Blueprint](html/config_knobs_audit_blueprint.html)) |
| Clock and timestamp conventions: durations, instants, ordering, and formatting | [time-conventions.md](time-conventions.md) ([Interactive Blueprint](html/time_conventions_blueprint.html)) |
| Correct render, PTY, startup, compile-cache, and import-graph measurement endpoints and the 0.3.3 baseline | [performance-methodology.md](performance-methodology.md) |
| Pi SDK boundary: upstream primitives, attribution, and Clio-owned product policies | [pi-boundary.md](pi-boundary.md) ([Interactive Blueprint](html/pi_boundary_blueprint.html)) |

Every project Clio works in gets its context from a local `CLIO-CODER.md`,
bootstrapped and maintained by `clio-coder context init`. It's human-owned and
versioned by default; this repo's own root `CLIO-CODER.md` is the exception,
gitignored here for dogfooding so this checkout's copy doesn't collide with
Clio's own committed docs. Run `clio-coder context init` in this checkout to
generate one for Clio's own source.

## Developer Quick Start

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
hash -r
clio-coder --version
```

The local symlink executes `dist/cli/index.js`. If you edit TypeScript files
under `src/`, run `npm run build` again or keep `npm run dev` running.

## Release Notes

The release entry point is [../README.md](../README.md); detailed release
history lives in [../CHANGELOG.md](../CHANGELOG.md). For v0.3.7 the supported
install paths are `npm install -g @iowarp/clio-coder` and a source checkout
through `npm run install:local`, the deterministic release gate is
`npm run ci:release`, and live model smoke validation is local/manual and
opt-in through `npm run live:smoke -- --target <id>` (add `--delegation`
for opencode/copilot checks).

## Writing Documentation

Guidance for doc authors lives in
[documentation-guide.md](documentation-guide.md). The short version:

- State alpha status plainly; do not imply npm publication, production
  stability, or universal local-model behavior without current proof.
- Prefer command examples that are valid against
  `node dist/cli/index.js --help`.
- Keep the README short; detailed command explanations belong in these pages.
