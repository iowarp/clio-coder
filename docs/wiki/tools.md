---
title: "Tool registration, admission, and document reading"
summary: "How the agent's tool surface is assembled in src/tools (bootstrap, registry, dispatch, and the built-in tool modules), how a call is admitted by the registry, and how the read tool's document renderers window their output. Start here before changing tool registration or the registry's admission path."
sources:
  - "src/tools/bootstrap.ts"
  - "src/tools/registry.ts"
  - "src/tools/read-documents/index.ts"
  - "src/tools/dispatch-runner.ts"
  - "src/tools/run-script.ts"
symbols:
  - "registerAllTools"
  - "ToolBootstrapDeps"
  - "ToolBootstrapHandle"
  - "createRegistry"
  - "ToolRegistry"
  - "ToolSpec"
  - "windowDocument"
  - "renderDocument"
  - "prepareRunScriptArguments"
  - "runDispatchTool"
tests:
  - "tests/contracts/run-script.test.ts"
invariants:
  - "registerAllTools registers the dispatch, monitor, and steer tools only when deps.dispatch is present, and the panes and music tools only when deps.panes or deps.music is present."
  - "The registry's invoke applies a remembered refusal to an identical repeated call within the same turn, keyed by turn, mutation epoch, and call hash, and does not apply that memory to worker principals."
  - "windowDocument returns an error rather than an empty window when an offset is past the end of a rendered document."
  - "prepareRunScriptArguments accepts a JSON-string array or a single string for the array-valued fields and leaves already-normalized arguments unchanged."
validate:
  - "pnpm run test:file -- tests/contracts/run-script.test.ts"
---

# Tool registration, admission, and document reading

This area is the seam between the agent loop and every tool it can call. A reader needs it when they add a tool, change which tools a session advertises, change how a tool call is admitted or refused, or change how `read` renders a notebook, PDF, or archive. The area covers three layers: assembly (`src/tools/bootstrap.ts`), admission (`src/tools/registry.ts`), and per-tool bodies such as `src/tools/read-documents/index.ts` and `src/tools/run-script.ts`.

## Assembly: registerAllTools

`registerAllTools` in `src/tools/bootstrap.ts` is the orchestrator's entry point. Its caller is `src/entry/orchestrator.ts`, which imports the module. It takes a `ToolRegistry` and a `ToolBootstrapDeps` object and does the following in order:

1. It builds the MCP capability source unless `deps.mcpCapabilities === false`. When `deps.mcpCapabilities` is `false`, no child process can be launched through the registry.
2. It calls `registerCoreTools` from `src/tools/core-bootstrap.ts` with the remaining dependencies. The askUser wrapper inside this call records a fleet placement preference when the answer belongs to the placement header question.
3. It registers optional tools whose presence depends on a dependency: `requestSelfCompact` (self-compact), `memoryRecall`, and `jobTool`. The job-monitor tool is registered only when `deps.jobs` is set and `deps.dispatch` is absent.
4. When `deps.dispatch` is set, it registers the dispatch tool (`src/tools/dispatch.ts`) and three lazily loaded surfaces: the monitor (`src/tools/monitor.ts`), the steer tool (`src/tools/steer.ts`), and, when no `agentLedger` is supplied, the ledger tool. The ledger is registered with `placement: "gateway"`, so it is discoverable without its schema appearing on the first request.
5. When `deps.panes` or `deps.music` is set, it registers the panes or music tool. The lazy surfaces are created with `lazyTool`, which defers the module import until the tool is first used.
6. It calls `assertRegisteredBuiltinTools`, then `registerHarnessExtensionTools`. A failing extension is reported through `deps.bus.emit("extension.load_failed", ...)` and does not stop bootstrap.
7. It rewrites each registered spec's `placement` through `coordinatorToolPlacement`, and replaces the `dispatch` spec's model parameters with `coordinatorDispatchParameters()` and `COORDINATOR_DISPATCH_ARGUMENTS`. The source comment states that placement is presentation, not authority.
8. It returns a `ToolBootstrapHandle` whose `close()` closes the MCP clients once. The handle is also bound to the termination coordinator, and to the `session.ended` and `shutdown.requested` bus events, when MCP capabilities exist and a bus is provided.

