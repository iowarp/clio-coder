# Clio Coder

Clio Coder is a TypeScript/Node.js project. Coding agent for HPC and scientific-software developers, part of IOWarp's CLIO ecosystem of agentic science.

## Conventions

- Local imports end in `.js`. Tests use `node:test`. Avoid `any` without a tracking issue.

## Context retrieval

The codewiki currently indexes 942 source files. Start orientation with these indexed entry points: `src/cli/index.ts`, `src/domains/agents/index.ts`, `src/domains/components/index.ts`, `src/domains/config/index.ts`, `src/domains/context/bootstrap.ts`, `src/domains/context/index.ts`, `src/domains/dispatch/index.ts`, `src/domains/eval/index.ts`. Use `code_nav` (modes: entries, path, symbol) before broad reads when the task is navigational.

## Repository shape

Largest indexed areas: src/domains (401), tests/contracts (262), src/interactive (89), src/cli (48), src/tools (45), src/engine (40), src/core (35), benchmarks/community (9). Treat this as an orientation hint, not a complete file map; refresh the codewiki after structural edits.

## Verification expectations

Before handoff, run `npm run typecheck` and `npm run lint` for TypeScript and style checks. Run `npm run build` after CLI, worker, packaging, or generated-dist changes. Use targeted checks for narrower risk: `npm run test:contracts`, `npm run test:smoke`, `npm run check:boundaries`. Run `npm run test` when behavior crosses domains, tool contracts, smoke flows, or boundaries. Use `npm run ci` for the full local gate before committing broad or shared behavior changes.

## Context artifacts

`CLIO.md` is the versioned, human-owned project handbook and should be reviewed like source when intentionally changed. `.clio/codewiki.json`, `.clio/state.json`, `.clio/proposals/`, and `.clio/handoffs/` are ignored local context-engine artifacts. Do not commit `.clio/*` unless the user explicitly asks to force-add a shared artifact. `clio context init --propose` writes ignored drafts; `--apply` updates from the existing handbook; `--rewrite` generates a fresh handbook from repository structure and sibling context.

## Configuration lifecycle

`settings.yaml` is validated directly against the current schema. Lifecycle commands do not transform removed settings keys.

## Middleware

Middleware hook budgets are strictly phase aware through `DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS`.

## Providers

Provider authentication is exposed through `providers.auth` and persisted through `openAuthStorage()`.

## Model discovery CLI

`clio models` probes live targets by default. The `--offline` flag disables live probing. The former `--probe` and `--no-probe` flags are not supported.

## Context initialization

`clio context init` uses model-driven exploration by default. `--heuristic` is the sole flag for deterministic generation.

## Remote marketplace cache

Remote marketplace cache files require explicit finite `listingTimestamp` and `detailTimestamp` fields. Invalid cache files are refreshed from the remote marketplace.

## Session persistence

Session metadata must declare format version 3. Earlier session formats are rejected and operators must remove the session directory before starting a new session. The ledger accepts only structured `SessionEntry` JSON lines with a `kind` discriminant.

## Evaluation and evidence

Stored eval artifacts require complete `clio`, `environment`, and `paths` provenance blocks. Evidence views render only provenance fields carried by sealed receipts and omit absent fields.

Eval token accounting is observed, never assumed. `src/domains/eval/metrics/token-stream.ts` folds provider usage out of a runner's live stdout as it arrives, so truncation of the operator-facing artifact cannot erase it. A runner that observed no usage emits `tokens.measured: false` and no counts at all, and reports say how many runs the total covers rather than printing a zero for work they could not see.

## Process-safe dispatch admission

- `src/domains/dispatch/capacity-lease.ts` is the durable, expiring global and per-node capacity authority. Lease acquisition, retry rebinding, heartbeat, drain state, and reservation transfer are serialized by one cross-process state lock. The lease bound fails admission closed rather than dropping a lease, and lease reclamation needs owner-liveness evidence wherever a process birth token cannot prove death.
- `setCapacityDraining` is the operator's machine-wide drain. It is TTL-bounded so an abandoned drain cannot wedge the host, and process shutdown never writes it; a shutting-down bundle drains its own admission controller instead.
- `src/domains/dispatch/admission-queue.ts` owns bounded deterministic priority/FIFO ordering, finite queue deadlines, cancellation, and reserved plan-peak admission. A plan slot belongs to an assignment rather than an attempt, so a retry never queues behind itself.
- Placement spreads work by durable lease usage read through `FleetRegistry.bindActiveWorkers`, then by declaration order. That preference is advisory: leases decide capacity under the lock, and a pinned node that is momentarily full is queued rather than refused.
- A retry rebinds its reservation member to the node and cost bound it actually resolved, so a costlier recovery route cannot escape the plan's aggregate ceiling.

