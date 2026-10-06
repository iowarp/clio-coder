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
├── corpus.json      Declared documentation roots and exclusions
├── guide/           Configuration and operator workflows
├── architecture/    Runtime architecture and contracts
└── wiki/            Generated development reference, v0.1
```

Clio reads the authored Markdown in this directory directly from its installed
package. The website serves a generated snapshot of the guides listed in
`site/public-docs.json` (a source-checkout file), so a guide that is not listed
there is bundled with Clio Coder and absent from the website. The
[GitHub Wiki](https://github.com/iowarp/clio-coder/wiki) is a developing source
reference with independent v0.1 versioning. Use the architecture guides and
current source for implementation decisions.

## Start here

| Goal | Guide |
| --- | --- |
| Install Clio Coder and connect the first model | [Installation and Lifecycle](guide/installation-and-lifecycle.md) → [Configuration and Targets](guide/configuration-and-targets.md) |
| Install on an HPC cluster: no root, old glibc, proxies, airgapped mirrors | [HPC clusters](guide/hpc-clusters.md) |
| Learn the interactive session and CLI | [Commands and Modes](guide/commands-and-modes.md) |
| Understand what Clio Coder may read, change, or execute | [Safety Model](architecture/safety-model.md) |
| Diagnose a problem by its exact message | [Troubleshooting](guide/troubleshooting.md) |
| Run the read-only install check: core install, targets, HPC toolchain, task worktrees, Slurm MCP and System One rows, and the deep checks | [Doctor](guide/doctor.md) |
| Place a decision engine at System One sites (turn hints, the tool-call gate, relevance ranking, consult, drafts), then calibrate it and run it in shadow mode | [System One](guide/system-one.md) |
| Submit, poll, and cancel Slurm jobs through the clio-kit MCP server | [Slurm](guide/slurm.md) |

A minimal first run needs a model to talk to: a local app such as Ollama or LM
Studio, a lab gateway, an AI subscription, or a cloud API. Guided setup starts
from those recognizable choices, fills in Clio Coder's internal connection name,
checks the endpoint when possible, and offers the models it can discover. The
endpoint shortcut is available for operators who already know a server URL.

The installer brings its own Node.js and needs no root. Installing from npm
needs Node.js 22.19 or newer.

```bash
curl -fsSL https://coder.iowarp.ai/install.sh | sh
clio-coder configure
cd /path/to/your/project
clio-coder
```

`npm install -g @iowarp/clio-coder` replaces the first command when you manage
Node.js yourself. [Graphical Application](guide/gui.md) covers the browser
interface, which has its own guided setup.

Use `clio-coder --help` for the installed command surface and `/help` inside an
interactive session. `clio-coder doctor` is a read-only installation check;
`doctor --fix` performs only the repairs it reports.

## Using Clio Coder day to day

| Topic | Guide |
| --- | --- |
| Connecting a model: targets, providers, auth, the settings center and inventory, live routing versus saved defaults, model profiles, and local runtime settings | [Configuration and Targets](guide/configuration-and-targets.md) |
| Settings keys with defaults, the version 1 to 2 key map, retired keys, project files, local stdio MCP trust, and CLI flag and tool argument contracts | [Configuration Reference](guide/configuration-reference.md) |
| Runtime discovery, model capabilities, local overlays, and field notes | [Model Catalog](architecture/model-catalog.md) |
| Argonne ALCF Sophia and Metis targets over Globus OAuth | [ALCF Provider](architecture/alcf-provider.md) |
| Context windows, token accounting, single-threshold compaction, prefix caching, project handbooks, and the codemap | [Context Engine](architecture/context-engine.md) |
| Codemap, bounded orientation, current project evidence, and artifact compatibility | [Project Context](architecture/project-context.md) |
| Choose compaction and recover interrupted handoffs | [Context Continuity](guide/context-continuity.md) |
| Non-destructive working-set eviction, markers, and recall | [Context Working Set](architecture/context-working-set.md) |
| Session ledgers, branches, checkpoints, resume, and recovery | [Session Lifecycle](architecture/session-lifecycle.md) |
| Proactive task memory, interventions, and handoffs | [Proactive Memory](guide/proactive-memory.md) |
| Skills as library packages: operator ownership of installed skills, library keys, matching and authoring, and publishing | [Skills Marketplace](guide/skills-marketplace.md) |
| Resource roots and precedence, prompt templates, skill loading, and share archives | [Prompts, Skills, and Share Archives](guide/extensions-and-sharing.md) |
| The `library` command family for packages of every kind: browse, install, update, pin and drift, extension review, lifecycle receipts, scope and workspace state, index format, registering and publishing, and the shared component inventory | [Resource Library](guide/resource-library.md) |
| Package kinds, how plugins differ from extensions and how the two pair, and where each library contract lives | [Plugins](guide/plugins.md) |
| Package manifests and component references | [Authoring Plugins](guide/authoring-plugins.md) |
| Extensions: Clio code in its own process, capability envelope, sandbox, hooks, runtime tools, commands, workspaces, and lifecycle | [Extensions](guide/harness-extensions.md) |
| TUI layout, responsive behavior, colors, and interaction rules | [TUI Design](architecture/tui-design.md) |
| Terminal panes beside a session and the files pane: install, keys, settings, doctor, troubleshooting | [Panes and the Files Pane](guide/panes-and-files.md) |
| Focus radio in a Herdr dock: `/music`, cliamp install, the `integrations.music.*` settings, and the opt-in `music` tool | [Music Pane](guide/music.md) |
| The browser interface: starting it, the background app, the installer option, shell layout, approvals, and what the local server exposes | [Graphical Application](guide/gui.md) |

## Safety, evidence, and reproducibility

| Topic | Guide |
| --- | --- |
| Autonomy, default-deny execution, project policy, and damage-control rules | [Safety Model](architecture/safety-model.md) |
| Source labels, approved destinations, worker admission, and refusal recovery | [Information Flow](guide/information-flow.md) |
| System One decision sites, record-only safety observations, calibration, shadow mode, and the opt-in dataset | [System One](guide/system-one.md) |
| Required checks by changed path, fresh verification snapshots, and completion findings | [Project Quality Policies](guide/quality-policy.md) |
| The `/view` artifact viewer, trace retention, the evidence spine, cross-session usage facts, the accountability panel, and receipt integrity | [Observability](architecture/observability.md) |
| Durable evidence bundles, findings, and reviewed memory | [Evidence and Memory](architecture/evidence-and-memory.md) |
| SQLite trace mirror, schemas, cursors, and rebuildability | [Trace Store](architecture/trace-store.md) |
| Where generated files live and who should read them | [Artifact Placement](architecture/artifact-placement.md) |
| Versioned artifact schemas and migration policy | [Artifact Versions](architecture/artifact-versions.md) |

Receipts link execution observations to tool activity and results. Project checks,
reference data, and review define the acceptance criteria for a change.

## Delegation and fleets

| Topic | Guide |
| --- | --- |
| Built-in worker agents, discovery, frontmatter, and admission | [Built-in Agents](guide/built-in-agents.md) |
| Playbooks, local and multi-node fleet execution, placement, gates, and receipts | [Fleet Dispatch](guide/fleet-dispatch.md) |
| Capacity leases, heartbeats, locks, and node drain control | [Capacity and Scheduling](architecture/capacity-and-scheduling.md) |
| Worker process protocol, watchdogs, exit mapping, the refusal limit and denial format, failure classification and retries, and route history labels | [Worker Dispatch Mechanics](architecture/worker-dispatch-mechanics.md) |
| Worker context inheritance, fork, and splice modes | [Worker Context](architecture/worker-context.md) |
| Typed dispatch intent and compatibility boundaries | [Dispatch Typed Intent](architecture/dispatch-typed-intent.md) |
| The contracts the dispatch domain shares: plan compilation, reservation, attempt identity, admission, write attribution, receipt authority, and import direction | [Dispatch Domain Boundaries](architecture/dispatch-architecture-rationale.md) |

## Automation and integration

| Topic | Guide |
| --- | --- |
| Agent Client Protocol in both directions: the stdio server, capability negotiation, extension methods, permission mediation, and outbound delegation to peers | [ACP](architecture/acp.md) |
| Which fragments each prompt tier carries, how they are selected, substitutions, and the dynamic sections | [Prompt Compilation](architecture/prompt-compilation.md) |
| Prompt-envelope reuse, provider tool delivery, and bounded results | [Prompt Envelope and Tools](architecture/prompt-envelope-and-tools.md) |
| Built-in tool contracts, operating boundaries, and core workflows | [Tool Usage](guide/tool-usage.md) |
| Implementing a runtime or inference-server adapter | [Provider Adapter Cookbook](architecture/provider-adapter-cookbook.md) |
| Delegate to installed coding agents through their supported ACP, headless CLI, or pane modes; inspect and adopt their resources | [Coding Agent Interoperability](guide/interop.md) |
| Middleware hooks, effects, budgets, and component snapshots | [Middleware and Components](architecture/middleware-and-components.md) |
| Decision-layer contract: sites, engines, runner, cuts per build, records, and how a build is validated | [System One Architecture](architecture/system-one.md) |
| Process exit codes, stdout/stderr rules, JSONL, and `--help` contracts | [Exit Codes and Output](guide/exit-codes-and-output.md) |
| Environment overrides, directory controls, and debug toggles | [Environment Variables](guide/environment-variables.md) |

## Architecture and contributing

| Topic | Guide |
| --- | --- |
| Source layout, compile-time boundaries, domain loading, and runtime flow | [Architecture](architecture/architecture.md) |
| Package identity, envelope, integrity, install state, dependency rule, trust by origin, and the shared inventory | [Library Architecture](architecture/library.md) |
| Pi framework boundary and Clio Coder-owned policy | [Pi Boundary](architecture/pi-boundary.md) |
| Clock, duration, timestamp, and ordering conventions | [Time Conventions](architecture/time-conventions.md) |
| Boot sequence, startup presentation modes, and how to benchmark boot on a machine | [TUI Boot Performance](architecture/tui-boot-performance.md) |
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

## Where Clio Coder finds these docs when it is running in someone else's project

Clio Coder's documentation ships with the software, not with your workspace. Everything below
resolves from the installed package root, never from the directory you launched
in. The root is `CLIO_CODER_PACKAGE_ROOT` when that variable is set, and
otherwise the nearest directory holding a `package.json` above the running code
(`resolvePackageRoot()`, [package-root.ts](../src/core/package-root.ts)).

**What is indexed.** `clio_docs` ([docs-engine.ts](../src/tools/context/docs-engine.ts))
walks `<package root>/docs` for every `.md` file in name order and skips only
`docs/html`. It then adds the package root's `README.md`, `CHANGELOG.md` and
`CLIO-CODER.md`, each only when it exists. In an installed package that is this
map, `docs/guide/**`, `docs/architecture/**`, `README.md` and `CHANGELOG.md`,
because `package.json` ships `docs/**/*.md` and leaves out `docs/wiki/**`.
`CLIO-CODER.md` is a source-checkout handbook and is not shipped. A source
checkout therefore also indexes the generated `docs/wiki/**` pages: the engine
has no wiki exclusion, and `scripts/check-hygiene.ts` requires every Markdown
file under `docs/` except `docs/html` to appear in the listing. A search returns
sections, one per heading, ranked by BM25 over headings and bodies with Clio Coder
vocabulary aliases and phrase boosts. The index is deterministic and needs no
network or embedding service.

**What `docs/corpus.json` does.** It declares the product corpus: roots relative
to `docs/` (this map, `architecture/`, `guide/`), the package-root files that
also count, and the trees left out (`html/**` by retrieval, `wiki/**` by
packaging). It ships in the package and the installed-package smoke test checks
that it exists. No retrieval, build or website code reads it. Adding or removing
a page changes the corpus through the Markdown file alone, and editing
`corpus.json` does not change what `clio_docs` returns.

**Searching and then reading.** `gateway(op="call", capability="clio_docs", args={query: "…"})`
returns up to five sections by default (`limit` up to twelve). Each hit carries a
package-relative `file` such as `docs/architecture/safety-model.md`, its heading
and line range, and `read.args`: the absolute `path`, `offset`, `limit` and
`line_numbers` that read exactly that section. Pass `read.args` to `read` as
given. This is the step that matters when the workspace is someone else's
repository: reading `docs/architecture/safety-model.md` as a plain relative path
reads *that project's* `docs/`, if it has one. Clio Coder's own system prompt names the
installed documentation directory as `{CLIO_DOCS_PATH}`, substituted as
`join(packageRoot, "docs")` ([compiler.ts](../src/domains/prompts/compiler.ts)).
To resolve a `file` by hand, resolve it against the **package root**, which is
that directory's parent. So when the prompt names `/pkg/docs`:

- `docs/guide/foo.md` → `/pkg/docs/guide/foo.md`
- `CHANGELOG.md` → `/pkg/CHANGELOG.md`, not `/pkg/docs/CHANGELOG.md`

Do not duplicate the `docs/` segment, and do not resolve a citation against the
workspace. Omitting `query` lists the corpus (file list, document and section
counts) instead of searching it.

**The public documentation.** Read the user guides at
<https://coder.iowarp.ai/docs.html>. The browser application's Help entry links to
that site and identifies the installed `docs/` directory. Use an editor to read
those Markdown files offline, or ask Clio to retrieve them with `clio_docs`.
There is no documentation command or separate documentation server.

## Reading the bundled reference

The package ships the canonical Markdown and `docs/corpus.json`, independent of
your current project. The offline `clio_docs` capability indexes that Markdown
for agents without a model connection or network request for retrieval.

Edit the authoritative Markdown once to update the installed reference. The
static product website has a generated snapshot of the guides listed in
`site/public-docs.json`, built by `site/sync-docs.py`, because it deploys
independently from npm; its manifest records the source revision, commit and
file hashes. The generated development Wiki has separate generation and
publication ownership.

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
- Link every new page from this map. `clio_docs` indexes any Markdown file under
  `docs/` without registration, and `scripts/check-hygiene.ts` checks relative
  links, heading anchors, cited source paths and the corpus listing.
