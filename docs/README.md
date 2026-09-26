<p align="center">
  <img src="../assets/clio-coder-logo-128.webp" alt="Clio Coder logo" width="96" height="96" />
</p>

# Clio Coder documentation

Guides and architecture references for **Clio Coder**. Start with the
workflow you need, then use the architecture pages for schemas, runtime flow,
and implementation boundaries.

```text
docs/
├── README.md        Documentation map
├── guide/           Configuration and operator workflows
├── architecture/    Runtime architecture and contracts
└── wiki/            Generated development reference, v0.1
```

The installed application reads the authored Markdown directly; the website
serves a release-linked snapshot. The [GitHub Wiki](https://github.com/iowarp/clio-coder/wiki)
is a developing source reference with independent v0.1 versioning. Use the
architecture guides and current source for implementation decisions.

## Start here

| Goal | Guide |
| --- | --- |
| Install Clio and connect the first model | [Installation and Lifecycle](guide/installation-and-lifecycle.md) → [Configuration and Targets](guide/configuration-and-targets.md) |
| Learn the interactive session and CLI | [Commands and Modes](guide/commands-and-modes.md) |
| Understand what Clio may read, change, or execute | [Safety Model](architecture/safety-model.md) |
| Diagnose a problem by its exact message | [Troubleshooting](guide/troubleshooting.md) |
| Check an install, its targets, and the HPC toolchain | [Doctor](guide/doctor.md) |
| Submit, poll, and cancel Slurm jobs through the clio-kit MCP server | [Slurm](guide/slurm.md) |

A minimal first run needs Node.js 22.19 or newer and a model to talk to: a
local app such as Ollama or LM Studio, a lab gateway, an AI subscription, or a
cloud API. Guided setup starts from those recognizable choices, fills in Clio's
internal connection name, checks the endpoint when possible, and offers the
models it can discover. The endpoint shortcut is available for operators who
already know a server URL.

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
| Default settings keys, layering, and source pointers for CLI, environment, and project schemas | [Configuration Reference](guide/configuration-reference.md) |
| Runtime discovery, model capabilities, local overlays, and field notes | [Model Catalog](architecture/model-catalog.md) |
| Argonne ALCF Sophia and Metis targets over Globus OAuth | [ALCF Provider](architecture/alcf-provider.md) |
| Project handbooks, context windows, accounting, compaction, and indexing | [Context Engine](architecture/context-engine.md) |
| Codemap, bounded orientation, current project evidence, and artifact compatibility | [Project Context](architecture/project-context.md) |
| Choose compaction and recover interrupted handoffs | [Context Continuity](guide/context-continuity.md) |
| Non-destructive working-set eviction, markers, and recall | [Context Working Set](architecture/context-working-set.md) |
| Session ledgers, branches, checkpoints, resume, and recovery | [Session Lifecycle](architecture/session-lifecycle.md) |
| Proactive task memory, interventions, and handoffs | [Proactive Memory](guide/proactive-memory.md) |
| Skills discovery, marketplace safety, installation, and publishing | [Skills Marketplace](guide/skills-marketplace.md) |
| Agents, prompts, extensions, and portable share archives | [Extensions and Sharing](guide/extensions-and-sharing.md) |
| Private resource catalogs and synchronization | [Resource Library](guide/resource-library.md) |
| Portable domain bundles, library pins, and lifecycle | [Plugins](guide/plugins.md) |
| Package manifests and component references | [Authoring Plugins](guide/authoring-plugins.md) |
| Executable harness capabilities | [Harness Extensions](guide/harness-extensions.md) |
| TUI layout, responsive behavior, colors, and interaction rules | [TUI Design](architecture/tui-design.md) |
| Terminal panes beside a session and the files pane: install, keys, settings, doctor, troubleshooting | [Panes and the Files Pane](guide/panes-and-files.md) |

## Safety, evidence, and reproducibility

| Topic | Guide |
| --- | --- |
| Autonomy, default-deny execution, project policy, and damage-control rules | [Safety Model](architecture/safety-model.md) |
| Required checks by changed path, fresh verification snapshots, and completion findings | [Project Quality Policies](guide/quality-policy.md) |
| Receipts, run inspection, costs, and observability routing | [Observability](architecture/observability.md) |
| Durable evidence bundles, findings, and reviewed memory | [Evidence and Memory](architecture/evidence-and-memory.md) |
| SQLite trace mirror, schemas, cursors, and rebuildability | [Trace Store](architecture/trace-store.md) |
| Where generated files live and who should read them | [Artifact Placement](architecture/artifact-placement.md) |
| Versioned artifact schemas and migration policy | [Artifact Versions](architecture/artifact-versions.md) |

Receipts link execution observations to tool activity and results. Project checks,
reference data, and review define the acceptance criteria for a change.

## Delegation and fleets

| Topic | Guide |
| --- | --- |
| Built-in worker recipes, discovery, frontmatter, and admission | [Built-in Agents](guide/built-in-agents.md) |
| Local and multi-node fleet execution, placement, gates, and receipts | [Fleet Dispatch](guide/fleet-dispatch.md) |
| Capacity leases, heartbeats, locks, and node drain control | [Capacity and Scheduling](architecture/capacity-and-scheduling.md) |
| Worker process protocol, watchdogs, steering, and exit mapping | [Worker Dispatch Mechanics](architecture/worker-dispatch-mechanics.md) |
| Worker context inheritance, fork, and splice modes | [Worker Context](architecture/worker-context.md) |
| Typed dispatch intent and compatibility boundaries | [Dispatch Typed Intent](architecture/dispatch-typed-intent.md) |
| Why dispatch remains one domain and where its seams actually are | [Dispatch Architecture Rationale](architecture/dispatch-architecture-rationale.md) |

## Automation and integration

| Topic | Guide |
| --- | --- |
| Agent Client Protocol server, stdio transport, and permission mediation | [ACP](architecture/acp.md) |
| Prompt-envelope reuse, provider tool delivery, and bounded results | [Prompt Envelope and Tools](architecture/prompt-envelope-and-tools.md) |
| Built-in tool contracts, operating boundaries, and core workflows | [Tool Usage](guide/tool-usage.md) |
| Implementing a runtime or inference-server adapter | [Provider Adapter Cookbook](architecture/provider-adapter-cookbook.md) |
| Delegate to installed coding agents through their supported ACP, headless CLI, or pane modes; inspect and adopt their resources | [Coding Agent Interoperability](guide/interop.md) |
| Middleware hooks, effects, budgets, and component snapshots | [Middleware and Components](architecture/middleware-and-components.md) |
| Process exit codes, stdout/stderr rules, JSONL, and `--help` contracts | [Exit Codes and Output](guide/exit-codes-and-output.md) |
| Environment overrides, directory controls, and debug toggles | [Environment Variables](guide/environment-variables.md) |

## Architecture and contributing

| Topic | Guide |
| --- | --- |
| Source layout, compile-time boundaries, domain loading, and runtime flow | [Architecture](architecture/architecture.md) |
| Package kinds, catalog resolution, integrity, and trust | [Library Architecture](architecture/library.md) |
| Pi framework boundary and Clio-owned policy | [Pi Boundary](architecture/pi-boundary.md) |
| Clock, duration, timestamp, and ordering conventions | [Time Conventions](architecture/time-conventions.md) |
| Package qualification, release tags, website documentation, and Wiki updates | [Release Readiness](guide/release-readiness.md) |
| Core terms mapped to source concepts | [Glossary](guide/glossary.md) |

## Developer quick start

```bash
git clone https://github.com/iowarp/clio-coder.git
cd clio-coder
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
node dist/cli/index.js --help
```

For a persistent local command:

```bash
pnpm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
clio-coder --version
```

Use `pnpm run dev` for a watch build. Before handing back a change, run the
focused test while iterating and `pnpm run ci` for the deterministic repository
gate. Maintainers use `pnpm run ci:release` to add the distribution and package
audit.

## Where Clio finds these docs when it is running in someone else's project

Clio's documentation ships with Clio, not with your workspace. Everything below
resolves from the installed package root (`resolvePackageRoot()`,
[package-root.ts](../src/core/package-root.ts)), never from the directory you launched in.

**What is indexed.** The product corpus named by `docs/corpus.json`: this map,
`docs/guide/**/*.md`, and `docs/architecture/**/*.md`. Root `README.md`,
`CHANGELOG.md`, and `CLIO-CODER.md` are supporting package documents when each
exists. A root `CLIO-CODER.md` is indexed only when present, such as in a source
checkout. Generated `docs/wiki/**` pages and retired `docs/html/**` pages are
excluded and reported as exclusions. The index is deterministic and needs no
network or embedding service
([docs-engine.ts](../src/tools/context/docs-engine.ts)).

**Searching and then reading.** `gateway(op="call", capability="clio_docs", args={query: "…"})` returns
section headings with citations such as `docs/architecture/safety-model.md`.
Citations are **package-relative**, and this is the step that matters when the
workspace is someone else's repository: reading `docs/architecture/safety-model.md`
as a plain relative path reads *that project's* `docs/`, if it has one. Clio's
own system prompt names the installed documentation directory as
`{CLIO_DOCS_PATH}`, substituted as `join(packageRoot, "docs")`
([compiler.ts](../src/domains/prompts/compiler.ts)). Resolve the citation against the **package
root**, which is that directory's parent. So when the prompt names `/pkg/docs`:

- `docs/guide/foo.md` → `/pkg/docs/guide/foo.md`
- `CHANGELOG.md` → `/pkg/CHANGELOG.md`, not `/pkg/docs/CHANGELOG.md`

Do not duplicate the `docs/` segment, and do not resolve a citation against the
workspace. Omitting `query` lists the corpus instead of searching it.

**The web documentation.** `clio-coder docs` opens the documentation map in your
browser, and `clio-coder docs safety` opens the safety guide. It resolves content
from the installed package, independent of your current project. If you installed
the background app, it uses that. Otherwise it starts a loopback server that keeps
running after the command returns, so the terminal is free, and reuses that server
on the next call. The server stops on `clio-coder docs --stop`, or by itself 15
minutes after the last page closes. `--no-open` prints the private launch link
without opening a browser, and `--foreground` serves privately in the terminal
until Ctrl+C. The command never installs a service.

## Reading in the application

The browser application provides session controls, project navigation, and
execution inspection. Its documentation viewer renders product Markdown with the
application's theme, syntax highlighting, copy controls, tables, and diagrams.
Navigation groups come from this map, search indexes the same product pages, and
each page's outline is generated from its headings. Internal product references
stay in the application. The loopback document server is a renderer, not an
independent manual.

Edit the authoritative Markdown once to update the installed human and agent
documentation. The static product website has a separate generated snapshot
because it deploys independently from npm; its manifest pins that copy to a
released source ref. The generated development Wiki has separate generation and
publication ownership.

```bash
clio-coder docs
clio-coder docs safety
clio-coder docs guide/configuration-reference.md --no-open
```

The Markdown files remain the portable reference for the CLI, agents, editors,
and repository readers. Opening documentation does not require a model connection.

## Writing documentation

Use the [contributor guidance](../CONTRIBUTING.md) when updating these pages. In particular:

- Verify commands against the built binary rather than copying an old example.
- Use current, canonical settings paths; describe legacy names only in a
  clearly marked migration or historical section.
- Separate deterministic contracts from model-dependent observations.
- Put release chronology in the [CHANGELOG](../CHANGELOG.md), not in the
  product README or an evergreen task guide.
- Link to the detailed contract instead of duplicating a large schema in
  several places.
