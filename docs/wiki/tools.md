---
title: "Tools"
summary: "The tool system through which the model reads and mutates the world: registration, placement, lazy loading, observation reservation, and the individual tool implementations for context, gateway, code navigation, dispatch orchestration, monitoring, and script execution."
sources:
  - "src/tools/registry.ts"
  - "src/tools/bootstrap.ts"
  - "src/tools/surface.ts"
  - "src/tools/lazy-tool.ts"
  - "src/tools/context/index.ts"
  - "src/tools/gateway/index.ts"
  - "src/tools/codewiki/code-nav.ts"
  - "src/tools/dispatch-plan.ts"
  - "src/tools/dispatch-runner.ts"
  - "src/tools/monitor.ts"
  - "src/tools/run-script.ts"
symbols:
  - "ToolRegistry"
  - "ToolSpec"
  - "ToolSurface"
  - "registerAllTools"
  - "registerCoreTools"
  - "createContextTool"
  - "createGatewayTool"
  - "codeNavTool"
  - "createMonitorTool"
  - "createRunScriptTool"
  - "runDispatchTool"
  - "describeDispatchPlan"
  - "TOOL_PLACEMENT"
  - "lazyTool"
  - "runScriptToolSurface"
  - "gatewayToolSurface"
  - "codeNavToolSurface"
tests:
  - "tests/contracts/run-script.test.ts"
  - "tests/contracts/code-nav.test.ts"
  - "tests/contracts/gateway-surface.test.ts"
  - "tests/contracts/monitor-steer-tools.test.ts"
  - "tests/contracts/dispatch-admission.test.ts"
invariants:
  - "Every tool spec registers its schema and action class eagerly; implementations load lazily on first run through `lazyTool`, so the policy engine and the prompt compiler see a stable surface before any chunk evaluates."
  - "A gateway call resolves the capability and invokes it through the registry under the capability's own name, so the safety net, autonomy mapping, parking for approval, before/after hooks, result shaping, and the audit row all happen exactly as for a direct call."
  - "Plan-scale dispatch calls (more than one task, compete, council, remote node, or apply_winner) are parked for one plan approval at default autonomy; the rendered plan text and its sha256 are the ask, and approving it approves the whole plan."
validate:
  - "pnpm test"
---

# Tools

## What this area does

`src/tools/` is the surface through which the model reads and mutates the world. Every tool is a `ToolSpec`: a name, a description, a JSON schema, an action class, an execution mode, and a `run` function. The registry (`src/tools/registry.ts`) holds all specs and mediates calls through admission control—capability allowlists, safety policy, skill surface narrowing, observation reservation, and the loop guard.

The system splits into two planes defined by `TOOL_PLACEMENT` in `src/tools/surface.ts`. Direct tools carry their schema attached to every turn's prompt; the model always sees them. Gateway tools sit behind the `gateway` tool's find/describe/call interface and are discovered on demand. Placement changes what the model sees, never what a call is allowed to do: a gateway-placed capability runs through the same admission as a direct call, under its own name and action class.

Heavy tools defer their implementation to first use through `lazyTool` (`src/tools/lazy-tool.ts`). The surface—name, description, parameters, action class, execution mode—is registered immediately and is checked for drift if the implementation diverges from the snapshot. This keeps the policy engine and the prompt compiler stable while the worker's boot graph never evaluates orchestrator-only runners.

## Registration and bootstrap

`registerAllTools` in `src/tools/bootstrap.ts` registers the full orchestrator surface. It first calls `registerCoreTools` from `src/tools/core-bootstrap.ts` to register the stable core tools (read, write, edit, bash, grep, find, ls, context, code_nav, verify, run_script, gateway, and the interactive tools). It then registers the orchestrator-only dispatch controls: `dispatch`, `monitor`, `steer`, and optionally `panes`. Worker registries call `registerCoreTools` directly so their boot graph never evaluates dispatch implementations.

