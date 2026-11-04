---
title: "Command-line surfaces: the tool gateway"
summary: "How the model reaches secondary capabilities through one find, describe, call and chain schema, and how the gateway hands each call to the registry under the capability's own name. Read this before changing gateway operations, the data or Clio-internal read tools, or chain scheduling."
sources:
  - "src/tools/gateway/index.ts"
  - "src/tools/gateway/chain.ts"
  - "src/tools/gateway/data-tool.ts"
  - "src/tools/gateway/data-surface.ts"
  - "src/tools/gateway/clio-context-tools.ts"
  - "src/tools/gateway/clio-context-surface.ts"
  - "src/tools/gateway/guidance.ts"
  - "src/tools/gateway/mcp-capabilities.ts"
symbols:
  - "createGatewayTool"
  - "gatewayToolSurface"
  - "gatewayCapabilityItems"
  - "runGatewayChain"
  - "renderChainOutput"
  - "createDataTool"
  - "dataToolSurface"
  - "prepareDataArguments"
  - "createClioDocsTool"
  - "createClioLibraryTool"
  - "gatewayExamples"
tests:
  - "tests/contracts/gateway-surface.test.ts"
  - "tests/contracts/data-tool.test.ts"
  - "tests/contracts/worker-gateway-chain.test.ts"
invariants:
  - "A gateway call runs through the registry under the capability's own name, so admission, safety, and audit apply to the capability and not the gateway."
  - "A gateway call on a run with an admitted tool surface refuses any capability outside that surface with one message that does not reveal whether the name is registered."
  - "A chain holds at most 16 steps, rejects nested gateways and self_compact, and runs steps in dependency order; read-class parallel steps run at most four at a time."
  - "A gateway op=find accepts server or refresh only with op=find; describe and call reject them."
validate:
  - "pnpm exec node --test tests/contracts/gateway-surface.test.ts tests/contracts/data-tool.test.ts"
---

# Command-line surfaces: the tool gateway

The gateway is the single tool through which the model reaches every secondary capability: builtins that are not attached to the model's schema, extension commands, MCP server tools, the `data` reader, and the two Clio-internal read tools. A reader needs this page when a capability is not visible in the attached schema, when a gateway operation returns an unexpected refusal, or when changing chain scheduling or argument handling.

## What the gateway does

`createGatewayTool` in `src/tools/gateway/index.ts` returns a `ToolSpec` built from `gatewayToolSurface`. Its schema exposes four operations, listed in `GATEWAY_OPS`: `find`, `describe`, `call`, and `chain`. The `run` function dispatches on `op` to `runFind`, `runDescribe`, `runCall`, or `runGatewayChain`. Any other value returns an error that lists the valid operations.

The module comment states the central rule: a call is not a separate authority path. `runCall` invokes `registry.invoke` with the target capability's name, so the safety net, approval parking, hooks, and audit row apply to that capability. A refused capability refuses the gateway call with the same verdict.

## Composition

`src/tools/core-bootstrap.ts` registers the gateway pieces:

- `createDataTool` is wrapped in a `lazyTool` over `dataToolSurface` and loaded through a dynamic import of `src/tools/gateway/data-tool.ts`.
- `clioDocsToolSurface` and `clioLibraryToolSurface` are registered as lazy tools whose implementations come from `src/tools/gateway/clio-context-tools.ts`.
- `createGatewayTool` is called with `registry` and, when present, `deps.mcpCapabilities`, and is registered as a builtin.
- `gatewayCapabilityItems` is also imported there.

The placement table in `src/tools/surface.ts` decides which capabilities sit behind the gateway. The test `tests/contracts/gateway-surface.test.ts` asserts that `data`, `clio_docs`, `clio_library`, `web_read`, `git`, and `artifact` have placement `gateway`, while `read`, `write`, `edit`, `bash`, `grep`, `gateway`, and others have placement `direct`.

## Argument normalization

`prepareGatewayArguments` accepts the weak-model shapes before validation. It maps `name` or `tool` to `capability` when `capability` is absent, parses a JSON string in `args`, and infers `op` when it is missing: `call` if `args` is present, `describe` if only `capability` is present, otherwise `find`. The inference for `call` is deliberate. The source comment says that reading an arguments-only request as `find` once answered a mis-wrapped call with a discovery listing, which the model took as a successful call. `envelopeHint` returns the corrective message for a call whose `op` or `capability` was nested inside `args`.

## The four operations