## Dispatch routing intent

- `src/domains/dispatch/routing-intent.ts` strictly parses the model-facing routing object, applies shadow-balanced defaults, preserves exact route pins as fail-closed manual intent, and evaluates cost, deadline, quality, capability, and locality hard bounds.
- Plan artifacts and receipt integrity v15 seal normalized routing intent. Candidate envelopes remain coordinator-authored; route explanations are bounded projections of the sealed decision and never accept task text, prompts, endpoints, or credentials.

## Joint route resolution and activation

- `src/domains/dispatch/joint-route-resolver.ts` purely enumerates the bounded agent, target, model, runtime, and node cross-product for the requested execution role. It fails explicitly on universe overflow, applies hard filters before deterministic Pareto ranking, and bounds only the approved fallback projection.
- Shadow remains the default. Active routing is enabled only for exact role/posture pairs named by `routing.activeRoles` and `routing.activePostures`, and only exact routes that pass `evaluateRouteReadiness` may execute. No-ready-candidate, manual-pin, and `failover: none` paths fail closed rather than reviving the fixed route.
- `routing.agentAutomation.activeAgentRoles` separately activates exact agent/role pairs; its default is empty. Agent automation has its own per-agent/per-role readiness report, and authority, tools, skills, result contract, locality, and governance are hard filters before joint tuple scoring.
- Route history v3 aggregates by capability (agent/spec/role/target/model/runtime/node/thinking). Tool-surface or endpoint drift invalidates a bucket; prompt wording and unrelated settings changes do not. Earlier history files are retired rather than read or merged.
- Shadow recommendations never change execution. Observer failure seals a fixed one-candidate decision on the production receipt.

## Dispatch routing quality

- `src/domains/dispatch/route-quality.ts` is the pure reducer for integrity-valid receipt, gate, and eval evidence. Descriptive receipt verification never establishes routing quality.
- `src/domains/dispatch/route-history.ts` is the bounded durable estimator source. Receipt integrity requires a run-local `quality` block; later gate and eval results link by authenticated receipt digest instead of mutating receipts.
- `resultContractWasDue` is the only authority for conformance labeling. Runs that never reached their declared postcondition seal `not-reached`, retain contract identity for replay, and contribute no quality label.

## Strict agent recipes

- `src/domains/agents/recipe-schema.ts` is the only versioned frontmatter schema; malformed custom recipes are quarantined with `AgentsContract.diagnostics()` and builtins fail startup.
- `src/domains/agents/result-contract.ts` validates typed terminal contracts and owns each contract's wire shape. Result conformance is sealed in receipt quality facts, while only correctness-bearing contracts can label routing quality.
- The admitted recipe's contract rides the WorkerSpec. The worker validates its own terminal result and spends up to `RESULT_CONTRACT_REPAIR_LIMIT` bounded repair rounds, replaying the validator's reason, the accepted shape, and this run's live-read anchors; exhausting them fails the run with `result_contract_exhausted`. The orchestrator's sealed validation stays the authority.
- A `scout-report` carries findings as `{claim, path, line}`. Grounding is structural, not a regex over prose, and a split recommendation is the one case that carries subtasks instead of findings.
- Citation grounding needs the run's own read spans, which exist only in the worker. Where `observedReadRanges` is supplied, a cited line must fall inside a span this run actually read, so an estimated line number cannot pass as observation. The orchestrator revalidates without those spans and checks shape and file/line existence; a grounding failure has already ended the run at the worker.

## Engine boundary

- `src/engine/types.ts` is the one place pi types enter the codebase.
  `EngineModel` is the erased `Model<Api>` view every consumer holds;
  `Model<never>` and the `as unknown as Model<...>` casts it forced are gone.
- No file outside `src/engine/**` imports `@earendil-works/*`, type-only
  included. Domains take their shapes from the engine barrel.
- `createEngineAgent` is the only agent construction site and owns the default
  stream function that pi 0.83 requires explicitly.
- `src/engine/oauth.ts` keeps a Clio-owned OAuth registry adapting pi's
  per-provider `ProviderAuth.oauth` flows; pi's global registry is gone
  upstream. `EngineOAuthProvider.getApiKey` is async.

## The chat loop

