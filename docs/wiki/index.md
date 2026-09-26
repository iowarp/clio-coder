# Wiki

- [Architecture](architecture.md) — How Clio Coder composes its entry points, domain modules, tool surface, and worker runtime into a single coding agent process, and the static import rules that keep those layers decoupled.
- [Command-line surfaces](cli.md) — The argument-parsing and subcommand-dispatch entry point for every Clio Coder CLI surface, the configure wizard and target-selection flows, the headless main-agent runner, and the fleet authoring/execution and read-only run-viewer commands.
- [Core: settings schema, layered configuration, bus contracts, safe exec, and session routing](core.md) — The shared foundation modules under src/core that every domain depends on: the one strict settings schema and its layered merge, the event-bus channel registry with payload contracts, the sandboxed subprocess runner, the session-local routing state machine, and the workspace file enumerator.
- [Engine](engine.md) — The worker-subprocess engine boundary: the unified loop guard, the pi-agent worker runtime with its Claude SDK and external-CLI branches, per-provider request payload patches, the Claude tool-safety mediator, and the session JSONL ledger.
- [Entry point](entry.md) — The composition root that wires all domain bundles, resolves boot options, coordinates extension reloads, and activates the panes extension for interactive sessions.
- [Interactive](interactive.md) — The terminal user interface that hosts the chat loop, the streaming transcript, the status footer, the theme, and the export/view surfaces, and how events flow through its composition root.
- [Scripts](scripts.md) — Checkout-only tooling under scripts/: the drift/lint gate, the library and skill pinning pipeline, the release qualification gate, the Pi API surface diff, and the two operator-run benches.
- [Tools](tools.md) — The tool system through which the model reads and mutates the world: registration, placement, lazy loading, observation reservation, and the individual tool implementations for context, gateway, code navigation, dispatch orchestration, monitoring, and script execution.
- [Worker runtime](worker.md) — The worker subprocess runtime: NDJSON protocol, spec contract, control-lane steering, attestation frames, and the boundary invariants that keep the bulk lane and control lane separated.

## Sections

- [apps/](apps/index.md)
- [domains/](domains/index.md)
- [engine/](engine/index.md)
- [interactive/](interactive/index.md)
- [tests/](tests/index.md)
- [tools/](tools/index.md)