**find.** `runFind` rejects an `args` field. It requires `refresh` to come with `server`. With `server` or `refresh` set, it checks the MCP source and, on a restricted surface, refuses a server with no admitted capability using a message that names only admitted servers. It then reserves observation budget through `reserveObservation`. Ordinary find reads the MCP catalog recorded by `deps.mcp.catalog()`, so it launches no server. Only an explicit scoped refresh calls `deps.mcp.refresh`. Registry entries are filtered with `surfaceSpecPlacement` to those placed on the gateway. The results are scored with `discoveryScore` when a query is present. A ranker from `deps.rankCapabilities` reorders an unfiltered listing only when it has more than `GATEWAY_RANK_MIN_LISTING` (40) entries, and it never removes entries. Pages are capped at `GATEWAY_FIND_MAX_ENTRIES` (300), with `nextOffset` carrying the continuation.

**describe.** `runDescribe` requires a top-level `capability`. On a restricted surface a name outside the allowed set returns `outsideSurface`. With no restriction, an unknown name returns the unknown-capability message. A registered direct tool is refused with guidance to call it directly, except `dispatch` and `gateway`. The payload includes `parameters` from `wireParameterSchema`, the action class, the execution mode, and an `authority` list built from `admissionNotes`, `autonomyNote`, and capability-specific notes. For `gateway` itself, the payload adds a `chain` block describing the step and binding rules. An MCP capability absent from the registry is described from its recorded catalog through `describeFromCatalog`, which does not launch the server.

**call.** `runCall` takes `capability` and `args`. On a restricted surface a name outside the allowed set returns `outsideSurface`, which does not reveal whether the name is registered. The name is resolved by `resolveCapability`, which calls `deps.mcp.ensure` for MCP names and refuses direct-placed names unless `allowDirect` is set. Arguments are checked with `validateEngineToolArguments` against the capability's own schema. A validation failure returns an error with one example from `gatewayExamples`. The call then goes through `registry.invoke` with `nested: !allowDirect`, with any one-shot approval removed from the options. A blocked verdict returns `nestedBlockedResult`. An executed verdict returns `nestedExecutedResult` with `details.capability` set to the capability name. `deps.onCapabilityCalled` runs before admission and its exceptions are swallowed.

**chain.** `runCall` also serves as the per-step callee, invoked with `allowDirect` set to true. Chain behavior is described below.

## Chain scheduling

`runGatewayChain` in `src/tools/gateway/chain.ts` runs a plan. `parseSteps` requires between 1 and `CHAIN_MAX_STEPS` (16) steps. Each step needs `id`, `capability`, and `args`, with optional `after`, and no other keys. Ids must match `^[a-z][a-z0-9_-]{0,31}$` and be unique. A step naming `gateway` or `self_compact` is rejected. References of the form `{$from: <step id>, path: [...]}` inside `args` add dependencies. Unknown dependencies and cycles are rejected with a parse error that the gateway returns as `gateway: invalid chain: ...`.

Scheduling happens in waves. A step is parallel only when its spec has `executionMode` `"parallel"`, `baseActionClass` `"read"`, no `safetyCall`, and it is not `context`. Ready parallel steps run through `Promise.all` on at most four at a time (`slice(0, 4)`). Other steps run serially. `bind` resolves `$from` references against successful results only: a reference to a step that did not succeed throws `no successful result for <id>`, and that step settles as a binding failure without running. `resultValue` exposes each result as `output` (text), `details`, and `json` when the output parses.

`renderChainOutput` builds the aggregate text: a status line (`complete`, `paused`, or `failed`), a `Boundary:` line when scheduling stopped, then one section per settled step under a header from `chainStepHeader`. The header format is load-bearing: the source comment says compaction finds a chained skill body directly under this header, so changing the format requires a matching change in compaction.

The tool description for `gateway` (see `gatewayToolSurface` and the `chain` block in `runDescribe`) says scheduling stops at failure, cancellation, skill activation, user interview, or a terminal result.

## Data tool

`createDataTool` in `src/tools/gateway/data-tool.ts` handles `inspect`, `select`, and `validate` for CSV, TSV, JSON, JSON Lines, and SQLite. Its own schema and argument repair live in `src/tools/gateway/data-surface.ts`: `prepareDataArguments` maps `file` and `file_path` to `path`, converts numeric strings, and parses `header` and `columns`. `prepareDataAdmissionArguments` resolves `path` against the workspace before path policy admission, so admission sees the resolved path.

`run` reserves observation budget with `DATA_OBSERVATION_SELF_CAP_BYTES`, then calls `inspectData`, `selectData`, or `validateData` from `src/tools/data/index.ts`. A refusal from `isDataRefusal` releases the reservation and returns `refusalResult`, an error whose message reads `data: <op> refused (<reason>): <message>` and whose details carry the refusal. A successful result goes through `finalizeObservation`, with `countResult` deriving counts. For `select`, `hasMore` sets `truncated` and `next` is `offset=<offset+limit>`. The view label comes from `describeDataView`: `exact`, a combination of `sampled` and `converted`, or `value cut to budget`.