- `src/interactive/chat-loop.ts` is the turn's state machine and the ChatLoop
  public surface. It composes single-owner modules that coordinate through one
  shared `ChatTurnState` (`src/interactive/turn-state.ts`): `turn-runtime.ts`
  (target resolution, hot-swap, agent construction, run-event enrichment),
  `turn-context.ts` (prompt compile cache, snapshots, compaction),
  `turn-recovery.ts` (overflow compact-and-retry, transient retries),
  `turn-queues.ts` (steer/follow-up mirror, stranded-steer resubmit),
  `turn-persistence.ts` (every ledger append), `turn-middleware.ts` (turn
  hooks and the reminder buffer).
- `runAutoCompact` in `turn-context.ts` is the one compaction entry point.
- `ChatLoop.whenSettled()` resolves when the in-flight submit has fully
  settled. Coordinated shutdown awaits it in the drain phase, so a
  `session.append` after session stop is impossible by ordering rather than by
  catching the throw.

## Notices

- Notices are the typed `notice` ChatLoopEvent variant carrying a `surface`
  discriminator (`transcript` or `footer`). They are never assistant messages,
  never carry usage, and never end a run.
- Headless result derivation keys on event types and stop reasons, never on
  text prefixes. An interrupted turn (notice keyed `turn.interrupted`) exits
  nonzero with its abort reason even when partial assistant text landed.

## Headless runs

- `src/cli/modes/json-stream.ts` is the one projection from chat-loop events to
  the `--json` wire stream, and the stream is append-oriented: every piece of
  content crosses once, as an increment while it streams and as one completed
  message when it lands. `message_update` is dropped because its increments are
  already published as `text_delta` / `thinking_delta` and its message is the
  partial form of the `message_end` that follows. Deltas carry the increment
  and never the growing partial text, `agent_end` carries its segment's usage
  and message count instead of the transcript, and `turn_end` keeps its
  assistant message and drops the tool results already streamed.
- Usage is accrued once per completed assistant message at `message_end`, which
  is the one event that reports a message's tokens exactly once. A headless turn
  spans several agent segments, so segments sum and no consumer may key on the
  last one.
- Every headless main-agent run seals a receipt, the interrupted ones included.
  A signal exits the process from inside the shutdown coordinator, so the drain
  phase seals the receipt and the turn's own completion path seals the same
  outcome. Interruption is read from the coordinator rather than won by a race:
  the outcome is `canceled` with the exit status the process reports.

## Tool substrate

- `src/tools/agent-tools.ts` is the one agent-tool adapter, owned by the
  registry. The orchestrator and the worker both resolve their surface here,
  so the attested tool signature and the executable surface are computed by
  the same `effectiveToolNames` narrowing. `src/engine/worker-tools.ts` keeps
  only worker-specific construction.
- Tools are keyed by the `ToolName` union with no alias table;
  `prepareArguments` normalizers are the only leniency layer.
- The orchestrator's effective settings view is memoized on the config
  snapshot identity plus a session-state generation counter, because tool
  admission resolves autonomy through it on every call.
- `resolveEffectiveAutonomy` / `resolveBaselineAutonomy` in
  `src/entry/orchestrator.ts` are the one effective-autonomy resolution.

## Boundaries

Enforced by `npm run check:boundaries`:

1. Only `src/engine/**` may import `@earendil-works/pi-*`, type-only included.
2. `src/worker/**` never value-imports `src/domains/**` except the worker-safe
   provider runtime rehydration modules.
3. `src/domains/<x>` never imports `src/domains/<y>/extension.ts` for y != x.
4. `src/tools/**` never imports `src/interactive/**`; the tool substrate is
   surface-agnostic.
5. The chat loop's turn modules never import `src/entry/**`; the entry point
   composes the loop, never the reverse.

## Worker runtime

Worker processes accept only WorkerSpec version 3 with a concrete `budget` block and a `settingsFingerprint`. Runtime budgets are inherited directly from the admitted worker specification.

## Worker protocol and attestation

- `src/worker/protocol.ts` is the one wire schema: lane bounds, frame parsers that check byte length before JSON parsing, and the attestation shape. `src/domains/dispatch/worker-protocol.ts` adds the orchestrator half, which is fingerprint computation, attestation admission, the bounded event queue, and the typed `WorkerChannelFailure`.
- The bulk lane is worker stdout and the control lane is marked stderr. Announce, heartbeat, steer acknowledgements, and cancellation acknowledgements never share the bulk queue, so a flood cannot delay them.
- The orchestrator event queue is bounded and drops only display frames. Receipt-bearing frames are never dropped.
- A worker attests protocol version, pid, process-group id, host, settings fingerprint, WorkerSpec digest, runtime, target, endpoint identity hash, wire model, effective tool signature, and bounded resource facts before any model call. Any drift from the approved identity kills the worker. Unknown resource values are explicit and never optimistic.
- Local and remote workers lead a process group and abort escalates against the whole group.
- `src/domains/dispatch/route-facts.ts` evaluates node-scoped target facts. Evidence from one node never answers a question about another, and unknown cannot satisfy an active hard requirement. Doctor records these facts per node through the fleet preflight store, which is version 2.

