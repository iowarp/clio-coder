---
title: "Architecture"
summary: "How Clio Coder composes its entry points, domain modules, tool surface, and worker runtime into a single coding agent process, and the static import rules that keep those layers decoupled."
sources:
  - "src/core/domain-loader.ts"
  - "src/entry/orchestrator.ts"
  - "src/cli/index.ts"
  - "src/engine/types.ts"
  - "src/tools/registry.ts"
  - "src/worker/entry.ts"
  - "tests/boundaries/check-boundaries.ts"
symbols:
  - "bootOrchestrator"
  - "loadDomains"
  - "createGatewayTool"
  - "createContextTool"
  - "createBackgroundMemoryModelClient"
tests:
  - "tests/contracts/domain-lifecycle.test.ts"
  - "tests/boundaries/check-boundaries.ts"
  - "tests/contracts/gateway-authority.test.ts"
invariants:
  - "Only `src/engine/**` may value-import `@earendil-works/pi-*` packages; all other layers consume erased shapes from `src/engine/types.ts`."
  - "`src/worker/**` never value-imports `src/domains/**` except the provider runtime registry, builtin descriptors, and plugin loader modules used to rehydrate runtimes from stdin."
  - "`src/domains/<x>/**` never imports `src/domains/<y>/extension.ts` for `y != x`; cross-domain access goes through the contract exported from `src/domains/<y>/index.ts`."
  - "`src/tools/**` never imports `src/interactive/**` because the tool substrate is surface-agnostic and shared across headless, interactive, ACP, and worker runs."
  - "The chat loop's turn modules (`src/interactive/turn-*.ts`, `chat-loop.ts`) never import `src/entry/**`; composition flows one direction from entry point to loop."
  - "External runtime importers outside the Stage 0 closure may reach `src/interactive/**` and `src/engine/**` only through seams declared in `STAGE0_SEAMS` in `tests/boundaries/check-boundaries.ts`."
validate:
  - "node --import tsx tests/boundaries/check-boundaries.ts"
---

# Architecture

## What this repository is

Clio Coder is a terminal coding agent for HPC and scientific software, built by IOWarp and the Gnosis Research Center at Illinois Tech. The package (`@iowarp/clio-coder` version 0.5.6) provides an interactive TUI for repository chat, a headless single-turn runner, an ACP v1 agent over stdio, and a GUI server. It orchestrates one or more LLM targets and dispatches bounded workers as subprocesses.

## Top-level composition

The source tree is organized into seven functional layers under `src/` plus an application under `apps/`:

| Layer | Path | Role |
|-------|------|------|
| Core infrastructure | `src/core/` | Event bus, config, domain loader, shared state |
| Engine boundary | `src/engine/` | The only code that touches `@earendil-works/pi-*` |
| Domains | `src/domains/` | Independent business modules (context, dispatch, safety, providers, etc.) |
| Tools | `src/tools/` | Surface-agnostic tool specifications and execution |
| Interactive | `src/interactive/` | TUI rendering, chat loop, overlays, keybinding |
| Entry | `src/entry/` | Boot composition root and mode wiring |
| Worker | `src/worker/` | Subprocess runtime for dispatched workers |
| CLI | `src/cli/` | Argument parsing, subcommand dispatch, boot options |
| GUI app | `apps/clio-coder-gui/` | Optional alpha web application |

## Domain module system

The composition backbone is the manifest-driven domain loader in `src/core/domain-loader.ts`. Every domain exports a `DomainModule` with a `manifest` (declaring its name and `dependsOn` list) and a `createExtension(context)` factory. The loader:

1. Topologically sorts modules by their dependency manifests.
2. Instantiates each in order, passing a `DomainContext` that exposes the shared event bus and `getContract<T>(name)`.
3. Calls `extension.start()` and stores the resulting contract under the domain name.
4. On shutdown, calls `stop()` in reverse dependency order, unwinding bus listeners and releasing resources.

The orchestrator in `src/entry/orchestrator.ts` (`bootOrchestrator`) composes all domain modules for a production boot. The module list includes Config, Extensions, Plugins, Interop, Resources, Share, Context, Providers, Safety, Prompts, Agents, Middleware, Session, Observability, Scheduling, and conditionally Mux (panes) and Dispatch. Each domain receives a `DomainContext` whose `getContract` returns only the query-only contract from previously loaded domains, never the full extension, enforcing the cross-domain boundary.

