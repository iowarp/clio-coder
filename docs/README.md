<p align="center">
  <img src="../assets/clio-coder-logo-128.webp" alt="Clio Coder logo" width="96" height="96" />
</p>

# Clio Coder Documentation

Clio Coder is an experimental community alpha. These docs describe the current
`v0.2.2` source-build release for early adopters, including reliable local
install/uninstall scripts, ACP interop, curated skills, local harness telemetry,
prompt-envelope reuse, bounded tool outputs, and headless validation fixes.

These pages are source-aligned guides, not production-stability promises. When
docs drift, prefer the current source, tests, `CHANGELOG.md`, and release
receipts over older prose.

## Start Here

| Need | Guide |
| --- | --- |
| Commands, slash commands, modes, keybindings, dispatch, verification, and troubleshooting | [commands-and-modes.md](commands-and-modes.md) ([Interactive Blueprint](html/commands_blueprint.html)) |
| Runtime targets, local model configuration, fleet profiles, and auth | [configuration-and-targets.md](configuration-and-targets.md) ([Interactive Blueprint](html/configuration_blueprint.html)) |
| Installation, upgrade, reset, uninstallation, configuration folders, and permissions | [installation-and-lifecycle.md](installation-and-lifecycle.md) ([Interactive Blueprint](html/lifecycle_blueprint.html)) |
| Safety modes, default-deny Bash, project policy, damage-control rules, and typed validation | [safety-model.md](safety-model.md) ([Interactive Blueprint](html/safety_blueprint.html)) |
| Source layout, compile-time boundaries, domain loading, and runtime data flow | [architecture.md](architecture.md) ([Interactive Blueprint](html/architecture_blueprint.html)) |
| Prompt envelopes, provider tool contracts, active tool palettes, and bounded tool results | [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md) ([Interactive Blueprint](html/tools_blueprint.html)) |
| Built-in agent recipes, discovery roots, frontmatter schema, and dispatch admission | [built-in-agents.md](built-in-agents.md) ([Interactive Blueprint](html/agents_blueprint.html)) |
| Evidence directory structures, findings, and operator-approved memory retrieval | [evidence-and-memory.md](evidence-and-memory.md) ([Interactive Blueprint](html/memory_blueprint.html)) |
| Local YAML eval suites, reports, comparisons, and command evidence | [eval-runner.md](eval-runner.md) ([Interactive Blueprint](html/eval_blueprint.html)) |
| Prompt and skill resources, extension manifests, and portable share archives | [extensions-and-sharing.md](extensions-and-sharing.md) ([Interactive Blueprint](html/extensions_blueprint.html)) |
| Runtime model refresh, catalog sources, local/cloud model quirks, and benchmarking notes | [model-catalog.md](model-catalog.md) ([Interactive Blueprint](html/models_blueprint.html)) |
| Active component snapshots and the experimental middleware hook/effect contract | [middleware-and-components.md](middleware-and-components.md) ([Interactive Blueprint](html/middleware_blueprint.html)) |
| Advisory validation-contract patterns for scientific artifacts and HPC assumptions | [scientific-validation.md](scientific-validation.md) ([Interactive Blueprint](html/validation_blueprint.html)) |
| Falsifiable Change Manifest JSON templates, auditability, and `clio evolve` | [evolution.md](evolution.md) ([Interactive Blueprint](html/evolution_blueprint.html)) |
| Source-first docs workflow, mapping matrix, and alpha wording guidance | [documentation-guide.md](documentation-guide.md) ([Interactive Blueprint](html/documentation_blueprint.html)) |

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

## Current Release Notes

The public release entry point is [../README.md](../README.md), and detailed
release history lives in [../CHANGELOG.md](../CHANGELOG.md).

For v0.2.2:

- source checkout is the supported install path through `npm run install:local`;
- npm registry publication is not part of this release;
- deterministic release verification is `npm run ci:release`;
- live model smoke validation is manual and opt-in through `npm run test:live`;
- local model behavior can vary by runtime, model family, context budget, and
  server configuration.

## Documentation Rules

- Keep alpha and experimental wording explicit.
- Do not imply npm publication, production stability, managed upgrades, or
  universal local-model behavior without current proof.
- Prefer command examples that are valid against `node dist/cli/index.js --help`.
- Keep the README short and move detailed command explanations into docs.
