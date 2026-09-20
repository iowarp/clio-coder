# Canonical event coverage

## Framing (from the source, verbatim)

> The event bus is grouped below so new upstream work can expose a small, sanitized projection rather than dumping raw bus payloads across ACP.

The audit's architectural finding, also verbatim:

> The in-process harness bus has **41 canonical channels**, including dispatch, context, capacity, cost, safety, config, compaction, middleware, status, and shutdown facts. **Thirty-five of those channels are not public ACP events today.**

**Verified 2026-09-20: the bus now has 47 channels** (`BusChannels` in `src/core/bus-events.ts`), and the ACP forwardable allowlist has **7 kinds**, not 6. So the correct sentence today is: *47 canonical channels, 40 of which are not public ACP events.*

## The ACP forwardable allowlist (authoritative, `src/engine/acp/server.ts:344-352`)

```ts
const ACP_FORWARDABLE_EVENT_KINDS = [
	"safety.loopBlocked",
	"dispatch.enqueued",
	"dispatch.started",
	"dispatch.progress",
	"dispatch.completed",
	"dispatch.failed",
	"accountability.evidenceReady",
] as const;
```

The mechanism, verbatim from the source comment: *"Nothing outside this list is forwardable: the list is the allowlist, and a client's requested kinds are intersected with it rather than trusted."* A client requests kinds at `initialize`; `ACP_MAX_REQUESTED_EVENT_KINDS = 16` and an over-long list **refuses the whole opt-in**. Dispatch frames are bound to the **session**, not to a turn, because a detached run settles after the turn that started it returns.

Sanitization constants on that path: `ACP_MAX_DISPATCH_TASK_PREVIEW_BYTES = 160` (control-character-stripped prefix with the standard truncation marker; the exact task never leaves the process), `ACP_MAX_DISPATCH_ID_BYTES = 128`, `ACP_MAX_LIVE_TOOL_CALLS = 128`, `ACP_MAX_REPLAY_TOOL_CALLS = 8192`.

## THE 14-FAMILY TABLE (verbatim, with a 2026-09-20 verification column)