The focused test in `tests/contracts/domain-lifecycle.test.ts` verifies three lifecycle guarantees:
- A failed domain startup releases its listeners and earlier dependencies in reverse order.
- A rejected domain factory unwinds started dependencies.
- Concurrent shutdown callers await one cleanup, and stopped contracts are withdrawn.

## Entry points and process modes

Three process modes share the domain loader:

1. **Interactive** (`src/cli/index.ts` → `src/cli/clio.ts` → `src/entry/orchestrator.ts`): Opens the TUI via the terminal lease, boots all domains, creates the chat loop, and runs the interactive session. The Stage 0 shell (terminal lease) answers the terminal immediately while Stage 1 hydrates, yielding at each phase boundary via `bootPhaseBoundary`.

2. **Headless** (`clio-coder run`): Loads the same domains, resolves the model target, and runs a single main-agent turn via `runHeadlessMainAgent` from `src/cli/modes/print.ts`.

3. **ACP** (`clio-coder acp`): Serves the ACP v1 protocol over stdio via `serveClioAcpAgent` in `src/engine/acp/server.ts`. The CLI dispatches this through the `COMMAND_HANDLERS` map in `src/cli/index.ts`, dynamically importing each subcommand's module to avoid cold module-load tax.

The GUI server in `apps/clio-coder-gui/server/main.ts` runs a Hono-based HTTP application that spawns worker hosts for reads and operations, connects to an ACP supervisor, and exposes session, workspace, and service endpoints over REST.

## Engine boundary

The file `src/engine/types.ts` is the single re-export point for engine package types consumed by the rest of the codebase. It exposes erased shapes like `EngineModel` (which is `PiModel<PiApi>`), `AgentMessage`, `Usage`, and TUI types. The comment in that file states the rule explicitly: "Importing engine package types from anywhere else in the codebase violates the engine boundary."

The boundary checker in `tests/boundaries/check-boundaries.ts` enforces this as rule 1: no file outside `src/engine/**` may import `@earendil-works/pi-*` at all, not even type-only imports (since the 0.83.0 rework). Domains take erased engine shapes from `src/engine/types.ts` instead.

## Tool surface and gateway

The tool system lives in `src/tools/`. Tools are defined as `ToolSpec` objects registered in a `ToolRegistry`. The gateway tool (`src/tools/gateway/index.ts`, exported as `createGatewayTool`) provides a unified `find`/`describe`/`call` interface through which the model reaches secondary capabilities that are not attached directly to the model's tool surface. A gateway call resolves the capability and invokes it through the registry under the capability's own name, so safety, skill policy, autonomy mapping, and audit all apply identically to a direct call.

The context tool (`src/tools/context/index.ts`, exported as `createContextTool`) provides `workspace`, `settings`, `skills`, `recall`, and `budget` scopes. The `skills` scope handles the skill activation policy including pending-request gates, drift detection, and marketplace rows. The `docs` and `library` scopes are gateway capabilities (`clio_docs`, `clio_library`).

The data tool (`src/tools/data/index.ts`) exports `inspectData`, `selectData`, and `validateData` for CSV/TSV, JSON, and JSON Lines files. Format detection follows an explicit-argument → extension → content-sniffing cascade, and each function streams the file, returning a JSON-serializable result or a typed refusal.

## Worker runtime

Workers run as separate Node.js subprocesses launched by the dispatch domain. The worker entry point (`src/worker/entry.ts`) reads a `WorkerSpec` JSON document from stdin, rehydrates the runtime descriptor from the runtime registry, and dispatches to `startWorkerRun` from the engine boundary. Workers emit NDJSON events on stdout and communicate with the orchestrator through a control lane.

The worker boundary is strict: `src/worker/**` may only value-import from `src/domains/providers/plugins.ts`, `src/domains/providers/registry.ts`, and `src/domains/providers/runtimes/builtins.ts` (the provider runtime rehydration modules). All other domain imports must be type-only. This rule is enforced as rule 2 in the boundary checker.

## Data flow: a headless turn

For a `clio-coder run "<task>"` invocation:

1. `src/cli/index.ts` parses flags, dispatches to the `run` handler, which dynamically imports `src/cli/run.ts`.
2. `src/cli/run.ts` calls `bootOrchestrator` with headless options.
3. `bootOrchestrator` in `src/entry/orchestrator.ts` loads all domains via `loadDomains`, resolves the model target through the Providers contract, and registers background memory routing.
4. The chat loop (`src/interactive/chat-loop.ts`) executes the turn, invoking tools through the registry.
5. Tool results pass through the observation budget system (`src/tools/observation.ts`) for per-turn byte caps.
6. The session domain persists entries to the JSONL ledger.
7. On completion, the termination coordinator drains dispatch and closes all extensions in reverse order.