## Execution plans and fleets

- `src/domains/dispatch/execution-plan.ts` compiles orchestration into the one strict version 4, deterministic, hashed `ExecutionPlan` DAG and computes capacity-bounded waves. Steps are discriminated by kind. Every agent task carries requested and approved authority; the scheduler refuses a missing grant.
- `src/domains/dispatch/execution-scheduler.ts` performs whole-plan preflight and reservation before spawning, then admits dependency-ready waves with stop/continue semantics.
- Fleet contracts are strict DAGs with stable step ids, explicit dependencies, scopes, and `maxWorkers`; authenticated terminal outputs cross edges through bounded structured handoffs. Version 1 is agent-only; version 2 may also carry code steps; version 3 may also carry bounded loops and commit steps; version 4 declares and enforces per-step write boundaries.
- Logical work is named by assignment id. Terminal attempts are named separately as terminal run ids; `dispatchBatch` has no `runIds` compatibility alias.
- Resolved dispatch plans are strict version 3 and require an explicit deadline field (`number` for fleet plans, `null` otherwise). Older or partial forms are rejected.

## Deterministic code steps

- A `code` step runs a command id declared by the repository in `.clio/fleets/commands.yaml`, never a shell string an agent authored. An unknown id or a missing registry fails contract validation, so an unconfigured repo cannot pass a phase that never ran anything.
- `src/domains/dispatch/code-step.ts` runs the command unattended: argv from the registry, fixed cwd, closed environment allowlist, bounded timeout, byte-capped capture, no stdin and no permission prompt. It returns the typed `code-report` result contract.
- A code step is a plan node outside worker admission. It consumes no capacity lease, carries no execution role or authority grant, and never reaches route history or the routing quality reducer. `code-report` is always `unmeasured` quality, and no agent recipe or Scout subtask may declare it.
- Under `onFailure: continue`, a failed code step's report still crosses its outgoing edges. The red suite's verbatim output is the input to the step that repairs it.
- Provenance is recorded per run under `code-steps/<rootId>/` in the Clio state directory, beside the run ledger rather than inside it: a subprocess has no agent, runtime, token, or route facts to record there.

## Bounded loops and the shipped SDLC chains

- A `loop` step declares `maxAttempts` (1..`FLEET_LOOP_MAX_ATTEMPTS`), a check, and an agent repair. The bound is declared, never inferred; contract validation also refuses a dependency cycle, a generated-id collision, and a commit whose message source it does not depend on.
- `src/domains/dispatch/fleet-plan.ts` unrolls each loop at compile time into `maxAttempts` conditional verifications and one fewer repair, so the plan stays one deterministic hashed DAG with whole-plan admission and a receipt per attempt. The scheduler decides only whether a declared node is still needed; a resolved loop reports its later nodes as `unneeded` rather than skipped or failed.
- An edge out of a verification is answered by the loop, never by that run's exit status: a gate agent that ran perfectly and returned `fail` leaves its loop unresolved and blocks every dependent. A repair attempt is `recovery` and enters the ledger as attempt `n`.
- Agent-checked loops reuse `decideReviewGate`; there is no second revise mechanism. Every cycle stages and materializes a `GateDecisionArtifact`, and the repair receives the gate's findings instead of the reviewer's raw transcript. Spending the bound without a pass reports `loop_bound_exhausted`.
- Staleness is scheduler-enforced. A verification node's green measures the workspace at completion; any later workspace step that is not itself a verification or a commit invalidates it, and the verification re-runs before a dependent may treat it as satisfied, up to `STALENESS_REVALIDATION_LIMIT`. Only deterministic verifications are revalidated: re-running a model gate is a dispatch that must be declared.
- A commit is a code step with `commitFrom`, whose message is the first listed candidate that ran and authored `commitMessage` on its terminal contract, falling back to `clio(<rootId>): ...`. Registry argv binds whole-token `{{name}}` placeholders only, and an empty diff fails the step rather than recording nothing.
- `src/domains/agents/fleets/` ships `build-test`, `build-review`, and `sdlc`; a project `.clio/fleets/<name>.md` shadows a builtin of the same name. They name registry command ids, so a repo with no `commands.yaml` gets a hard error rather than a green placeholder.

