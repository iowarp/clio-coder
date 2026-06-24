<p align="center">
  <img src="../assets/clio-coder-logo-128.webp" alt="Clio Coder logo" width="96" height="96" />
</p>

# Clio Coder Documentation

These pages document the in-development `v0.2.6` version of Clio Coder, an open-source coding orchestrator within the [IOWarp](https://iowarp.ai) scientific computing platform, created by the [Gnosis Research Center](https://grc.iit.edu) at the [Illinois Institute of Technology](https://www.iit.edu).

They are source-aligned guides: when prose and source disagree, prefer the
current source, tests, and `CHANGELOG.md`.

## Start Here

| Need | Guide |
| --- | --- |
| Commands, slash commands, operating posture, keybindings, dispatch, verification, and troubleshooting | [commands-and-modes.md](commands-and-modes.md) ([Interactive Blueprint](html/commands_blueprint.html)) |
| Context window resolution, per-model probe capabilities, token accounting, per-turn snapshots, compaction, and context priming | [context-engine.md](context-engine.md) ([Interactive Blueprint](html/context_blueprint.html)) |
| Runtime targets, local model configuration, fleet profiles, and auth | [configuration-and-targets.md](configuration-and-targets.md) ([Interactive Blueprint](html/configuration_blueprint.html)) |
| Argonne ALCF Sophia/Metis inference targets over Globus OAuth | [alcf-provider.md](alcf-provider.md) |
| Installation, upgrade, reset, uninstallation, configuration folders, and permissions | [installation-and-lifecycle.md](installation-and-lifecycle.md) ([Interactive Blueprint](html/lifecycle_blueprint.html)) |
| Safety posture, default-deny Bash, project policy, damage-control rules, and typed validation | [safety-model.md](safety-model.md) ([Interactive Blueprint](html/safety_blueprint.html)) |
| Source layout, compile-time boundaries, domain loading, and runtime data flow | [architecture.md](architecture.md) ([Interactive Blueprint](html/architecture_blueprint.html)) |
| Prompt envelope reuse, provider tool delivery, and bounded tool results | [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md) ([Interactive Blueprint](html/tools_blueprint.html)) |
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

Every project Clio works in gets its context from a checked-in `CLIO.md`,
bootstrapped and maintained by `clio context-init`. The root
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
history lives in [../CHANGELOG.md](../CHANGELOG.md). For v0.2.6 the supported
install path is a source checkout through `npm run install:local`, the
deterministic release gate is `npm run ci:release`, live model smoke
validation is manual and opt-in through `npm run test:live`, and the package
is not published to npm.

## Writing Documentation

Guidance for doc authors lives in
[documentation-guide.md](documentation-guide.md). The short version:

- State alpha status plainly; do not imply npm publication, production
  stability, or universal local-model behavior without current proof.
- Prefer command examples that are valid against
  `node dist/cli/index.js --help`.
- Keep the README short; detailed command explanations belong in these pages.
