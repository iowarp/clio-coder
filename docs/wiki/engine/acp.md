---
title: "Agent Client Protocol engine: transport, delegation, tool mediation and commands"
summary: "How Clio speaks the Agent Client Protocol (ACP) both as a server to editors and as a client that delegates work to external ACP peers. Read this before changing the stdio transport, the delegation adapter, the permission mediator or the ACP command allowlist."
sources:
  - "src/engine/acp/transport.ts"
  - "src/engine/acp/adapter.ts"
  - "src/engine/acp/tool-mediator.ts"
  - "src/engine/acp/commands.ts"
  - "src/engine/acp/server.ts"
symbols:
  - "StdioJsonRpcTransport"
  - "createStdioServerTransport"
  - "startAcpDelegationRun"
  - "AcpToolMediator"
  - "ACP_COMMAND_RULES"
  - "acpCommandCatalog"
tests:
  - "tests/extended/acp-transport.test.ts"
  - "tests/extended/acp-delegation-usage.test.ts"
  - "tests/extended/acp-commands.test.ts"
invariants:
  - "Stdio input lines longer than ACP_MAX_INPUT_LINE_BYTES are bounded by the transport; the bound is enforced on buffered input in the stdio transports."
  - "The server transport pauses writes until the output sink drains and closes with an acp_process_error when the sink never drains and the byte budget is crossed, as tested in tests/extended/acp-transport.test.ts."
  - "A delegated ACP peer's permission request is approved only when the shared safety admission evaluator allows it and the peer offers an allow_once option; otherwise it is denied without stalling."
  - "Only ACP_COMMAND_RULES entries are invokable over ACP; the catalog advertises exactly the allowlisted commands, as asserted by tests/extended/acp-commands.test.ts."
validate:
  - "pnpm run test:file -- tests/extended/acp-transport.test.ts"
  - "pnpm run test:file -- tests/extended/acp-delegation-usage.test.ts"
  - "pnpm run test:file -- tests/extended/acp-commands.test.ts"
---

# Agent Client Protocol engine

The `src/engine/acp` directory implements Clio's side of the Agent Client Protocol. It is needed in two directions: serving Clio as an ACP agent to editor clients (`src/engine/acp/server.ts`, launched from `src/cli/acp.ts`), and delegating a turn to an external ACP peer process (`src/engine/acp/adapter.ts`, called from `src/domains/dispatch/extension.ts`). This page covers the transport, the delegation adapter, the tool-permission mediator and the command allowlist. It describes the server only at the level of its exported interfaces; the server file is 7258 lines and its prompt, tool-progress and handoff workflows are not traced here.

## Transport: newline-delimited JSON-RPC over stdio

`StdioJsonRpcTransport` in `src/engine/acp/transport.ts` owns a spawned child process and speaks JSON-RPC 2.0 over its stdin and stdout, one JSON object per line. The constructor spawns the command with `stdio: ["pipe", "pipe", "pipe"]`, and on POSIX sets `detached: true` so the child leads its own process group. The termination scope is `"process-group"` on POSIX and `"child"` on Windows, recorded in the `terminationScope` field.

Outgoing frames are written by the private `write` method, which appends `\n` and drops the frame silently when the channel is closed or stdin is not writable. Incoming bytes are appended to `buffer` by `consumeStdout`, which splits on `\n` and passes each complete line to `handleLine`. `handleLine` ignores lines that do not begin with `{` and routes responses to `handleResponse` and incoming requests to `handleIncomingRequest`.

`request(method, params, timeoutMs)` assigns a numeric id, stores a `PendingRequest` in `pending`, and arms an optional timer. The timer rejects with `AcpTimeoutError` and removes the pending entry. If the child exits while requests are pending, the `exit` handler rejects them all with `AcpProcessError`. A request on an already closed transport throws synchronously with `AcpProcessError`.