## Per-step write boundaries

- A tool permission level is a capability list; `writes` is a boundary, and they are not the same thing. `src/domains/agents/write-boundary.ts` owns the grammar: repo-relative POSIX path prefixes, an entry ending in `/` covering the subtree, no globs, no `..`, no absolute paths. `readonly` is the empty allowlist.
- Enforcement is detect-and-rollback, never sandboxing. Nothing prevents a write. `src/domains/dispatch/write-boundary.ts` snapshots the checkout before a window runs, diffs it after against the pinned baseline commit, rolls back what was not allowed, and fails the step with `writes_boundary_violation` naming the offending paths and the declaration. Confinement an agent cannot escape needs OS-level isolation, which this does not provide.
- Boundaries are opt-in by contract version 4 and are then total: every workspace step declares a non-empty `writes` and every `readonly` step declares nothing. A `writes` key under an earlier version is refused by name rather than ignored.
- Rollback restores only unauthorized paths and only from content git already has. A path that was already dirty when the snapshot was taken cannot be restored, so the step fails with `rollback-incomplete`, the working tree is left exactly as the step made it, and the record says which paths and why.
- Attribution is per scheduling window, because fleet steps share one checkout. `compileExecutionPlan` therefore refuses a wave that schedules more than one step with a non-empty allowlist, and refuses a wave that mixes boundary-declaring steps with undeclared ones. A readonly step may run beside the wave's one writer.
- Enforcement sees what git sees, so an ignored path is outside it: the repository decides what counts as its content. The one subtraction is Clio's own state directory when it sits inside the workspace, because receipts, code-step logs, and verdicts are the orchestrator's journal rather than the step's writing.
- Enforcement is orchestrator-side and fails closed: a plan that declares a boundary the scheduler cannot verify is refused before any spawn, and so is a declared boundary in a non-git workspace or one that leaves the workspace through a symlink. Verdicts are sealed under `write-boundaries/<rootId>/` in the Clio state directory, beside the run ledger, each carrying its own digest and the baseline commit it was computed against.

## Transactional attempts and Scout escalation

- `src/domains/dispatch/workspace-transaction.ts` owns one baseline-pinned worktree group per editing assignment. Attempts never share a checkout. Apply eligibility is decided from outcome, receipt integrity, result conformance, and quality gate before repository mutation, then protected artifacts, ancestry, and destination cleanliness are rechecked on disk.
- A refused winner remains recoverable in its worktree with operator instructions; closing a transaction with an unapplied winner is forbidden.
- Scout split results are strict typed data: at most four subtasks with stable ids, dependencies, expected result contracts, and requested authority. The coordinator validates the DAG and compiles it; embedded routes, agents, deadlines, cost, or other control fields are rejected.
- Read-only-to-editing transitions require an authenticated operator plan approval or already-granted full-auto authority. All Scout steps share one absolute deadline; cost, deadline, route identity, result contract, and authority are rechecked before any worker spawns.
- Recovery may change agent only for a typed model-quality decision inside the approved active envelope. Cooldown and infrastructure recovery preserve the owning agent.

## Execution roles and quality gates

- `src/domains/dispatch/execution-role.ts` owns the one `ExecutionRole` union (`builder`, `reviewer`, `judge`, `researcher`, `verifier`, `recovery`), its derivation from strict recipe facts, the gate decider default, and the route correlation and independence policy.
- The role is required and typed on every dispatch request, ledger envelope, receipt, route candidate, plan task, route decision, and route-history key. Route statistics never mix roles, and any attempt after the first is `recovery`.
- Review and compete gates default to the builtin `verifier` and never fall back to the builder agent. Topology roles override recipe defaults, and a gate decider's postcondition is the gate result contract rather than its own recipe contract.
- Gate deciders answer typed contracts, not trailing prose. Review uses the Slice 2 `verifier-report`; `revise` is the coordinator's bounded continuation policy in `decideReviewGate`, not a verdict a model authors. Compete uses the judge gate-result schema in `src/domains/dispatch/gate-decisions.ts`.
- `GateDecisionArtifact` is v2 and seals route correlation across agent, target, model family, runtime, and node. Independence is a deterministic soft preference among already-eligible routes; it never bypasses a hard constraint or quality floor, and a correlated gate is reported rather than hidden.
- Every gate decision crosses the staged durable boundary (`stagePendingGateDecision` then `materializePendingGateDecision`); there is no direct compatibility writer.
