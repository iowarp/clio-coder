# Clio Coder Documentation

Clio Coder is an experimental community alpha. These docs describe the current
`v0.2.1` source-build release for early adopters, including local harness
telemetry, prompt-envelope reuse, bounded tool outputs, headless validation
fixes, and smaller-terminal TUI controls.

These pages are source-aligned guides, not production-stability promises. When
docs drift, prefer the current source, tests, `CHANGELOG.md`, and release
receipts over older prose.

## Start Here

| Need | Guide |
| --- | --- |
| Commands, slash commands, modes, keybindings, dispatch, verification, and troubleshooting | [commands-and-modes.md](commands-and-modes.md) |
| Runtime targets, local model configuration, fleet profiles, and auth | [configuration-and-targets.md](configuration-and-targets.md) |
| Safety modes, default-deny Bash, project policy, damage-control rules, and typed validation | [safety-model.md](safety-model.md) |
| Source layout, compile-time boundaries, domain loading, and runtime data flow | [architecture.md](architecture.md) |
| Prompt envelopes, provider tool contracts, active tool palettes, and bounded tool results | [prompt-envelope-and-tools.md](prompt-envelope-and-tools.md) |
| Built-in agent recipes, discovery roots, frontmatter schema, and dispatch admission | [built-in-agents.md](built-in-agents.md) |
| Evidence directory structures, findings, and operator-approved memory retrieval | [evidence-and-memory.md](evidence-and-memory.md) |
| Local YAML eval suites, reports, comparisons, and command evidence | [eval-runner.md](eval-runner.md) |
| Prompt and skill resources, extension manifests, and portable share archives | [extensions-and-sharing.md](extensions-and-sharing.md) |
| Runtime model refresh, catalog sources, local/cloud model quirks, and benchmarking notes | [model-catalog.md](model-catalog.md) |
| Active component snapshots and the experimental middleware hook/effect contract | [middleware-and-components.md](middleware-and-components.md) |
| Advisory validation-contract patterns for scientific artifacts and HPC assumptions | [scientific-validation.md](scientific-validation.md) |
| Falsifiable Change Manifest JSON templates, auditability, and `clio evolve` | [evolution.md](evolution.md) |
| Source-first docs workflow, mapping matrix, and alpha wording guidance | [documentation-guide.md](documentation-guide.md) |

## Developer Quick Start

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm ci
npm run build
npm link
clio --version
```

The linked CLI executes from `dist/`. If you edit TypeScript files under
`src/`, run `npm run build` again or keep `npm run dev` running.

## Current Release Notes

The public release entry point is [../README.md](../README.md), and detailed
release history lives in [../CHANGELOG.md](../CHANGELOG.md).

For v0.2.1:

- source checkout is the supported install path;
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