| # | Bus group | Channels | GUI coverage | Verified against `src/core/bus-events.ts` |
| -: | --- | --- | --- | --- |
| 1 | Session | `session.start/end/parked/resumed/turn_switched` | Functional session operations are wired, but these lifecycle events are not public. Branch/turn switching has no GUI. | **Accurate.** All five exist. `SessionParkReason` = `create_new\|resume_other\|fork\|switch_branch\|close\|shutdown`; `SessionResumeVia` = `resume\|switch_branch`. `session.turn_switched` carries `{sessionId, turnId, at}` and exists specifically so caches keyed on session id alone know their fold is stale — a GUI that caches per session **must** subscribe to it if `/tree` ever lands. |
| 2 | Domain | `domain.loaded/failed` | **Upstream boundary**; useful in diagnostics, not the notebook. Never forward raw `error`. | **Accurate, and the warning is enforced by the type.** `DomainFailedPayload.error` is typed `unknown` — "the caught value as-is; loaders catch unknown and rethrow after emitting." Never serialize it. |
| 3 | Config | `config.hotReload/nextTurn/restartRequired/reloadFailed` | Safe patch response is wired; live change/reload classification is absent. Sanitize settings out of the event. | **Accurate, and the warning is load-bearing.** `ConfigChangePayload` is `{diff: ConfigDiff, settings: Readonly<ClioSettings>}` — **the whole settings snapshot, credentials included.** Forward only `diff` (`{hotReload[], nextTurn[], restartRequired[]}`), which is exactly the path list a GUI settings page needs to know what changed under it. `ConfigReloadFailedPayload.message` is already pre-formatted by `formatSettingsFailure` to one line, no stack, and is emitted on transitions only (`null` clears). |
| 4 | Permission | `permission.requested/resolved` | Standard ACP permission is partial; richer policy/escalation provenance is absent. | **Accurate and now fully specified.** `PermissionRequestedPayload` carries exactly the fields the parity matrix's "Permission overlay: **Partial**" row is missing: `tool, actionClass, origin, axis, reasons[], ruleId, posture, rejection{short,detail,hints[]}, policySource, reasonCode, requestedBy, requestId, agentId, summary, target (sanitized one-line preview), timeoutMs, fallback ('deny'\|'fail'), escalation`. `requestedBy` is the worker run id, present only when dispatch republishes an escalate-posture worker's parked ask. `PermissionResolvedPayload` = `{status: 'granted'\|'denied'\|'expired', requestId, origin, decidedBy, tool, actionClass, reason, requestedBy, fallback, at}` — only `status` is guaranteed. **This is the single highest-value unbuilt ACP extension for the GUI's approval UI.** |
| 5 | Safety | `safety.classified/blocked/allowed/loopBlocked/toolBudgetExceeded` | Only `loopBlocked` is public and wired. | **Accurate.** `LoopBlockedPayload` = `{tool, repeatCount, blocksThisTurn, budget, interrupted, disposition, at, turnId?}` with `LoopBlockedDisposition = 'block'\|'lockout'\|'stop'`. The three dispositions mean different things and a GUI must not collapse them: `block` is a per-call block below budget (warn notice); `lockout` disables tools for the rest of the turn so the model answers from what it gathered, **and does not cancel the turn** (`interrupted: false`); `stop` cancels. `ToolBudgetExceededPayload` = `{tool, callsThisTurn, softBudget, hardCeiling, interrupted, at, turnId?}`. `SafetyBlockedPayload`/`SafetyClassifiedPayload`/`SafetyAllowedPayload` carry `{tool, actionClass, ruleId?, posture?, policySource, reasonCode}` (+`reasons[]` on classified, +`rejection` on blocked). |
| 6 | Provider | `provider.health` | Explicit GUI target probe is wired; unsolicited health transitions are absent. | **Accurate.** `{id, status: TargetStatus}` after every probe/disconnect. Trivially safe to forward; the cheapest win on this table. |
| 7 | Runtime/residency | `runtime.notice`, `residency.mutation` | **Upstream boundary**; capacity/VRAM/degradation facts must retain source and numeric detail. | **Accurate, and the kinds are a closed vocabulary now.** `RUNTIME_NOTICE_KINDS = ['will-not-fit','about-to-evict','swap','co-resident','stress','degraded','route-fallback']`, each with a declared producer enforced by a contract test "so no kind outlives the code that emits it". Payload `{kind, level: 'info'\|'warning'\|'error', targetId, runtimeId, model, message, detail?: Record<string, number\|string\|boolean>}`, branded `DeclaredRuntimeNotice` so a raw notice fails to typecheck. `degraded` reports a live turn whose token rate collapsed, i.e. a silent spill to CPU becoming visible while it happens — **that is the HPC-DNA fact the operator wants visible in the GUI.** `ResidencyMutationPayload` = `{targetKey, targetId, runtimeId, model, operation: 'load'\|'evict', at}`. |
| 8 | Dispatch | `dispatch.scopeNotice/enqueued/started/progress/completed/failed` | Enqueued/started/progress/completed/failed are public and wired to the fleet strip; `scopeNotice` is still absent. | **Accurate.** See the payload notes below — this family is where the dispatch board's data comes from. `DispatchScopeNoticePayload` is a discriminated union on `code`: `typed_scope_replaced_inferred_paths` (carries `omittedPaths[]`) or `legacy_scope_inferred\|legacy_scope_empty` (carries `paths[]` of `{path, policy: 'working-context'\|'write-boundary', provenance: 'declared'\|'derived'\|'inferred', source, confidence: 'certain'\|'high'\|'medium'\|'low'}`). It carries filesystem paths, which is why it is not in the allowlist. |
| 9 | Compaction | `compaction.begin/end` | **Upstream boundary**; combine with token/pressure facts before visualizing. | **Accurate.** `CompactionPayload = {trigger, at}` — deliberately thin, which is why the row says combine it with token facts. |
| 10 | Middleware | `middleware.hookFailed` | **Upstream boundary**; diagnostics/inbox surface. | **Accurate, and richer than the row implies.** `{kind: 'hook_failed'\|'budget_exceeded'\|'registration_conflict', registrationId, hook, at, message?, elapsedMs?, budgetMs?, steadyStateWarn?, p50Ms?, p95Ms?, overCount?, windowSamples?}`. **`steadyStateWarn` is the field a GUI performance panel wants**: true only when an overrun is steady-state (≥N of the last M post-warmup calls over budget), not a lone spike. "Diagnostics only; nothing subscribing here may decide anything." |
| 11 | Context | `context.activity/warning/pruned/recalled` | **Upstream boundary**; ideal for a scientific context instrument once versioned. | **Accurate but INCOMPLETE — a fifth channel exists**, `context.sourcesChanged` (`{cwd}`), an explicit boundary meaning descendant sessions must recapture disk sources. `ContextActivityPayload` = `{kind: 'context-init'\|'context-clear'\|'context-refresh'\|'context-wiki'\|'compaction', phase: 'scan'\|'codewiki'\|'generate'\|'clio-md'\|'state'\|'compact'\|'done', status: 'started'\|'running'\|'completed'\|'failed', message, at, current?, total?, detail?}` — **it already has `current`/`total`, so it is a ready-made progress bar.** `ContextPrunedPayload` = `{stage: 'mask_observations'\|'working_set'\|'llm_summary', tokensBefore, tokensAfter, trigger, snapshotIdBefore, snapshotIdAfter, at, pressure?, maskedObservations?, maskedThinkingBlocks?, maskedThinkingChars?, policyId?, evictedItems?}` — **`pressure` is the context meter the parity matrix calls Absent.** `ContextRecalledPayload` = `{ref, trigger: 'tool'\|'operator', tokensReadmitted, at}`. `ContextWarningPayload = {warning: string\|null}`, transitions only. |
| 12 | Agent | `agent.status.changed` | **Upstream boundary**. Run-level identity is public through the dispatch events, but per-phase status is not. | **Accurate, and this is the GUI's live status line.** `{runId: string\|null, phase: StatusPhase, prevPhase: StatusPhase, at, elapsedFromStart, watchdogTier: 0\|1\|2\|3\|4, metadata?: {toolName?, attempt?, reason?, agentName?}}`. `StatusPhase` = `idle\|preparing\|waiting_model\|thinking\|writing\|tool_running\|tool_blocked\|retrying\|compacting\|dispatching\|stuck\|ended`. The taxonomy is owned in `core/bus-events.ts` (not `src/interactive`) precisely because it rides the bus into the safety domain's audit trail. **This one channel would replace most of the GUI's inferred spinner state with reported fact.** |
| 13 | Run/budget | `run.aborted`, `budget.alert` | **Upstream boundary**; keep abort sources and cost provenance distinct. | **Accurate, and the distinctness rule is enforced.** `RunAbortSource = 'dispatch_abort'\|'dispatch_drain'\|'stream_cancel'\|'loop_guard'` with a runtime guard `isRunAbortedPayload`. "Subscribers must not collapse the sources: a drained dispatch run, a user-cancelled stream, and a guard-stopped loop are different operator situations." `BudgetAlertPayload = {level: 'at'\|'over', currentUsd, ceilingUsd}` — **informational in v0.x: scheduling never rejects the enqueue**, so the GUI notice is the operator's only signal and must not imply enforcement. |
| 14 | Shutdown | `shutdown.requested/drained/terminated/persisted` | The GUI observes child/process loss, not these structured phases. Diagnostics only. | **Accurate.** `ShutdownRequestedPayload = {phase: TerminationPhase}`; the other three carry `EmptyPayload = Record<string, never>`. |