The server-side variant, `createStdioServerTransport`, is exercised by `tests/extended/acp-transport.test.ts`. That test shows the two behaviors that define the server transport's output contract: queued UTF-8 frames are delivered in order while the sink pauses until `drain`, and a sink that never drains causes the transport to close with an error whose message matches `output buffer exceeded byte limit`. The overflow case is driven by a `Writable` with `highWaterMark: 1` whose write callback is never called, and the test asserts `closes === 1` and that no `drain` listener remains. The `ACP_MAX_INPUT_LINE_BYTES` constant is the byte budget the test uses.

## Delegation adapter

`startAcpDelegationRun` in `src/engine/acp/adapter.ts` starts an external ACP peer for one delegated run and returns an `AcpDelegationRunHandle`. Its input type `AcpDelegationRunInput` carries the agent recipe, cwd, environment, the safety context, optional telemetry, and read-only or allowed-tool constraints. Its caller in this repository is `src/domains/dispatch/extension.ts`; the module is also imported by `src/entry/orchestrator.ts` and `src/cli/acp.ts`, as shown by the import graph (not verified as call sites beyond the dispatch extension).

The function does the following in order, as read from the source:

1. Resolves the connect and turn timeouts from the agent recipe, falling back to `DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS` and `DEFAULT_DELEGATION_TURN_TIMEOUT_MS`. The source comment states that elapsed turn time alone does not stop a healthy turn; only an explicit positive timeout does.
2. Builds the child environment. An `agent.env` value of the form `{env:NAME}` is replaced by the value of `process.env[NAME]`, and the function throws if that variable is unset or empty. Literal values pass through unchanged.
3. Calls `createStdioTransport`, passing the resolved `terminationGraceMs` and `terminationWaitMs` when the caller supplied them.
4. Creates an `AcpToolMediator` with the safety context, governance mode (defaulting to `"clio-coder-policy"`), and the read-only and allowed-tool constraints, and registers it as the handler for `session/request_permission`.
5. Maps `session/update` notifications through `AcpEventMapper` into run events, and pushes them onto an `AsyncEventQueue`.

Usage reporting goes through `acpUsageSums`, which converts the peer's reported usage into telemetry sums. `tests/extended/acp-delegation-usage.test.ts` pins this mapping. Its first case passes a plain count object `{ totalTokens: 0, input_tokens: 4, costUsd: 0.5 }` and asserts that `usage.input` is a measured value of 4, that `usage.output.unknownCount` is 1, that `pricing.usd.unknownCount` is 1, and that `pricing.pricedBy` is `"none"`. Its second case reads a Clio peer's quantities and asserts that a partial total keeps its known subtotal (`measured: 140` for input, `unknownCount: 1` on the total).

Lifecycle note: `startAcpDelegationRun` sets a `finished` flag and a `cancelTimer`, and exposes a `forceTermination` path through `transport.forceTerminate()`. The source comment states that dispatch owns the event-inactivity watchdog and cancellation cleanup; the adapter does not own that policy.

## Tool-permission mediation

`AcpToolMediator` in `src/engine/acp/tool-mediator.ts` decides every `session/request_permission` the peer sends. `handle(params)` maps the tool call to Clio's tool vocabulary with `mapToolCall`, then selects a decision by the first matching branch:

- If the mapped mutation targets are invalid, the call is denied with rule id `acp:invalid-mutation-targets`. Under `clio-coder-policy` the safety evaluator is still consulted to pick the most severe result for the record.
- `toolGovernance === "agent-managed"` approves with rule `acp:agent-managed`.
- `toolGovernance === "deny-all"` denies with rule `acp:deny-all`.
- An unknown tool is denied with rule `acp:unknown-tool`.
- Otherwise the call goes through `evaluateAdmission` with principal `"worker"`. An `allow` result approves. A `deny` result is denied with a reason derived from `safety_net`, `no_effects`, `read_only` or `tool_scope`. An `ask` result is always denied, because the source comment states that a delegation has no operator to answer an ask.

After a decision of `"approved"`, the mediator still checks that the peer offered an `allow_once` option. If none is offered, the decision is downgraded to denied with rule `acp:no-allow-once`. The source comment states that Clio never selects `allow_always`. The result is recorded through `safety.decisions.recordToolCall` and counted in `requested`, `approved` and `denied`.

