# Clio Coder roadmap

Clio Coder v0.5.3 is released. The next release focus is context management,
compaction, and memory: preserving task continuity, making context decisions
understandable, and reducing the cost of long sessions. The terminal remains
the primary coding interface.

This roadmap describes priorities, not available features or delivery promises.
For implemented behavior, use the [documentation](docs/README.md). Historical
release changes are in [CHANGELOG.md](CHANGELOG.md); older development plans in
git history are not current contracts.

## Shipped in v0.5.3

Two provider surfaces landed in this release and are documented in
[configuration-and-targets.md](docs/guide/configuration-and-targets.md).

- **Diffusion model support.** The `inception` runtime serves Inception's
  Mercury models over chat and the existing fill-in-the-middle verb, in the
  latency-sensitive slot a frontier model cannot fill.
- **System One decision models.** The hidden `typesafe-jev` runtime and the
  `decide()` contract verb return calibrated distributions over a closed answer
  shape instead of prose. This is an alpha surface: the wire contract ships, and
  the harness call sites that consume it do not exist yet.

## Shipped in v0.5.2

The context and memory priorities listed here as intended work are released.
[CHANGELOG.md](CHANGELOG.md) records what each one became.

- **Task continuity through compaction.** Let the active agent save a bounded
  handoff with its next action, preserve it verbatim, and recover interrupted
  transitions from the session ledger.
- **Earlier, shared context awareness.** Give the agent and operator the same
  pressure and budget facts while preserving automatic eviction and overflow
  recovery.
- **Clear memory lifetimes.** Distinguish the active working set, session
  continuity, and reviewed durable lessons; keep provenance and scope explicit.
- **Measured speed and usefulness.** Prefer reversible eviction, avoid redundant
  restoration and model calls, and evaluate task completion, context cost,
  cache effects, and recovery latency together.

Threshold changes and wider memory automation still depend on comparative
evaluation.

## v0.5.0 launch priorities

These priorities are retained as the historical scope of the public launch.

- **A dependable terminal workflow.** Responsive startup, clear tool activity,
  honest progress and timing, useful permissions, and recoverable sessions.
- **Models chosen by the operator.** Local inference, institutional gateways,
  cloud APIs, and independently configured workers and task memory.
- **Evidence that survives the task.** Recorded tool outcomes, decisions,
  validation results, worker receipts, and source-grounded explanations.
- **Context that supports real work.** Repository indexing, scoped prompt
  composition, bounded observations, compaction, and explicit memory provenance.
- **Documentation people and agents can navigate.** Accurate shipped Markdown,
  a polished browser reading experience, and installed docs/source for Clio's
  own feature lookup.
- **A reproducible distribution.** Package contents, installed CLI/browser
  checks, component notices, and qualification of the exact release artifact.

These systems formed the public launch. Future releases still follow the
[release checklist](docs/process/release-cut-checklist.md).
A completed test campaign establishes its recorded coverage, not universal
correctness across every model, platform, or scientific workload.

## Next engineering priorities

| Area | Direction | Boundary today |
| --- | --- | --- |
| Process isolation | Evaluate OS containment for shell children, race-resistant filesystem admission, and stronger write-root enforcement. | Tool policy is not a general OS sandbox. |
| Consistent capability policy | Continue reviewing path/search scope across data, code navigation, git, and trusted MCP tools; refine action classes where supported. | A trusted server or executable is not automatically safe for every action. |
| Worker resilience | Extend worktree placement where needed, improve failure recovery and progress, and remove legacy intent fallback only when usage evidence supports it. | Task worktree placement and competing-candidate placement are distinct paths. |
| Memory and routing | Evaluate query-aware memory selection and carefully bounded routing improvements. | No promised cross-route hedging or general remote-operator control. |
| External workers | Improve verified protocol coverage and stream translation for external agent runtimes. | Support must be established per integration, not inferred from product names. |
| Browser app | Polish documentation first, then close measured TUI/browser capability and observability gaps. | The graphical app remains an early preview, not a promise of complete TUI parity. |
| Platform coverage | Exercise more macOS and Windows installations, tools, browser launch, and process lifecycle behavior. | Linux has the broadest live coverage; platform-specific claims require evidence. |

## Workflows to develop further

- **Repository maps:** improve the `context map` → archify workflow, verify cited
  paths, and measure diagram quality on representative repositories. Explore
  browsing generated maps in the graphical app.
- **Evaluation campaigns:** use the existing eval engine for named, reproducible
  campaigns with recorded routes, environments, and decision criteria. Potential
  external benchmarks include SWE-bench, Terminal-Bench, SciCode, and
  ScienceAgentBench; these names are plans, not published scores or completed adapters.
- **Library coherence:** keep auditing skills, prompts, recipes, and plugins for
  stale guidance, duplicate responsibilities, installation ownership, and
  compatibility with peer hosts.
- **Terminal workflows:** revisit advanced glance/task operators and optional
  pane ownership only where they reduce real task friction. Proposed `@@`, `#`,
  `##`, or `^` syntax is not documented as a shipped command.
- **Interop and data exchange:** finish verified ACP registry distribution and
  external-agent workflows, and refine transfer workflows around the existing
  optional tools rather than introducing a second execution framework.

## Planned compatibility cleanup

The v0.7.0 compatibility window is intended to remove released legacy naming
helpers and the `lmstudio-native` / `ollama-native` runtime aliases. Before
removal, audit configuration migrations, environment readers, provider
registries, resource discovery, and history compatibility together. Preserve
clear migration guidance and test old records rather than silently discarding them.

## How priorities change

Field reports from real repositories matter more than a growing feature list.
Report a concrete failure or a workflow that requires unnecessary supervision
through [GitHub issues](https://github.com/iowarp/clio-coder/issues). Include
reproduction steps and sanitized evidence.

Scope changes should be explicit. A future design is not a release claim, a
benchmark proposal is not a measured result, and a successful command does not
establish scientific validity. New work should strengthen the existing harness
before adding another subsystem.