## THREE FAMILIES WITH NO ROW (add them)

| Bus group | Channels | Payload | GUI verdict to assign |
| --- | --- | --- | --- |
| **Accountability** | `accountability.evidenceReady` | `AccountabilityEvidenceReadyPayload extends ObservabilityRunEvidence { runId }` | **PUBLIC AND WIRED — already in the ACP allowlist and the audit has no row for it.** From the source comment: it fires once a finalized run's evidence bundle and its sidecar index row have landed, so "the board can show first-pass success and a finding count without reading Clio's state tree." The fields are *exactly* `ObservabilityRunEvidence`, the same shape the projection attaches to the run summary, "so the bus and the snapshot cannot describe the same moment two ways." **A failed build publishes nothing here** — a client that never receives it has learned only that no bundle is ready, which is the truth. This is the backbone of the evidence-receipts surface the operator asked for. |
| **Extensions / plugins** | `extensions.reloaded`, `plugins.reloaded`, `extensions.loadIssue` | `ExtensionsReloadedPayload = {generation, previousGeneration, changed, digest}`; `PluginsReloadedPayload` is the same shape; `ExtensionsLoadIssuePayload = {message}` | **Upstream boundary → easy win.** `extensions.reloaded` is published only after *both* the new extension generation and its user-hook registrations have been committed, never between. `plugins.reloaded` is a separate, data-only generation for recipe and prompt consumers. **The library-marketplace page needs exactly this to know when to refetch after an install**, instead of polling. `digest` is a content identity, so the GUI can skip a refetch when `changed` is false. |
| **Memory** | `memory.stepCompleted` | `{endpointKey, targetId}` | **Diagnostics only.** Deliberately carries the endpoint a proactive-memory step called and *nothing about what it decided*. Its only consumer stamps an expected-cold reason when a step ran between turns on the endpoint the chat target streams against. Useful as the "observed memory steps" the settings table asks to pair with the `context.memory.*` controls. |

## Full channel roster (47), for the record