The mediator is the only ACP permission path used by delegation: when no telemetry is configured, `startAcpDelegationRun` returns `mediator.handle(params)` directly, and otherwise it wraps the same call. The type `AcpMediatorPermissionResolvedEvent` reports each resolved decision upward through `onPermissionResolved`, which the adapter converts into a `clio_coder_permission_resolved` worker event.

## Command allowlist

`src/engine/acp/commands.ts` exposes a fixed list of slash commands over ACP. `ACP_COMMAND_RULES` is built by flat-mapping `BUILTIN_SLASH_COMMANDS`, dropping any entry whose `acp` field is `false`, and copying the rest with their `acp` metadata. Each `AcpCommandRule` carries optional flags that describe how the command may be invoked: `subcommands`, `streams: "dispatch"`, `injectsUserTurn`, `injectsUserTurnExcept`, `promptTurn`, `promptTurnSubcommands`, `reads`, `sessionOnly` and `readOnlyRefuses`.

`acpCommandCatalog()` projects this list into the descriptors returned to a client. `tests/extended/acp-commands.test.ts` asserts that the catalog has `version` 1, that `ACP_COMMAND_RULES.length` and `catalog.commands.length` are both 15, that `ACP_COMMANDS_CAPABILITY.count` is 15, and that the names are in the order `eggs, skill, mcp, doctor, share, archive, run, delegate, oracle, council, loop, context, tasks, memory, export`. Its refusal helper asserts that a refused invocation throws `AcpRequestError` with `rpcCode` -32602.

`COMMAND_REQUIREMENTS` in the same file maps each command to the host members it needs (for example `share` requires `listWorkerRuns` and `submitOperatorNote`). The `AcpCommandHost` type describes those members. The test file's `host()` helper supplies throwing proxies for `dispatch`, `bus` and `providers`, so a test fails if a command that should not reach them does.

## Extension seams

- New ACP transports or framings belong beside `StdioJsonRpcTransport` in `src/engine/acp/transport.ts`, behind the `AcpJsonRpcTransport` interface.
- A new delegation policy for a peer belongs in `AcpToolMediator.handle`, using the existing `toolGovernance` modes or a new branch with its own rule id. Any new branch must keep the no-operator rule for `ask`.
- Exposing a slash command over ACP means adding its `acp` metadata to the `BUILTIN_SLASH_COMMANDS` entry, since `ACP_COMMAND_RULES` is derived from it, and adding its required host members to `COMMAND_REQUIREMENTS`.

## Things to watch when editing

- `ACP_MAX_INPUT_LINE_BYTES` is the only backstop for a newline-delimited protocol. The source comment in `src/engine/acp/transport.ts` states that without a bound a peer can grow the buffer indefinitely, so changes to buffering must keep the bound.
- The mediator's `ask` branch must stay non-stalling. The current code denies every `ask`, and the reason string tells the peer that no interactive operator exists.
- A delegated child inherits a safe environment that omits provider credentials. Only names listed in `agent.env` with the `{env:NAME}` form are passed through, as implemented in `startAcpDelegationRun`.
- Commit attribution is handled in `StdioJsonRpcTransport`'s constructor. The source comment states that a delegated external harness authors its own commits, so no co-author trailer is claimed for it.

## Related pages

Dispatch, which owns the watchdog and cancellation that wrap this adapter, is documented in [Domains dispatch](../domains/dispatch.md). The safety evaluator used by the mediator is documented in [Domains safety](../domains/safety.md). Slash command behavior in the interactive shell is documented in [Interactive](../interactive.md). The engine index is [Engine](../engine.md).

## Coverage gaps and limits

The server's prompt-expansion, handoff, interview and board-action workflows in `src/engine/acp/server.ts` were not traced; this page describes that file only through its exported interface names. The `src/engine/acp/live-telemetry.ts` and `src/engine/acp/host-members.ts` modules and the `event-mapper` dependency were not read. Focused tests for the mediator's branches (for example `tests/extended/acp-permission-decision.test.ts`) exist in the repository but their cases were not read, so the mediator's per-branch behavior above is taken from source only.