The scientific-integrity rules (large integers reported as literals, sentinels counted rather than converted) are implemented in the readers, not here. This module only reports what the readers return.

Focused test `tests/contracts/data-tool.test.ts` exercises the tool through the gateway. The CSV inspect case asserts `rowCount` 4 and `header` `["id", "temp", "site"]`, and the details label `exact`. The select case uses `offset: 1, limit: 2, columns: ["temp", "site"]` and asserts the rows `[["NaN","B"],["22.0","C"]]` with `next` `offset=3`. The unsafe-integer case asserts that `12345678901234567890` is returned as `{$literal, precision: "unsafe-integer"}`. The refusal test checks that a missing file, a binary file, a missing pointer, and an unknown column each produce a message beginning `data: <op> refused (<reason>)`. The argument-repair case asserts that `file` is accepted as `path` and that `op: "count"` is rejected.

## Clio-internal reads

`src/tools/gateway/clio-context-tools.ts` wraps two former `context` scopes. `createClioDocsTool` reserves `OBSERVE_SELF_CAPS.contextDocs` and calls `runDocsScope` from `src/tools/context/index.ts`. `createClioLibraryTool` reserves `OBSERVE_SELF_CAPS.contextLibrary`, then dynamically imports `runLibraryScope` from `src/tools/context/library.ts`. The `skillMarketplace` flag and the skill loader options are passed through from bootstrap. The surfaces in `src/tools/gateway/clio-context-surface.ts` define the names `clio_docs` and `clio_library`, their parameters, and their `read` action class. Worker registries set `skillMarketplace` to false, so the library read refuses there.

## Examples and guidance

`src/tools/gateway/guidance.ts` validates `metadata.examples` on each spec. `validatedExamples` drops an example that exceeds 768 bytes, has an empty goal, or fails `validateEngineToolArguments`, and it keeps at most 8. `gatewayExamples` returns up to a limit of ready gateway calls, ranked by `discoveryScore` when a query is supplied. A direct-placed spec yields no examples. `capabilityArgumentShape` joins required-argument cues and examples under a 2048-byte budget, and `capabilityStarterArgs` returns a startup example when one is marked `startup`.

## MCP capabilities

`src/tools/gateway/mcp-capabilities.ts` defines the MCP source types (`McpCapabilitySource`, `McpCatalog`, `McpServerListing`, `McpCapabilityMetadata`, and related types) and `createMcpCapabilitySource`. The gateway depends on this module only through its exported interface: `ensure`, `refresh`, `catalog`, `metadata`, `declaredIds`, `ownerIdOf`, `discoveryNote`, and `authorityNote`. This page does not describe MCP internals beyond that interface. The contract tests for MCP discovery include `tests/contracts/gateway-mcp.test.ts` and `tests/contracts/mcp-catalog-source.test.ts`, which this writer did not read.

## Focused tests

- `tests/contracts/gateway-surface.test.ts` checks that every builtin has a placement row, that `data`, `clio_docs`, `clio_library`, `web_read`, `git`, and `artifact` are gateway-placed, and that `read`, `gateway`, and other core tools are direct. It also checks `directSurfaceNames`, which keeps `gateway` in the attached schema.
- `tests/contracts/data-tool.test.ts` covers the data tool cases summarized above, invoked through `registry.invoke` with `op: "call"`.
- `tests/contracts/worker-gateway-chain.test.ts` runs a worker against a fixture server and checks chain outcomes, including that a read or grep step inside a chain grounds a citation as a direct call would, and that a pending or failed step grounds nothing. The test's `SOURCE` fixture and `chain` helper show the step shape `{id, capability, args}`. This writer read only the header and helpers of that file, not its individual assertions.

## Things to watch when editing

- A new gateway operation must be added to `GATEWAY_OPS`, to `gatewayToolSurface.parameters.op`, and to the `run` dispatch in `src/tools/gateway/index.ts`. The `op` enum and the dispatch are two separate places.
- A capability's placement lives in `TOOL_PLACEMENT` in `src/tools/surface.ts`. Moving a builtin between direct and gateway changes what `describe` and `call` return for it, so placement tests in `tests/contracts/gateway-surface.test.ts` are the relevant check.
- The restricted-surface refusal is intentionally identical for an unregistered name and an off-surface name. Changing `outsideSurface` or the unknown-capability message can reveal which names exist.
- `runCall` removes the one-shot `approval` from the options before the nested invocation. Passing it through would apply a grant meant for the gateway call to the capability.
- The chain step header in `chainStepHeader` is consumed by compaction, as the source comment states. Change the format only together with that consumer.
- Chain binding reads only successful results. A reference to a step that failed or was not scheduled settles as a binding failure, so a plan that depends on a failed step does not run that step.
