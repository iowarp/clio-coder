<p align="center">
  <img src="../assets/clio-coder-logo-128.webp" alt="Clio Coder logo" width="96" height="96" />
</p>

# Clio Coder documentation

> **Visual blueprint:** The source checkout includes the complete
> [Clio Coder documentation visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/readme_blueprint.html).

This is the documentation map for Clio Coder. Start with the path closest to
what you are trying to do; the deeper references are here when you need exact
schemas, wire contracts, or architectural invariants.

The guides track the current source tree. Released behavior is fixed by the
corresponding Git tag and [changelog](../CHANGELOG.md). If prose and the checked
source disagree, treat source, schema validation, and contract tests as
authoritative—and please fix or report the documentation drift.

The reference is organized by purpose:

```text
docs/
├── guide/          Operator and user workflows
├── architecture/   Runtime contracts and design
├── process/        Development, validation, and release practice
├── history/        Dated records that are not current guidance
└── html/           Source-checkout visual blueprints
```

## Start here

| Goal | Guide |
| --- | --- |
| Install Clio and connect the first model | [Installation and Lifecycle](guide/installation-and-lifecycle.md) → [Configuration and Targets](guide/configuration-and-targets.md) |
| Learn the interactive session and CLI | [Commands and Modes](guide/commands-and-modes.md) |
| Understand what Clio may read, change, or execute | [Safety Model](architecture/safety-model.md) |
| Diagnose a problem by its exact message | [Troubleshooting](guide/troubleshooting.md) |

A minimal first run is:

```bash
npm install -g @iowarp/clio-coder
clio-coder configure
cd /path/to/your/project
clio-coder
```

Use `clio-coder --help` for the installed command surface and `/help` inside an
interactive session. `clio-coder doctor` is a read-only installation check;
`doctor --fix` performs only the repairs it reports.

## Using Clio day to day

| Topic | Guide |
| --- | --- |
| Targets, providers, auth, settings v2, routing, and fleet profiles | [Configuration and Targets](guide/configuration-and-targets.md) |
| Every settings key, environment variable, flag, and project-file key with its default and precedence | [Configuration Reference](guide/configuration-reference.md) |
| Runtime discovery, model capabilities, local overlays, and field notes | [Model Catalog](architecture/model-catalog.md) |
| Argonne ALCF Sophia and Metis targets over Globus OAuth | [ALCF Provider](architecture/alcf-provider.md) |
| Project handbooks, context windows, accounting, compaction, and indexing | [Context Engine](architecture/context-engine.md) |
| Non-destructive working-set eviction, markers, and recall | [Context Working Set](architecture/context-working-set.md) |
| Session ledgers, branches, checkpoints, resume, and recovery | [Session Lifecycle](architecture/session-lifecycle.md) |
| Proactive task memory, interventions, and handoffs | [Proactive Memory](guide/proactive-memory.md) |
| Skills discovery, marketplace safety, installation, and publishing | [Skills Marketplace](guide/skills-marketplace.md) |
| Agents, prompts, extensions, and portable share archives | [Extensions and Sharing](guide/extensions-and-sharing.md) |
| Private resource catalogs and synchronization | [Resource Library](guide/resource-library.md) |
| TUI layout, responsive behavior, colors, and interaction rules | [TUI Design](architecture/tui-design.md) |
| Terminal panes beside a session and the files pane: install, keys, settings, doctor, troubleshooting | [Panes and the Files Pane](guide/panes-and-files.md) |

## Safety, evidence, and reproducibility

| Topic | Guide |
| --- | --- |
| Autonomy, default-deny execution, project policy, and damage-control rules | [Safety Model](architecture/safety-model.md) |
| Receipts, run inspection, costs, and observability routing | [Observability](architecture/observability.md) |
| Durable evidence bundles, findings, and reviewed memory | [Evidence and Memory](architecture/evidence-and-memory.md) |
| SQLite trace mirror, schemas, cursors, and rebuildability | [Trace Store](architecture/trace-store.md) |
| Where generated files live and who should read them | [Artifact Placement](architecture/artifact-placement.md) |
| Evidence-aware Git role trailers and managed-hook safety | [Git Commit Provenance](process/git-commit-provenance.md) |
| Advisory scientific validation contracts and HPC assumptions | [Scientific Validation](process/scientific-validation.md) |
| Versioned artifact schemas and migration policy | [Artifact Versions](architecture/artifact-versions.md) |

Receipts establish what Clio observed and did. They do not replace domain
validation, reference data, or human scientific judgment.

## Delegation and fleets