The bootstrap also wires the MCP capability source for the gateway, registers harness extension tools, and binds MCP client teardown to session end and shutdown. The `ToolBootstrapDeps` interface declares the ports the bootstrap needs: `requestSelfCompact`, `captureWorkerContext`, `dispatch`, `bus`, `termination`, `getAgentCatalog`, `getAutonomy`, `dispatchBackground`, `getDecisionBoard`, `competeMuxWorktrees`, `panes`, and `mcpCapabilities`.

`assertRegisteredBuiltinTools` verifies that every builtin declared in `builtin-tool-catalog.ts` is present in the registry, failing closed if a registration is missing.

## Placement: direct vs gateway

`TOOL_PLACEMENT` in `src/tools/surface.ts` is the single source of truth for which tools are direct and which are gateway-placed. Direct tools include the fundamental coding operations (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`), repository understanding (`code_nav`, `context`), executable verification (`verify`, `run_script`), the gateway itself, and the orchestration and interaction planes (`dispatch`, `monitor`, `steer`, `ask_user`, `decide`, `consult`, `artifact`, `limitation`, `tasks`, `ledger`, `panes`).

Gateway-placed capabilities include secondary tools: `evidence`, `git`, `web_read`, `web_fetch`, `clio_docs`, `clio_library`, `data`, `credential_present`, `vision`, and `configure_clio`. Harness extension commands and MCP tools are always gateway-placed by prefix rule.

Two helpers derive surfaces from a capability list. `directSurfaceNames` returns the direct tools from an admitted list, adding `gateway` when any gateway-placed capability was present. `withGatewayForCapabilities` adds `gateway` to a list that reaches behind it, keeping the orchestrator's approved tool signature equal to the one the worker attests.

`effectiveToolCall` unwraps a ledger tool record to the capability it stands for. When a record is a `gateway` call, it resolves the inner capability from `details.capability` (stamped on every gateway result) or from the call arguments (`op: "call"`, `capability`), so a `gateway` row never becomes an opaque entry that hides the artifact, git, or fetch it performed.

## The context tool

`createContextTool` in `src/tools/context/index.ts` is one OBSERVE entry point for material about the working environment. It accepts a `scope` argument and dispatches to one of five handlers:

- **workspace**: returns the session workspace snapshot (git state, files, branches) with a one-line skill catalog pointer. Requires a bound session; errors cleanly in worker registries without one.
- **settings**: returns a live settings snapshot with autonomy, limits, and configuration guidance. Accepts `query`, `offset`, and `limit` for paging. Requires the `getSettings` dep.
- **skills**: lists available skills or loads a requested skill body. Implements the full skill-activation and pending-request policy: model activation under `modelActivation: true`, recipe-bound loading, operator-gated manual-only skills, and marketplace discovery. Annotated with drift detection (`checkSkillDriftBatch`) so a listing shows when installed content no longer matches the recorded hash.
- **recall**: readmits an evicted tool-result body by ref and records a `contextRecall` entry. In worker registries with a `workerRecall` port, delegates to that port. In session registries, folds the working set at the live leaf and resolves the ref through `resolveRecall`.
- **budget**: inspects the current request's native session budget. Returns the budget view as JSON, or an observation-limit error if the view exceeds the available observation bytes.

The `docs` and `library` scopes are no longer handled here; the tool returns an error naming the exact gateway capability to call instead: `gateway(op="call", capability="clio_docs")` or `clio_library`.

Every scope handler reserves observation bytes through `reserveObservation` before doing work, so an exhausted pool answers with the notice and no scope does its work for nothing. The self-cap differs by scope: `OBSERVE_SELF_CAPS.contextSkills` for skills, `OBSERVE_SELF_CAPS.contextWorkspace` for everything else.

The skill load path renders a frame that states the workspace root and the substitution rule before the skill's own prose begins, because skills are portable documents written against another harness. The body is truncated by `truncateHead` to the reservation's call cap, with `fullOutput` carrying the untruncated text when the cap bites.

## The gateway tool

`createGatewayTool` in `src/tools/gateway/index.ts` provides one stable find/describe/call schema through which the model reaches every secondary capability. It is the only path to gateway-placed tools.

**op=find** lists capabilities as JSON with name, kind, description (first sentence), and action class. Accepts `query` for substring filtering, `server` for MCP scoping, and `refresh` for a live MCP catalog. Unfiltered listings over 40 entries are ranked by the `rankCapabilities` port when bound; queries with fewer than 3 hits get related entries from the ranker. MCP discovery launches no server on an ordinary find; only an explicit scoped refresh connects.

**op=describe** returns one capability's full description, JSON parameter schema, and authority notes. For MCP capabilities not held by the registry, it reads from the recorded catalog without launching the server.

**op=call** resolves the capability through the registry and invokes it under its own name. The nested call keeps the outer options (signal, ids, skill policy, progress, park accounting) minus any one-shot approval, which was granted to the gateway call and must not travel to the capability. The result is stamped with `details.capability` for ledger unwrapping.

The gateway's `safetyCall` projection is absent: the gateway itself is a read-class tool, and its inner call inherits the capability's own action class. The `prepareGatewayArguments` hook tolerates weak-model shapes: `args` as a JSON string, `name`/`tool` for `capability`, and a missing `op` inferred from what else was given.

## The code_nav tool

`codeNavTool` in `src/tools/codewiki/code-nav.ts` navigates the structural codemap. It accepts `source` (workspace or clio), `mode`, `query`, and `limit`.

**Modes:**
- **symbol**: finds files by symbol name, returning the symbol records with path, line, kind, and signature.
- **path**: finds files by glob, regex, or substring. Patterns starting with `/` and containing another `/` are treated as regex with flags; patterns with glob syntax (`*`, `?`, `[`) compile through `compileGlobRegex`; everything else is substring.
- **entries**: lists likely entry points, ranked by package.json `main`/`bin` fields first, then role=entry files.
- **outline**: lists a file's symbols in line order.
- **deps**: lists a file's internal imports (resolved to paths) and external modules.
- **dependents**: lists files that import the queried file.
- **wiki**: lists or resolves generated Markdown wiki pages under `.clio-coder/wiki/`.
- **project**: returns bounded orientation, current Git observations, and validated durable operator tasks, with provenance and explicit unknown values. A recorded task status does not establish verification.

**Sources:**
- **workspace**: builds a read-only index on demand through `loadCodewikiForTool` in `src/tools/codewiki/shared.ts`. The codewiki artifact is cached by file identity (dev, ino, mtimeNs, size) in a bounded LRU. The index is built once per codewiki and cached in a WeakMap.
- **clio**: reads the bundled codemap at `dist/assets/codemap.json` from the package root, resolving all paths against it. Cached per package root. Legacy `codewiki.json` is accepted when the canonical artifact is absent. The workspace-only `project` and `wiki` modes are unavailable with this source.

The `regexFromPattern` function strips `g` and `y` flags from user-supplied regexes because the regex is reused across `.test()` calls in a `.filter`, and a sticky/global flag would advance `lastIndex` between calls, silently skipping matching paths.

## Dispatch plan and admission

`describeDispatchPlan` in `src/tools/dispatch-plan.ts` derives the plan view for a dispatch tool call. It normalizes arguments through `prepareDispatchArguments` (the same function the dispatch tool applies), so the admission-time view and the execution-time view agree.

A dispatch call is **plan-scale** when it fans out more than one task, runs a compete or council topology, places work on a remote node, applies a compete winner, or uses approved failover. At default autonomy, plan-scale calls are parked for one plan approval; the rendered plan text and its sha256 are the ask. Yolo never stops.

The rendered plan text includes topology, task count, cost ceiling, deadline, and per-task details (agent, target, model, node, role, failover, routing intent, worktree, council, briefing, verification checks, and legacy path scope lines). The text is deterministic for identical arguments against an unchanged working tree; the hash is a sha256 of the rendered text.

`withResolvedPlanTaskPin` applies a resolved plan task's pinned choices (target, model, node, route approval, agent selection, execution role, dependencies, etc.) to a dispatch request. `withResolvedDispatchPlan` attaches a strict v3 resolved artifact to the arguments under the `__clio_resolved_dispatch_plan` key.

`resolvedDispatchPlanFromArgs` validates and returns the resolved artifact, rejecting unknown keys and malformed structures. The artifact pins effective target/model/node choices and any active route approval into execution. Older artifact versions are rejected rather than interpreted.

## Dispatch runner and execution

`runDispatchTool` in `src/tools/dispatch-runner.ts` executes a dispatch call. It reads a trusted execution snapshot from `admissionState.trustedExecutionSnapshots`, which was registered during admission. The snapshot carries the mode, topology, review/council settings, compete settings, and the normalized requests.

The runner branches on mode:
- **list**: returns the agent catalog.
- **apply-winner**: merges a preserved compete winner, verifying the branch pattern, ownership manifest, and judge decision integrity.
- **parallel/sequential/pipeline**: runs tasks through `runBatch`, `runSequential`, or `runPipeline`.
- **compete**: runs candidates in worktrees, then a judge gate selects a winner.
- **council**: runs members in rounds, then a synthesis gate (judge or vote).
- **review**: runs a builder, then a reviewer gate.
- **fleet**: runs a Scout dependency plan.

Each mode handles timeout and abort signals. A background switch allows the operator to fire a control that backgrounds the dispatch, converting the current run into a detached batch and returning a result with the run ids.

The `completeRun` helper seals the receipt, runs integrity verification, and records the run in the event registry. The receipt carries the run id, agent, target, model, node, tokens, cost, output, verification, and tool activity.

## The monitor tool

`createMonitorTool` in `src/tools/monitor.ts` provides read-only visibility into known dispatched runs. It accepts `run_id`, `run_ids`, `batch_id`, `mode`, and `timeout_ms`.

**Modes:**
- **list**: enumerates this session's runs (newest first, capped at 20). Checks session ownership.
- **status**: reports one run's state, progress counters, budget, council, and trust status.
- **peek**: returns the bounded tail of a run's recent events buffered in this process.
- **tools**: answers what a run executed—its tool calls with outcomes from the event buffer, plus the receipt's per-tool totals.
- **receipt**: returns the stored receipt, integrity-verified.
- **wait**: observes one run for a bounded time until it is terminal or the timeout fires. Never cancels anything.
- **collect**: batch barrier. While runs are in flight, returns a pending snapshot; once all are terminal, returns full results and marks the batch collected.

Every mode checks the row against this session first through `dispatchOwnership`. A run another project dispatched is refused by name rather than reported unknown.

The `durableRunEvidence` function reads one terminal run's durable evidence boundary exactly once. Receipt fields and worker text become renderable only after the existing integrity check succeeds against the ledger envelope. Every failure returns unknown verification plus an explicit note; unauthenticated prose is withheld.

## The run_script tool

`createRunScriptTool` in `src/tools/run-script.ts` runs one script from the workspace with an explicit interpreter, arguments, and working directory, as an observable scientific step.

**Interpreters:** `python3`, `python`, `node`, `bash`, `sh`, `Rscript`, `julia`, `perl`, `ruby`, `octave`. Anything else is refused by name.

**Caps** (`RUN_SCRIPT_CAPS`): 64 arg entries, 4096 bytes per arg, 64 declared refs, 32 env entries, 4096 bytes per env value, 600s default timeout, 21600s max timeout, 8KB result tail, 2KB progress tail, 250ms progress throttle.

**Safety projection:** `runScriptSafetyProjection` serializes the interpreter, flags, script, and arguments as one quoted shell command for the policy engine. The projection is built from the request arguments without touching the filesystem, so admission sees the run the caller asked for whether or not it later validates.

**Execution flow:**
1. Validate the request: interpreter on PATH, script inside workspace root (canonical via `realpathSync`), args and env within caps, cwd inside root.
2. Observe pre-run provenance: script hash, declared input refs, declared output refs (before state).
3. Create a run record directory under `.clio-coder/runs/<runId>/` with stdout.log, stderr.log, and run.json.
4. Run the interpreter through `runCommandVector` with retained tail windows for live progress.
5. Classify the outcome: succeeded, failed, timed-out, aborted, spawn-failed, cleanup-incomplete, pipe-drain-incomplete.
6. Capture post-run output refs and write the manifest.
7. Sweep old run records.

The result carries bounded tails of both streams, the run directory path, and the manifest details. Declared inputs and outputs are provenance only and do not restrict what the script may touch; the safety policy still admits the run as a shell execution.

## Extension seams

**Adding a new tool:** Add the name to `ToolNames` in `src/core/tool-names.ts`. Typecheck then demands entries in `TOOL_PLACEMENT` (`src/tools/surface.ts`), `TOOL_PLANES` (`src/tools/policy.ts`), and `TOOL_CONTRACT_TESTS` (`scripts/check-hygiene.ts`). Register it in `registerCoreTools` (`src/tools/core-bootstrap.ts`), or in `registerAllTools` (`src/tools/bootstrap.ts`) when it is orchestrator-only. For heavy tools, register the schema and policy eagerly and load the implementation on first run through `lazyTool` (`src/tools/lazy-tool.ts`), the way `context`, `code_nav`, `verify`, and `web_fetch` do.

**Moving a tool between direct and gateway:** Change one row in `TOOL_PLACEMENT`. The gateway's find listing, the prompt compiler's attached-schema list, and the worker's admitted surface all derive from this table.

**Adding a new dispatch topology:** Extend `DispatchPlanTopology` in `src/tools/dispatch-plan.ts` and add the corresponding branch in `runDispatchTool` in `src/tools/dispatch-runner.ts`. The plan renderer and the admission snapshot must agree on the new topology's shape.

**Adding a new monitor mode:** Add the mode to the validation list in `createMonitorTool`'s `run` method and implement the handler function. The mode must check session ownership before returning data.

## Things to watch when editing

- **Lazy tool surface drift:** `lazyTool` compares the implementation's snapshot to the registered surface and throws on mismatch. If you change a tool's parameters, action class, or execution mode, you must change the surface registration and the implementation together, or the tool will fail on first use.

- **Gateway placement and allowlists:** A gateway-placed capability that is not on the run's admitted tool surface is refused by the gateway. When adding a tool to `TOOL_PLACEMENT`, also add it to `TOOL_CONTRACT_TESTS` in `scripts/check-hygiene.ts` or the hygiene check will fail.

- **Observation reservation:** All OBSERVE tools reserve bytes before doing work. If you add a new scope or mode to an observe tool, it must go through `reserveObservation` and `finalizeObservation`. The self-cap is per-turn, not per-call, so a tool that does not fit in the remaining pool gets an exhausted error rather than partial work.

- **Dispatch plan determinism:** The rendered plan text is deterministic for identical arguments against an unchanged working tree. If you change the renderer, the hash changes, and any plan approved before the change will not match the new hash. The admission snapshot and the execution runner must agree on the rendered text.

- **Run script path confinement:** All path validation uses `realpathSync` to resolve symlinks. The workspace root is canonicalized once and all subsequent path checks compare canonical paths. If you add a new path argument, it must go through the same canonicalization or a symlink escape becomes possible.

- **Monitor session ownership:** Every monitor mode checks `dispatchOwnership` before returning data. The ownership check uses the session id from `ToolInvokeOptions`. If you add a new mode, it must call `ownershipFor` and `unseenRunError` before accessing the run, or a run from another project will be exposed.

- **Code nav regex flag stripping:** The `regexFromPattern` function strips `g` and `y` flags from user-supplied regexes. If you add a new mode that builds regexes, it must do the same, or a sticky/global flag will advance `lastIndex` between `.test()` calls and silently skip matches.
