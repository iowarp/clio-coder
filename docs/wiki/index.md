# Wiki

> **Maintenance provenance (2026-11-17):** this is a legacy generated snapshot, not a full regeneration. The original metadata belongs to `2026-11-04` / `a3333e52a8b8e6a241192d78d3083dfe38103183`. A targeted source audit was performed at `3aae104412c3edb7f315cd6dcbb19becd4027d2c`; only pages and sections marked audit-covered were checked. Other pages retain their older coverage and may be stale. Cited tests were inspected or located, not executed.

The historical generation reported 65 complete pages and 0 pending; that count was not recomputed.

**Explicitly stale/partial remainder:** all pages not listed in `meta.json`'s `maintenance.auditSourceCheckedPages` retain legacy coverage. Within audited pages, retained sections are partial unless an evidence banner says otherwise. Older GUI worker/launcher detail, detailed domain branches, Materio detail, and unread test assertions are not newly verified; use them as source-location guides and read the current cited file before changing behavior.

- [Command-line surfaces, boot, and tool composition](architecture.md) — How the clio-coder binary routes a command to its handler, boots the orchestrator, and composes the gateway, context and data tools; read this to find which surface owns a request before changing it.
- [Command-line surfaces](cli.md) — How the clio-coder binary routes a subcommand to its handler, and what the main command modules under src/cli own. Read this before adding a subcommand, changing global flag handling, or tracing a run, configure, targets, upgrade, wiki or fleet view invocation.
- [Core runtime: settings, trust, safe execution and run records](core.md) — Describes the src/core leaf modules that load layered settings, gate project-supplied files behind operator consent, run commands through the sandbox-aware exec helpers, and record run provenance. Read this when changing how settings are resolved, how a command is spawned, or where run evidence is written.
- [Domain modules: application boundaries and aggregate ownership](domains.md) — Maps current arena, campaign, claims, components, config, evolution, report, research, semantic-app, share, store, turn-control and user-task boundaries.
- [Engine runtime: worker runs, loop guard, sessions and external CLI connectors](engine.md) — Describes the engine layer that runs a worker or orchestrator turn: the worker run boundary, the Pi agent wrapper, the loop guard, Clio session storage, provider payload tool-round control, the Harmony stream router, and the managed external CLI connectors such as Antigravity. Read this page to find which engine file owns a runtime behavior.
- [Entry composition and runtime coordination](entry.md) — How the src/entry layer composes a session: extension generation reloads, the reload report, the background job host and runtime admission, the information-flow ledger, the safety judge host, and the orchestrator that wires them. Read this before changing boot order, extension publication, reload reporting, job admission, or provenance handling.
- [Command-line surfaces: the interactive terminal app](interactive.md) — How the interactive terminal UI is composed and driven: the application entry point, the chat transcript and its streaming renderer, the dispatch board, slash commands including /export, overlay frames, and HTML export. Read this when changing anything the operator sees in the interactive TUI.
- [Repository root: launcher, build configuration, image utilities and example extensions](root.md) — Covers the package's root-level launcher and build config, the image resize and EXIF utilities under src/utils, and the example extensions under examples/. Read this page when changing how the CLI starts, how dist/ is bundled, how images are downscaled for model input, or when authoring an extension from the examples.
- [Command-line maintenance scripts](scripts.md) — The repository's scripts/ directory: release gates, publication and dev-snapshot tooling, skill and marketplace generators, the hygiene lint, and TUI benchmarks. Read this page to find which script owns a release, catalog or lint check and how it is invoked.
- [Session control: chat loop, turns, slash commands and replay](session-control.md) — How Clio drives one conversation: the chat loop state machine, per-turn runtime and context, slash-command parsing and dispatch, the /loop grammar, and rebuilding model messages from the session ledger. Read this before changing turn admission, command routing, or replay.
- [Public website build and documentation sync](site.md) — How the public Clio Coder website is generated, previewed, validated, and kept in step with the user guides under docs/guide. Read this before changing site pages, build scripts, or the documentation snapshot.
- [Test fixtures and helper processes](tests.md) — Describes the scripted stdio peers and helper processes under tests/fixtures that contract and extended tests spawn to exercise MCP, ACP, Slurm, shutdown, and Windows spawn behavior. Use it to find which fixture a test drives and what each mode does.
- [Tool registration, admission, and document reading](tools.md) — How the agent's tool surface is assembled in src/tools (bootstrap, registry, dispatch, and the built-in tool modules), how a call is admitted by the registry, and how the read tool's document renderers window their output. Start here before changing tool registration or the registry's admission path.
- [Worker subprocess protocol and entry point](worker.md) — How the worker subprocess is started, receives its WorkerSpec on stdin, is admitted by the orchestrator, streams NDJSON on stdout, and shuts down. Read this when changing the worker wire protocol, stdin handling, stdout bounds, or spec validation.

## Sections

- [apps/](apps/index.md)
- [cli/](cli/index.md)
- [core/](core/index.md)
- [domains/](domains/index.md)
- [engine/](engine/index.md)
- [interactive/](interactive/index.md)
- [library/](library/index.md)
- [tests/](tests/index.md)
- [tools/](tools/index.md)