| Topic | Guide |
| --- | --- |
| Built-in worker recipes, discovery, frontmatter, and admission | [Built-in Agents](guide/built-in-agents.md) |
| Local and multi-node fleet execution, placement, gates, and receipts | [Fleet Dispatch](guide/fleet-dispatch.md) |
| An executable multi-node walkthrough with a reviewer gate | [Fleet Demo Runbook](process/fleet-demo-runbook.md) |
| Capacity leases, heartbeats, locks, and node drain control | [Capacity and Scheduling](architecture/capacity-and-scheduling.md) |
| Worker process protocol, watchdogs, steering, and exit mapping | [Worker Dispatch Mechanics](architecture/worker-dispatch-mechanics.md) |
| Typed dispatch intent and compatibility boundaries | [Dispatch Typed Intent](architecture/dispatch-typed-intent.md) |
| Why dispatch remains one domain and where its seams actually are | [Dispatch Architecture Rationale](architecture/dispatch-architecture-rationale.md) |

## Automation and integration

| Topic | Guide |
| --- | --- |
| Agent Client Protocol server, stdio transport, and permission mediation | [ACP](architecture/acp.md) |
| Prompt-envelope reuse, provider tool delivery, and bounded results | [Prompt Envelope and Tools](architecture/prompt-envelope-and-tools.md) |
| All built-in worker tools, arguments, outputs, and error examples | [Tool Usage](guide/tool-usage.md) |
| Implementing a runtime or inference-server adapter | [Provider Adapter Cookbook](architecture/provider-adapter-cookbook.md) |
| Middleware hooks, effects, budgets, and component snapshots | [Middleware and Components](architecture/middleware-and-components.md) |
| Process exit codes, stdout/stderr rules, JSONL, and `--help` contracts | [Exit Codes and Output](guide/exit-codes-and-output.md) |
| Environment overrides, directory controls, and debug toggles | [Environment Variables](guide/environment-variables.md) |

## Evaluation and measurement

| Topic | Guide |
| --- | --- |
| Local Suite v2 files, artifacts, reports, comparisons, and gates | [Eval Runner](process/eval-runner.md) |
| Private suite handling and measurement design | [Internal Evals](process/evals-internal.md) |
| Correct render, startup, import-graph, and streaming measurements | [Performance Methodology](process/performance-methodology.md) |
| Falsifiable change manifests and `clio-coder evolve` | [Evolution](process/evolution.md) |

Reviewable reference suites ship under [`evals/`](../evals/). They are explicit
operator measurements, not hidden CI steps. Private prompts, credentials,
endpoints, raw campaign artifacts, and proprietary datasets belong outside the
repository.

## Architecture and contributing

| Topic | Guide |
| --- | --- |
| Source layout, compile-time boundaries, domain loading, and runtime flow | [Architecture](architecture/architecture.md) |
| Pi framework boundary and Clio-owned policy | [Pi Boundary](architecture/pi-boundary.md) |
| Documentation style and source-alignment workflow | [Documentation Guide](process/documentation-guide.md) |
| Source-to-guide ownership map | [Documentation Coverage](process/documentation-coverage.md) |
| Issue-driven development and release workflow | [Development Pipeline](process/development-pipeline.md) |
| Clock, duration, timestamp, and ordering conventions | [Time Conventions](architecture/time-conventions.md) |
| Core terms mapped to source concepts | [Glossary](guide/glossary.md) |

The [configuration-knob audit](history/config-knobs-audit.md) is a dated historical
inventory, not the current settings reference. The
[v0.4.1 release-cut checklist](history/release-cut-checklist.md) is retained as release
engineering history and must not be reused unchanged for a future release.

## Developer quick start

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
npm ci
npm run build
node dist/cli/index.js --help
```

For a persistent local command:

```bash
npm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
clio-coder --version
```

Use `npm run dev` for a watch build. Before handing back a change, run the
focused test while iterating and `npm run ci` for the deterministic repository
gate. Maintainers use `npm run ci:release` to add the distribution and package
audit.

## Project context in a source checkout

Projects can keep human-owned guidance in `CLIO-CODER.md`, generated with
`clio-coder context init`. This repository gitignores its own generated copy so
local dogfooding instructions do not collide with public documentation. If the
file exists in your checkout, read it before making changes; if it does not,
the architecture guide and `CONTRIBUTING.md` are the public starting points.

## Interactive blueprints

Every Markdown page has a dedicated visual blueprint under `docs/html/`, and
the separate `docs/html/index.html` landing page mirrors this documentation
tree. Blueprint links use the public repository so they still work when a guide
is read from the npm package. From a source checkout, serve the same files
locally with:

```bash
clio-coder docs
```

The Markdown pages are the portable reference and ship with the npm package.
The HTML blueprints are development aids and are not required for the runtime.

## Writing documentation

Follow [Documentation Guide](process/documentation-guide.md). In particular:

- Verify commands against the built binary rather than copying an old example.
- Use current, canonical settings paths; describe legacy names only in a
  clearly marked migration or historical section.
- Separate deterministic contracts from model-dependent observations.
- Put release chronology in the [CHANGELOG](../CHANGELOG.md), not in the
  product README or an evergreen task guide.
- Link to the detailed contract instead of duplicating a large schema in
  several places.
