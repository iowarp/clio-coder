<p align="center">
  <img src="../assets/clio-coder-logo-128.webp" alt="Clio Coder logo" width="96" height="96" />
</p>

# Clio Coder Documentation

These pages document the unreleased `v0.2.9` development version of Clio Coder, an open-source coding orchestrator within the [IOWarp](https://iowarp.ai) scientific computing platform, created by the [Gnosis Research Center](https://grc.iit.edu) at the [Illinois Institute of Technology](https://www.iit.edu). Until the v0.2.9 tag is cut, the supported evaluation path is a source checkout of `main`.

They are source-aligned guides: when prose and source disagree, prefer the
current source, tests, and `CHANGELOG.md`.

## Start Here

| Need | Guide |
| --- | --- |
| Commands, slash commands, operating posture, keybindings, dispatch, verification, and troubleshooting | [commands-and-modes.md](commands-and-modes.md) ([Interactive Blueprint](html/commands_blueprint.html)) |
| Context window resolution, per-model probe capabilities, token accounting, per-turn snapshots, compaction, and context priming | [context-engine.md](context-engine.md) ([Interactive Blueprint](html/context_blueprint.html)) |
| Runtime targets, local model configuration, fleet profiles, and auth | [configuration-and-targets.md](configuration-and-targets.md) ([Interactive Blueprint](html/configuration_blueprint.html)) |
| Every environment variable the runtime reads: guardrail overrides, directory layout, debug toggles, and internal plumbing | [environment-variables.md](environment-variables.md) ([Interactive Blueprint](html/environment_blueprint.html)) |
| Argonne ALCF Sophia/Metis inference targets over Globus OAuth | [alcf-provider.md](alcf-provider.md) ([Interactive Blueprint](html/alcf_blueprint.html)) |
| Installation, upgrade, reset, uninstallation, configuration folders, and permissions | [installation-and-lifecycle.md](installation-and-lifecycle.md) ([Interactive Blueprint](html/lifecycle_blueprint.html)) |
| Safety posture, default-deny Bash, project policy, damage-control rules, and typed validation | [safety-model.md](safety-model.md) ([Interactive Blueprint](html/safety_blueprint.html)) |
| Source layout, compile-time boundaries, domain loading, and runtime data flow | [architecture.md](architecture.md) ([Interactive Blueprint](html/architecture_blueprint.html)) |
| Prompt envelope reuse, provider tool delivery, and bounded tool results | [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md) ([Interactive Blueprint](html/tools_blueprint.html)) |
| In-depth reference for all 19 worker tools: parameters, typical payloads, and error examples | [tool-usage.md](tool-usage.md) ([Interactive Blueprint](html/tool_usage_blueprint.html)) |
| Developer guide to implementing custom model runtimes and inference server integrations | [provider-adapter-cookbook.md](provider-adapter-cookbook.md) ([Interactive Blueprint](html/provider_adapter_blueprint.html)) |
| Built-in agent recipes, discovery roots, frontmatter schema, and dispatch admission | [built-in-agents.md](built-in-agents.md) ([Interactive Blueprint](html/agents_blueprint.html)) |
| Artifact browsing, receipt verification, dispatch diagnostics, and observability routing | [observability.md](observability.md) ([Interactive Blueprint](html/observability_blueprint.html)) |
| Evidence directory structures, findings, and operator-approved memory retrieval | [evidence-and-memory.md](evidence-and-memory.md) ([Interactive Blueprint](html/memory_blueprint.html)) |
| Local YAML eval suites, reports, comparisons, and command evidence | [eval-runner.md](eval-runner.md) ([Interactive Blueprint](html/eval_blueprint.html)) |
| Prompt and skill resources, extension manifests, and portable share archives | [extensions-and-sharing.md](extensions-and-sharing.md) ([Interactive Blueprint](html/extensions_blueprint.html)) |
| Skills Hub marketplace discovery, cache behavior, install actions, and publishing flow | [skills-marketplace.md](skills-marketplace.md) ([Interactive Blueprint](html/skills_blueprint.html)) |
| Runtime model refresh, catalog sources, local/cloud model quirks, and benchmarking notes | [model-catalog.md](model-catalog.md) ([Interactive Blueprint](html/models_blueprint.html)) |
| Active component snapshots and the experimental middleware hook/effect contract | [middleware-and-components.md](middleware-and-components.md) ([Interactive Blueprint](html/middleware_blueprint.html)) |
| Advisory validation-contract patterns for scientific artifacts and HPC assumptions | [scientific-validation.md](scientific-validation.md) ([Interactive Blueprint](html/validation_blueprint.html)) |
| Falsifiable Change Manifest JSON templates, auditability, and `clio evolve` | [evolution.md](evolution.md) ([Interactive Blueprint](html/evolution_blueprint.html)) |
| Source-first docs workflow, mapping matrix, and alpha wording guidance | [documentation-guide.md](documentation-guide.md) ([Interactive Blueprint](html/documentation_blueprint.html)) |
| Interface layout, colors palette, Unicode character vocabulary, and drawing choreography | [tui-design.md](tui-design.md) ([Interactive Blueprint](html/tui_design_blueprint.html)) |
| NDJSON parent-child socket protocols, watchdog timers, and exit status mapping | [worker-dispatch-mechanics.md](worker-dispatch-mechanics.md) ([Interactive Blueprint](html/worker_dispatch_blueprint.html)) |
| Multi-node fleet dispatch: process-safe admission, attested workers, measured routing, activation, agent automation, topologies, and receipts | [fleet-dispatch.md](fleet-dispatch.md) ([Interactive Blueprint](html/fleet_dispatch_blueprint.html)) |
| Executable multi-node demo with reviewer gate and receipt provenance walkthrough | [fleet-demo-runbook.md](fleet-demo-runbook.md) |
| Proactive task memory architecture, session task bank, intervention rules, and handoff carrying | [proactive-memory.md](proactive-memory.md) ([Interactive Blueprint](html/memory_blueprint.html)) |
| Private context index determinism and target smoke matrices (Internal Reference) | [evals-internal.md](evals-internal.md) ([Interactive Blueprint](html/evals_internal_blueprint.html)) |
| Point-in-time inventory of legacy environment variables (Historical Appendix) | [config-knobs-audit.md](config-knobs-audit.md) ([Interactive Blueprint](html/config_knobs_audit_blueprint.html)) |

Every project Clio works in gets its context from a checked-in `CLIO.md`,
bootstrapped and maintained by `clio context init`. The root
[CLIO.md](../CLIO.md) of this repository is the maintained reference example
of the format.

## Developer Quick Start

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm run install:local
hash -r
clio --version
```

The local symlink executes `dist/cli/index.js`. If you edit TypeScript files
under `src/`, run `npm run build` again or keep `npm run dev` running.

## Release Notes

The release entry point is [../README.md](../README.md); detailed release
history lives in [../CHANGELOG.md](../CHANGELOG.md). For v0.2.9 the supported
install path is a source checkout through `npm run install:local`, the
deterministic release gate is `npm run ci:release`, live model smoke
validation is local/manual and opt-in through `npm run test:live` (add
`-- --delegation` for opencode/copilot checks), and the package
is not published to npm.

## Writing Documentation

Guidance for doc authors lives in
[documentation-guide.md](documentation-guide.md). The short version:

- State alpha status plainly; do not imply npm publication, production
  stability, or universal local-model behavior without current proof.
- Prefer command examples that are valid against
  `node dist/cli/index.js --help`.
- Keep the README short; detailed command explanations belong in these pages.