The `ToolBootstrapDeps` interface, exported from the same file, lists the session services each optional tool needs, such as `dispatch`, `panes`, `music`, `getAutonomy`, and `getDispatchSchemaComposition`. Its doc comments state two constraints: `memoryRecall` is orchestrator-only because only the orchestrator owns a task bank, and `panes` is present only when a pane host answered detection.

The file's own header comment notes that worker registries call `registerCoreTools` directly, so a worker never evaluates the dispatch implementations.

## Admission: the registry

`createRegistry` in `src/tools/registry.ts` builds the `ToolRegistry`. The interface is declared at `src/tools/registry.ts:ToolRegistry`. Its methods relevant here are `register`, `unregister`, `listAll`, `get`, `listVisible` and `listGateway` (filtered by `toolSpecPlacement`), and `invoke`.

The `invoke` method, at `src/tools/registry.ts:createRegistry`, has two branches:

- For a principal of `"worker"`, it calls the internal admission path directly with no remembered-refusal check.
- For every other principal, it first clears the remembered-refusal map when the autonomy level has changed. It then computes a key from the turn id, the mutation epoch for that turn, and `hashToolCall(call.tool, call.args)`. If an earlier call with the same key was refused, the registry returns a blocked verdict built from `repeatedDenialReason` without running admission again. A call with no turn id is never remembered. After a successful `ask_user` answer, the memory is cleared, so the operator's answer can grant what was refused before.

The memory is bounded by `DENIED_CALL_MEMORY_LIMIT`, which evicts the oldest entry. The registry comment states that a refusal is final for the identical call within a turn, that a turnless call is the operator's own command, and that an attended operator's refusal and a worker's refusal are not remembered.

`requestReadRootApproval` is a second entry point. It is invoked by the dispatch tool's `approveExternalRead` callback, which `registerAllTools` supplies. It returns `null` unless the principal is `"main"`, the signal is not aborted, and a permission listener is registered. Otherwise it evaluates a read-only admission for the root with `evaluateAdmission`, parks the call as a permission request, and resolves when the operator answers.

The admission helpers (`prepareToolArgs`, `resolveToolResultDisposition`, `disposeAdmissionArgs`, `applyRegisteredToolClassification`, `withFlowRestrictions`) are module-level functions in the same file. They apply each spec's `prepareArguments`, `resolveResultDisposition`, and `confirmationFor` hooks.

## Dispatch runner

`runDispatchTool` in `src/tools/dispatch-runner.ts` is the body of the `dispatch` tool, invoked after `src/tools/dispatch.ts` creates the tool. It receives the `DispatchToolDeps` (which carry `dispatch`, `getAgentCatalog`, `getAutonomy`, and similar), a `DispatchAdmissionState`, the normalized arguments, and the invoke options. It returns a `ToolResult`.

Its branches, in order, include:

- A compete or winner-application snapshot is refused with an error when `options.turnConstraints.allowedTools` is set, because an allowlisted turn cannot run worktree application.
- A `list` snapshot returns the agent catalog, or an error when no catalog is available.
- Pending gate evidence is recovered before any other work. A recovery failure returns an error and fails closed.
- An `apply-winner` snapshot requires a trusted resolved plan. The winner's branch and cwd must match the approved confirmation, and the operator's approval or YOLO autonomy supplies the authority.

The module contains helpers such as `nextHostValidationAction`, `dispatchBatchSummary`, and `formatDispatchOutput`. This page does not trace their bodies.

## Read documents

`src/tools/read-documents/index.ts` renders the document kinds that the `read` tool sends to it. It exports `DocumentKind` (`notebook`, `pdf`, `zip`, `tar`, `gzip`), `DocumentView`, `windowDocument`, and `renderDocument`. The module header states that the renderers load on first use.

`renderDocument` checks two request fields. A `pages` value is rejected unless the kind is `pdf`. A `member` value is rejected unless the kind is `zip`, `tar`, or `gzip`. It then delegates to `renderNotebook`, `renderPdf`, `renderZip`, or `renderTar`, which live in sibling modules (`src/tools/read-documents/notebook.ts`, `src/tools/read-documents/pdf.ts`, `archive.ts`) not read for this page.