`session.start`, `session.end`, `session.parked`, `session.resumed`, `session.turn_switched`, `domain.loaded`, `domain.failed`, `config.hotReload`, `config.nextTurn`, `config.restartRequired`, `config.reloadFailed`, `permission.requested`, `permission.resolved`, `safety.classified`, `safety.blocked`, `safety.allowed`, `safety.loopBlocked`, `safety.toolBudgetExceeded`, `provider.health`, `runtime.notice`, `residency.mutation`, `dispatch.scopeNotice`, `dispatch.enqueued`, `dispatch.started`, `dispatch.progress`, `dispatch.completed`, `dispatch.failed`, `accountability.evidenceReady`, `compaction.begin`, `compaction.end`, `middleware.hookFailed`, `extensions.reloaded`, `plugins.reloaded`, `extensions.loadIssue`, `context.activity`, `context.sourcesChanged`, `context.warning`, `context.pruned`, `context.recalled`, `memory.stepCompleted`, `agent.status.changed`, `run.aborted`, `budget.alert`, `shutdown.requested`, `shutdown.drained`, `shutdown.terminated`, `shutdown.persisted`.

A compile-time tripwire (`BusPayloadMapCoversAllChannels`) means adding a channel without a payload fails to typecheck — so this roster can be regenerated mechanically and a GUI test should assert the GUI's own event union is a subset of it.

## Dispatch payload fields the board needs (verbatim from the types)

`DispatchRunIdentity` (shared by every dispatch event): `runId, agentId, task?, agentAudience?, requestOrigin?, targetId, wireModelId, runtimeId, runtimeKind, endpoint?{key,label,limit}, budget?, node?, gate?{role,cycle}, council?{group,label,color?,round}, rerouteCount?, contextWindow?`.

- `task` is the **exact** dispatched task; the comment says "UI projections must sanitize and bound it before rendering." Over ACP only the 160-byte stripped preview crosses.
- `gate` and `council` exist **for board badges** — the compete/council surfaces are meant to be driven from these, not reconstructed.
- `contextWindow` is there "for the per-worker context meter."
- `node` absent renders as the local node.

`DispatchStartedPayload` adds `pid, processCommand?, assignmentId, attempt, parentToolCallId?`. **`assignmentId` and `attempt` are required**: "a surface that draws one entry per logical work item has to key on the assignment, and a spawn path that forgot to send it would silently split a failover into two entries." **Key the GUI's run rows on `assignmentId`, not `runId`.** `parentToolCallId` is what lets a transcript nest a worker under the tool segment that started it instead of appending it wherever the turn happens to be — that is the nesting the operator wants in the agent viewport.

`DispatchProgressPayload.event` is **deliberately `unknown`**: it is the worker/ACP event stream crossing a process boundary. The workbench dropped it entirely in favour of a per-run progress count. Any GUI that renders it must validate it at runtime.

`DispatchTerminalStats` (required on completed, partial on failed): `lineage, tokenCount, inputTokenCount, outputTokenCount, cacheReadTokenCount, cacheWriteTokenCount, cacheWrite1hTokenCount?, reasoningTokenCount, staticShellHash, sessionShellHash, dynamicHash, costUsd, costProvenance?, durationMs, exitCode, toolActivity: ToolActivitySummary|null, hostVerification?: 'verified'|'rejected'|'skipped'|'not_implicated'`. Required on completed specifically so "dropping a field from one finalizer is a compile error."

`DispatchFailedPayload.reason: RunOutcome | 'retry_denied'` — "the board maps it to a presentation status, so emitters must not collapse the taxonomy."

Both terminal payloads may carry `skillActivations[]`, present only when the run activated a skill. "A run that loaded a skill and then failed is exactly when the operator needs to know which skill and which copy of it."

## Terminal token metadata (the one non-event fact on this boundary)

Terminal metadata carries **exactly five** token fields: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, under `_meta["clio-coder/usage"]`. The workbench rule, worth keeping: **never converted to price or context pressure by the GUI.** Show the five numbers and Clio's own reported cost with its provenance; do not multiply by a rate card.

## Agent attribution (already public, easy to miss)

Every live `session/update` carries a `clio-coder/agent` attribution in its `_meta`, and a tool call whose execution spawned a delegated run is **re-announced** carrying that worker's agent id, run id, and node. The main narrative is attributed to the orchestrator explicitly, "so the GUI states who produced a card instead of assuming it."

What does **not** cross, and must not be simulated: a sub-agent's own narrative or reasoning. A delegated run's output reaches the orchestrator as a tool result, so per-message worker attribution has nothing to attach to on the ACP session stream.
