# Clio Coder documentation ownership

This matrix maps every active top-level source directory and every domain under
`src/domains/` to the guide that owns its public contract. It is an ownership
map, not a substitute for those guides. Update the relevant row whenever a new
source area or public contract is added.

## Top-level source areas

| Source area | Responsibility | Owning guides |
| --- | --- | --- |
| `src/cli/` | CLI routing, flags, subcommands, exit behavior, and machine output | [Commands and Modes](commands-and-modes.md), [Exit Codes and Output](exit-codes-and-output.md) |
| `src/core/` | Shared invariants, configuration, defaults, path handling, and runtime contracts | [Architecture](architecture.md), [Configuration and Targets](configuration-and-targets.md), [Installation and Lifecycle](installation-and-lifecycle.md) |
| `src/engine/` | Main turn loop, provider execution, streaming, ACP, and worker runtimes | [Architecture](architecture.md), [Context Engine](context-engine.md), [ACP](acp.md) |
| `src/entry/` | Process bootstrap and application composition | [Architecture](architecture.md), [Installation and Lifecycle](installation-and-lifecycle.md) |
| `src/interactive/` | Terminal application, editor, overlays, panels, rendering, and keybindings | [TUI Design](tui-design.md), [Commands and Modes](commands-and-modes.md) |
| `src/tools/` | Built-in tool registry, schemas, policy bindings, and bounded results | [Tool Usage](tool-usage.md), [Prompt Envelope and Tools](prompt-envelope-and-tools.md) |
| `src/utils/` | Image, Git, and supporting utility functions | [Architecture](architecture.md), [Tool Usage](tool-usage.md) |
| `src/worker/` | Worker subprocess protocol, steering, heartbeats, and spec contracts | [Worker Dispatch Mechanics](worker-dispatch-mechanics.md) |

## Domain ownership

| Domain | Responsibility | Owning guides |
| --- | --- | --- |
| `agents` | Thirteen built-in recipes, discovery, recipe/result schemas, and fleet contracts | [Built-in Agents](built-in-agents.md), [Fleet Dispatch](fleet-dispatch.md) |
| `components` | Active component scanning, snapshots, hashing, and diffs | [Middleware and Components](middleware-and-components.md) |
| `config` | Configuration contracts, classification, keybindings, and watchers | [Configuration and Targets](configuration-and-targets.md), [Commands and Modes](commands-and-modes.md) |
| `context` | Project handbook, codewiki, project rules, compaction, and working set | [Context Engine](context-engine.md), [Context Working Set](context-working-set.md) |
| `dispatch` | Admission, assignments, routing, fleet execution, receipts, and recovery | [Fleet Dispatch](fleet-dispatch.md), [Dispatch Typed Intent](dispatch-typed-intent.md), [Dispatch Architecture Rationale](dispatch-architecture-rationale.md) |
| `eval` | Suite v2, runners, artifacts, verdicts, comparison, reports, and provenance | [Eval Runner](eval-runner.md), [Internal Evals](evals-internal.md) |
| `evidence` | Evidence bundles, findings, failure attribution, and provenance | [Evidence and Memory](evidence-and-memory.md), [Observability](observability.md) |
| `evolution` | Falsifiable change manifests and self-edit validation | [Evolution](evolution.md) |
| `extensions` | Extension discovery, compatibility, resources, and state | [Extensions and Sharing](extensions-and-sharing.md) |
| `interop` | Detection, consent, trust posture, and isolation for foreign coding agents | [Extensions and Sharing](extensions-and-sharing.md), [Configuration and Targets](configuration-and-targets.md) |
| `lifecycle` | Doctor, install metadata, upgrade migrations, reset, and uninstall state | [Installation and Lifecycle](installation-and-lifecycle.md), [Artifact Versions](artifact-versions.md) |
| `memory` | Task memory, reviewed promotion, spending, telemetry, and handoff | [Proactive Memory](proactive-memory.md), [Evidence and Memory](evidence-and-memory.md) |
| `middleware` | Hook registration, budgets, reminders, watchdogs, and marketplace offers | [Middleware and Components](middleware-and-components.md), [Skills Marketplace](skills-marketplace.md) |
| `mux` | Experimental pane host, docks, pane registry, and file-pane protocol | [TUI Design](tui-design.md), [Commands and Modes](commands-and-modes.md) |
| `observability` | Trace store, accounting, cost, metrics, and evidence index | [Observability](observability.md), [Trace Store](trace-store.md) |
| `prompts` | Prompt compiler, fragments, preload, hashing, and extension boundary | [Prompt Envelope and Tools](prompt-envelope-and-tools.md) |
| `providers` | Runtime descriptors, probes, target resolution, auth, and model knowledge | [Configuration and Targets](configuration-and-targets.md), [Model Catalog](model-catalog.md), [Provider Adapter Cookbook](provider-adapter-cookbook.md), [ALCF Provider](alcf-provider.md) |
| `resources` | Skills, prompts, libraries, collision policy, and installation provenance | [Skills Marketplace](skills-marketplace.md), [Resource Library](resource-library.md), [Extensions and Sharing](extensions-and-sharing.md) |
| `safety` | Action classification, policy, damage control, audit, and finish contracts | [Safety Model](safety-model.md), [Scientific Validation](scientific-validation.md) |
| `scheduling` | Cluster discovery, capacity budgets, and scheduling extension | [Capacity and Scheduling](capacity-and-scheduling.md), [Fleet Dispatch](fleet-dispatch.md) |
| `session` | Session ledger, branching, checkpoints, compaction records, and recovery | [Session Lifecycle](session-lifecycle.md), [Context Working Set](context-working-set.md) |
| `share` | Portable archive manifests and compatibility reads | [Extensions and Sharing](extensions-and-sharing.md), [Artifact Versions](artifact-versions.md) |
| `toolchain` | Pinned external-tool registry, install, resolution, version, and removal | [Installation and Lifecycle](installation-and-lifecycle.md), [Commands and Modes](commands-and-modes.md) |
| `user-tasks` | Durable operator task-board storage | [Commands and Modes](commands-and-modes.md), [Proactive Memory](proactive-memory.md) |

All active domain directories are represented above. A new domain is not
documentation-complete until it has an owner here and its public behavior is
described in that guide.

## Cross-cutting references

- [Artifact Versions](artifact-versions.md) owns persisted schema identities and
  compatibility windows.
- [Environment Variables](environment-variables.md) owns process-level
  overrides and internal plumbing variables.
- [Glossary](glossary.md) owns stable architectural vocabulary.
- [Troubleshooting](troubleshooting.md) owns operator remediation keyed to
  user-facing errors.
- [Documentation Guide](documentation-guide.md) owns documentation style,
  source alignment, and verification expectations.