## Enforced boundaries

Six static import rules are checked by `tests/boundaries/check-boundaries.ts`:

| Rule | Constraint |
|------|-----------|
| 1 | `src/engine/**` is the only code that may value-import `@earendil-works/pi-*`; all other layers use erased shapes from `src/engine/types.ts`. |
| 2 | `src/worker/**` never value-imports `src/domains/**` except provider runtime rehydration modules. |
| 3 | `src/domains/<x>` never imports `src/domains/<y>/extension.ts` for `y != x`; use the contract from `src/domains/<y>/index.ts`. |
| 4 | `src/tools/**` never imports `src/interactive/**`; the tool substrate is surface-agnostic. |
| 5 | Chat loop turn modules never import `src/entry/**`; composition flows one direction. |
| 6 | External runtime importers reach `src/interactive/**` and `src/engine/**` only through declared seams in `STAGE0_SEAMS`. |

The Stage 0 closure (owned by `src/interactive/terminal-lease.ts`) is held to 16 chunks, 700,000 total bytes, and 175,000 Clio source bytes by `tests/contracts/instant-shell-import-graph.test.ts`. Rule 6 protects this budget by preventing external importers from dragging the Stage 0 closure into their own module graph.

## Extension seams

New capabilities are added at specific seams:

- **New domain module**: Export a `DomainModule` from `src/domains/<name>/index.ts` with a manifest and `createExtension`. Register it in the orchestrator's `loadDomains` array. The module receives a `DomainContext` and returns a `DomainBundle` with an extension (lifecycle) and a contract (query surface).

- **New tool**: Define a `ToolSpec` with `name`, `description`, `parameters` (TypeBox schema), `baseActionClass`, and `run`. Register it in the tool bootstrap (`src/tools/bootstrap.ts`). Tools marked as "direct" are attached to the model surface; others are reachable through the gateway.

- **New CLI subcommand**: Add an entry to the `COMMAND_HANDLERS` map in `src/cli/index.ts` that dynamically imports a new module from `src/cli/`. The dynamic import is literal so tsup can split it into its own chunk.

- **New worker runtime**: Register a `RuntimeDescriptor` in `src/domains/providers/runtimes/builtins.ts`. The worker rehydrates it from stdin via `src/worker/runtime-registry.ts`.

- **New MCP server**: Declare the server in the project's MCP configuration. The gateway's MCP capability source (`src/tools/gateway/mcp-capabilities.ts`) discovers it and exposes its tools as capabilities.

## Things to watch when editing

- **Engine boundary is absolute.** Since the 0.83.0 rework, there is no type-only exception to rule 1. If a domain needs a new engine type, add the re-export to `src/engine/types.ts` in the same commit as the consumer.

- **Domain contract is the only cross-domain surface.** A domain's `extension.ts` may hold internal state, event subscriptions, and side effects. Other domains must go through the contract from `index.ts`. The boundary checker (rule 3) fails the build if a domain reaches into another's extension.

- **The gateway is not a second authority.** A `gateway(op="call")` goes through the same registry invocation as a direct tool call. The safety net, skill policy, autonomy mapping, parking, before/after hooks, and audit row all apply under the capability's own name. If you add a tool, its action class and approval behavior are the same whether called directly or through the gateway.

- **Stage 0 is a cold-start budget, not a code-quality rule.** Adding a new reacher to `src/interactive/**` from outside the Stage 0 closure requires a declared seam in `STAGE0_SEAMS` with a reason. The seam's own closure must stay off the Stage 0 modules, or the instant shell's chunk graph splits.

- **Worker subprocesses are process-isolated by design.** They have their own tool registry, their own session ledger mirror, and their own event bus. The orchestrator never observes worker tool calls directly; worker skill activations fold into the session ledger only through the dispatch terminal payload. Code that assumes shared state between orchestrator and worker will fail.

<!-- clio-coder:wiki unresolved sources: src/engine/**, src/worker/**, src/domains/**, src/domains/<x>, src/domains/<y>/extension.ts, src/domains/<y>/index.ts, src/tools/**, src/interactive/**, src/entry/**, src/domains/<name>/index.ts -->