`windowDocument` applies `read`'s line window to the rendered text. It caps each line at `LINE_CAP_BYTES` (8 KiB), appending a `[line cut]` marker. When `request.tail` is set, it returns the last lines, and a `next` hint with an `offset` for the earlier lines when output was truncated. Otherwise it applies `offset` and `limit`. An offset at or past the end of a non-empty document returns `{ error: "offset N is past the end of the rendered document (M lines)" }`. A `next` hint is produced when lines remain after the window. When `request.numbered` is set, each line is prefixed with its one-based number and `" | "`.

No focused test for `windowDocument` or `renderDocument` was found in this search. The search covered `tests/` for those symbol names.

## Other tool modules

The following tool modules are referenced from the anchor set. This page describes them at the level of their exported symbols only, and they are not traced here:

- `src/tools/ask-user.ts` exports the question, answer, and decision types. Its registration in `src/tools/bootstrap.ts` goes through `askUser` in `ToolBootstrapDeps`.
- `src/tools/consult.ts` exports `CONSULT_LIMITS`, `ConsultDeps`, and `createConsultTool`. `ConsultDeps.systemOne` is the session's System One instance. Its limits are the constants shown in that file.
- `src/tools/task-worktree.ts` exports the task worktree state, receipt, and recovery types. Its lifecycle is not traced here.
- `src/tools/codewiki/` contains `src/tools/codewiki/code-nav.ts`, `src/tools/codewiki/code-nav-surface.ts`, and `shared.ts`. These back the `code_nav` tool, and this page does not trace them.

## Run-script argument normalization

`src/tools/run-script.ts` exports `RUN_SCRIPT_INTERPRETERS`, `RUN_SCRIPT_CAPS`, and `RUN_SCRIPT_DEFAULT_INTERPRETER_ARGS`. The default interpreter arguments are `-u` for `python3` and `python`, so output is unbuffered, and no arguments for the other interpreters.

`prepareRunScriptArguments` normalizes the array-valued fields `args`, `interpreter_args`, `inputs`, and `outputs`. A JSON string beginning with `[` is parsed. A plain string is converted to a one-element array. The function returns a new object and leaves the input unchanged. The focused test `tests/contracts/run-script.test.ts` (in the `run_script: argument normalization and safety projection` block) calls it with `{ args: '["a", "b"]', inputs: "one.txt", outputs: "", env: '{"K":"v"}' }` and asserts `{ args: ["a", "b"], inputs: ["one.txt"], outputs: [], env: { K: "v" } }`. A second assertion shows that already-normalized input is returned unchanged.

`runScriptSafetyProjection` at `src/tools/run-script.ts:runScriptSafetyProjection` projects the run as one quoted shell command for the policy engine. The same test file asserts that projection for `{ interpreter: "python3", script: "a b.py", args: ["x'y"], cwd: "sub" }`.

## Things to watch when editing

- Placement is presentation only. `coordinatorToolPlacement` decides what the model sees, and `invoke` runs any registered spec by name. Changing a placement does not change admission.
- A dispatch-gated tool is registered only when `deps.dispatch` is present. A change that moves a tool out of that block changes what a session without dispatch can call.
- The remembered-refusal memory is per turn and per call hash. A change to `hashToolCall` or to the mutation epoch changes which repeated calls are answered from memory.
- `registerAllTools` calls `assertRegisteredBuiltinTools` before registering extensions. A new built-in that bootstrap does not register will fail that assertion, which is a design guard, and its specific rule is in `src/tools/core-bootstrap.ts`, not read here.
- Worker registries must not import dispatch implementations. The bootstrap header states that workers call `registerCoreTools` directly for that reason.

## Coverage notes

The admission path, the dispatch runner's enforcing branches, and the read-document windowing were read from source. The bodies of the task-worktree, ask-user, consult, and codewiki modules were not traced, so their behavior is described only through their exports and is not claimed here.
