/**
 * Turn runtime ownership: orchestrator target resolution, model synthesis,
 * live-agent construction and model hot-swap, thinking-level reconciliation,
 * capability/reasoning probes, and the run-event pipeline that enriches
 * engine events with timing, observability, persistence, and honesty facts.
 */

import { performance } from "node:perf_hooks";
import type { ClioSettings } from "../core/config.js";
import type { MiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import {
	applyModelCapabilityPatch,
	firstRuntimeResolutionError,
	modelResidencyForStatus,
	type ProvidersContract,
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
	runtimeResolutionWarnings,
	type TargetStatus,
	targetRequiresAuth,
} from "../domains/providers/index.js";
import type { RetrySettings } from "../domains/session/retry.js";
import type { createEngineAgent } from "../engine/agent.js";
import { cleanupEngineSessionResources } from "../engine/ai.js";
import { sanitizeLockedSynthesisMessage } from "../engine/loop-guard.js";
import {
	patchProviderThinkingPayload,
	patchToolChoiceNamedPayload,
	patchToolChoiceNonePayload,
} from "../engine/provider-payload.js";
import type { AgentEvent, AgentMessage, EngineModel, Usage } from "../engine/types.js";
import type { resolveAgentTools, ToolOutcome, ToolTelemetry } from "../tools/agent-tools.js";
import {
	type AssistantCallTiming,
	type BackendCacheVerdict,
	backendCacheVerdict,
	extractText,
	extractThinking,
	fallbackIdentityPrompt,
	hasStructuredToolCall,
	isEmptyAbortedAssistantMessage,
	sumRunUsage,
	toolNamesFromAgentState,
	toolResultSummary,
} from "./chat-loop-messages.js";
import { assessToolProseLoop, runtimeNarratesToolCalls, shouldAssessToolProse } from "./tool-prose-loop.js";
import type { TurnContext } from "./turn-context.js";
import type { TurnMiddleware } from "./turn-middleware.js";
import type { TurnPersistence } from "./turn-persistence.js";
import type { AgentRuntime, ChatLoopTarget, ChatTurnState } from "./turn-state.js";

const LOCAL_API_KEY_FALLBACK = "clio-local-target";

/**
 * Say that the first request will pay for a load, before it does.
 *
 * A self-hosted server loads a model on demand, and a 30B at 4-bit takes tens
 * of seconds off disk. Clio sends the request and waits, which from the outside
 * is indistinguishable from a hang: no spinner explains it, no notice names it,
 * and the operator's next move is usually Ctrl-C. The probe already knows the
 * model is not resident, because llama-swap and LM Studio both report per-model
 * load state; nothing was reading it.
 *
 * Notice only, never a block. The server loads it either way, and a state that
 * says `unknown` says nothing worth interrupting for. Residency comes from the
 * same discovery view the planner budgets against, so a model Clio is planning
 * a loaded window for is never announced as absent.
 */
export function coldModelNotice(
	status: TargetStatus | null | undefined,
	targetId: string,
	wireModelId: string,
): { key: string; message: string } | null {
	const residency = modelResidencyForStatus(status, wireModelId);
	if (residency === "loading") {
		return {
			key: `${targetId}|${wireModelId}|loading`,
			message: `[Clio Coder] ${wireModelId} is still loading on ${targetId}; the first reply waits for it.`,
		};
	}
	if (residency !== "absent") return null;
	return {
		key: `${targetId}|${wireModelId}|unloaded`,
		message: `[Clio Coder] ${wireModelId} is not resident on ${targetId}; the first request loads it, which can take a minute.`,
	};
}

export type AssistantDeltaEvent =
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partialText: string;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partialThinking: string;
	  };

export interface TurnRuntimeDeps {
	state: ChatTurnState;
	getSettings: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	knownTargets: () => ReadonlySet<string>;
	observability?: ObservabilityContract | undefined;
	createAgent: typeof createEngineAgent;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	persistence: TurnPersistence;
	context: TurnContext;
	middleware: TurnMiddleware;
	retrySettings: () => RetrySettings;
	emit: (event: AgentEvent | AssistantDeltaEvent) => void;
	emitNotice: (text: string) => void;
	toolStartTimes: Map<string, number>;
}

export interface TurnRuntime {
	ensureRuntime(): AgentRuntime | null;
	ensureLiveCapabilitiesForSelectedModel(): Promise<void>;
	cleanupSessionResources(sessionId: string | undefined): void;
	/**
	 * Install on the session tool surface so admission verdicts reach the panel.
	 * The engine's `tool_execution_end` carries only `isError` and result text,
	 * which cannot tell a permission block from a command that ran and exited
	 * nonzero; this stream carries the registry's actual verdict.
	 */
	toolTelemetry: ToolTelemetry;
}

export function createTurnRuntime(deps: TurnRuntimeDeps): TurnRuntime {
	const { state, context, persistence, middleware, middlewareToolChoice } = deps;

	/**
	 * Authoritative admission outcome per call, keyed by the engine's
	 * `toolCallId`, recorded as the registry settles and consumed when the
	 * matching `tool_execution_end` arrives. Entries are deleted on consumption;
	 * a call whose end event never arrives leaves at most one stale entry, which
	 * the next run with the same id would overwrite.
	 */
	const toolOutcomes = new Map<string, { outcome: ToolOutcome; reason?: string }>();
	const toolTelemetry: ToolTelemetry = {
		onFinish(event) {
			if (event.toolCallId === undefined) return;
			toolOutcomes.set(
				event.toolCallId,
				event.reason === undefined ? { outcome: event.outcome } : { outcome: event.outcome, reason: event.reason },
			);
		},
	};

	/**
	 * Resolution warnings the operator has already been shown, keyed by
	 * target+model+message. A resolution runs on every turn, so without this the
	 * same context-window warning would print on every submit; without any
	 * surfacing at all, it printed nowhere. The chat is the only place an
	 * interactive operator will see it: dispatch receipts carry the same facts,
	 * but nobody reads a receipt for the run they are in the middle of.
	 */
	const announcedResolutionWarnings = new Set<string>();

	const readTarget = (): ChatLoopTarget | null => {
		const settings = deps.getSettings();
		const targetId = settings.orchestrator.target?.trim();
		const wireModelId = settings.orchestrator.model?.trim();
		if (!targetId || !wireModelId) return null;
		const resolved = resolveRuntimeTarget(deps.providers, {
			targetId,
			wireModelId,
			requestedThinkingLevel: settings.orchestrator.thinkingLevel ?? "off",
			use: "orchestrator",
			requireTools: false,
			requireOutputBudget: true,
		});
		if (!resolved.ok) {
			const message = firstRuntimeResolutionError(resolved.diagnostics) ?? resolved.diagnostics[0]?.message;
			throw new Error(`[Clio Coder] ${message ?? "orchestrator target resolution failed"}`);
		}
		for (const message of runtimeResolutionWarnings(resolved.diagnostics)) {
			const key = `${targetId}|${wireModelId}|${message}`;
			if (announcedResolutionWarnings.has(key)) continue;
			announcedResolutionWarnings.add(key);
			deps.emitNotice(`[Clio Coder] ${message}`);
		}
		return {
			target: resolved.target.target,
			runtime: resolved.target.runtime,
			wireModelId: resolved.target.wireModelId,
			runtimeResolution: resolved.target,
		};
	};

	/**
	 * Probe a self-hosted target once per target+model selection, not on
	 * every submit (T3.1). The probe re-runs when the selection key changes
	 * (which is also when the runtime is rebuilt or hot-swapped) or after a
	 * generous TTL. Failures keep the last known target state; the TTL
	 * retries later.
	 *
	 * Every tier but `cloud` is probed. Only a hosted provider's window is
	 * knowable without asking: a self-hosted OpenAI-compatible gateway serves
	 * whatever context it was launched with, and that number lives on the
	 * server. Restricting this to `local-native` meant an `openai-compat`
	 * target ran the whole session on an assumed window while the server was
	 * one HTTP GET away from reporting the real one.
	 */
	const TARGET_PROBE_TTL_MS = 5 * 60 * 1000;
	let lastTargetProbe: { key: string; at: number } | null = null;
	const ensureLiveCapabilitiesForSelectedModel = async (): Promise<void> => {
		const settings = deps.getSettings();
		const targetId = settings.orchestrator.target?.trim();
		const wireModelId = settings.orchestrator.model?.trim();
		if (!targetId || !wireModelId) return;
		const target = deps.providers.getTarget(targetId);
		if (!target) return;
		const runtimeDesc = deps.providers.getRuntime(target.runtime);
		if (!runtimeDesc || runtimeDesc.tier === "cloud") return;
		const key = `${targetId}|${wireModelId}`;
		const now = Date.now();
		if (lastTargetProbe?.key === key && now - lastTargetProbe.at < TARGET_PROBE_TTL_MS) return;
		lastTargetProbe = { key, at: now };
		let status: Awaited<ReturnType<ProvidersContract["probeTarget"]>> = null;
		try {
			status = await deps.providers.probeTarget(targetId);
		} catch {
			// Fall back to the last known target state.
		}
		announceColdModel(status, targetId, wireModelId);
	};

	/** One notice per target+model+state, so a repeated probe stays quiet. */
	const announcedColdModels = new Set<string>();
	const announceColdModel = (
		status: Awaited<ReturnType<ProvidersContract["probeTarget"]>>,
		targetId: string,
		wireModelId: string,
	): void => {
		const notice = coldModelNotice(status, targetId, wireModelId);
		if (!notice) return;
		if (announcedColdModels.has(notice.key)) return;
		announcedColdModels.add(notice.key);
		deps.emitNotice(notice.message);
	};

	const synthesizeModel = (target: ChatLoopTarget): EngineModel => {
		const kbHit = deps.providers.knowledgeBase?.lookup(target.wireModelId) ?? null;
		const synth = target.runtime.synthesizeModel(target.target, target.wireModelId, kbHit);
		target.runtimeResolution = refineRuntimeTargetWithModelHints(
			target.runtimeResolution,
			synth,
			deps.providers.knowledgeBase,
		);
		applyModelCapabilityPatch(synth, target.runtimeResolution.capabilities);
		return synth;
	};

	const ensureReasoningProbe = (target: ChatLoopTarget): void => {
		if (deps.providers.getDetectedReasoning(target.target.id, target.wireModelId) !== null) return;
		void deps.providers
			.probeReasoningForModel(target.target.id, target.wireModelId)
			.then((reasoning) => {
				if (
					reasoning !== null &&
					state.runtime &&
					state.runtime.targetId === target.target.id &&
					state.runtime.wireModelId === target.wireModelId
				) {
					const refreshed = resolveRuntimeTarget(deps.providers, {
						targetId: target.target.id,
						wireModelId: target.wireModelId,
						requestedThinkingLevel: deps.getSettings().orchestrator.thinkingLevel ?? "off",
						use: "orchestrator",
						requireTools: false,
						requireOutputBudget: true,
					});
					if (!refreshed.ok) return;
					const liveModel = state.runtime.agent.state.model;
					const runtimeResolution = liveModel
						? refineRuntimeTargetWithModelHints(refreshed.target, liveModel, deps.providers.knowledgeBase)
						: refreshed.target;
					if (liveModel) applyModelCapabilityPatch(liveModel, runtimeResolution.capabilities);
					state.runtime.agent.state.thinkingLevel = runtimeResolution.effectiveThinkingLevel;
					state.runtime.runtimeResolution = runtimeResolution;
				}
			})
			.catch(() => {
				// Probe failures are non-fatal; the cache stays cold and /thinking
				// keeps showing the runtime defaults until the next probe attempt.
			});
	};

	const cleanupSessionResources = (sessionId: string | undefined): void => {
		try {
			cleanupEngineSessionResources(sessionId);
		} catch (err) {
			deps.emitNotice(`[Clio Coder] session resource cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	/**
	 * One visible line when the requested thinking dial cannot apply as-is
	 * (reasoning-class-never model, always-on model, on/off coercion). Emitted
	 * where the dial takes effect, once per target+model+request change; the
	 * same facts stay inspectable in receipts via runtimeResolution.thinking.
	 */
	let lastThinkingNoticeKey: string | null = null;
	const emitThinkingClampNotice = (resolution: ChatLoopTarget["runtimeResolution"]): void => {
		const thinking = resolution.modelRuntime.thinking;
		const notice = thinking.notice.trim();
		if (thinking.noticeKind === "applied" || notice.length === 0) return;
		const key = [
			resolution.targetId,
			resolution.wireModelId,
			resolution.requestedThinkingLevel,
			resolution.effectiveThinkingLevel,
			notice,
		].join("|");
		if (key === lastThinkingNoticeKey) return;
		lastThinkingNoticeKey = key;
		deps.emitNotice(
			`[Clio Coder] thinking ${resolution.requestedThinkingLevel} -> ${thinking.display}: ${notice} (${resolution.wireModelId})`,
		);
	};

	const ensureRuntime = (): AgentRuntime | null => {
		const target = readTarget();
		if (!target) return null;
		context.emitContextWindowWarningTransition(target.runtimeResolution?.contextWindowDetails?.warning ?? null);
		if (!deps.knownTargets().has(target.target.id)) {
			throw new Error(
				`[Clio Coder] orchestrator target=${target.target.id} unknown. Run \`clio-coder targets\` to see configured targets.`,
			);
		}
		if (
			state.runtime &&
			state.runtime.targetId === target.target.id &&
			state.runtime.runtimeId === target.runtime.id &&
			state.runtime.wireModelId === target.wireModelId
		) {
			// Same target+runtime+model. Settings may still have moved
			// thinkingLevel since the last call (the user invoked /thinking
			// or Alt+T); reconcile the clamped level so the next prompt
			// dispatches under the current intent without forcing a rebuild.
			ensureReasoningProbe(target);
			const runtimeResolution = refineRuntimeTargetWithModelHints(
				target.runtimeResolution,
				state.runtime.agent.state.model,
				deps.providers.knowledgeBase,
			);
			const desiredLevel = runtimeResolution.effectiveThinkingLevel;
			if (state.runtime.agent.state.thinkingLevel !== desiredLevel) {
				state.runtime.agent.state.thinkingLevel = desiredLevel;
			}
			state.runtime.runtimeResolution = runtimeResolution;
			emitThinkingClampNotice(runtimeResolution);
			return state.runtime;
		}

		// Same target+runtime, new wireModelId: hot-swap the model in place on
		// the live agent. Mirrors the pi-coding-agent setModel pattern (mutate
		// `agent.state.model`, re-clamp thinking level, persist) so the runtime
		// keeps its conversation, subscribers, and pending tool calls.
		// Server-side residency for the new model is reconciled by the engine
		// adapters at the top of the next stream (engine/apis/residency.ts):
		// co-resident when capacity allows, swapping only when a slot must be
		// freed, never evicting protected models.
		if (
			state.runtime &&
			state.runtime.targetId === target.target.id &&
			state.runtime.runtimeId === target.runtime.id &&
			state.runtime.wireModelId !== target.wireModelId
		) {
			const nextModel = synthesizeModel(target);
			state.runtime.agent.state.model = nextModel;
			state.runtime.wireModelId = target.wireModelId;
			const effectiveThinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
			state.runtime.agent.state.thinkingLevel = effectiveThinkingLevel;
			state.runtime.runtimeResolution = target.runtimeResolution;
			emitThinkingClampNotice(target.runtimeResolution);
			persistence.appendModelChangeEntry(target);
			ensureReasoningProbe(target);
			return state.runtime;
		}

		const model = synthesizeModel(target);
		const initialThinkingLevel = target.runtimeResolution.effectiveThinkingLevel;
		const tools: ReturnType<typeof resolveAgentTools> = [];
		// Seed the system prompt with the fallback identity text. The first
		// submit replaces it with the compiled session prompt; the fallback
		// only shows up when the prompts contract is absent (tests, degraded
		// boot).
		const hadPriorRuntime = state.runtime !== null;
		const priorMessages = state.runtime ? [...state.runtime.agent.state.messages] : [...state.replayedContextMessages];
		// Drop any in-flight stream on the prior agent before discarding it.
		if (state.runtime) {
			state.runtime.agent.abort();
			cleanupSessionResources(state.runtime.agent.sessionId);
		}
		const handle = deps.createAgent({
			initialState: {
				systemPrompt: fallbackIdentityPrompt(),
				model,
				thinkingLevel: initialThinkingLevel,
				tools,
				messages: priorMessages,
			},
			maxRetryDelayMs: deps.retrySettings().maxDelayMs,
			onPayload: async (payload, currentModel) => {
				const thinkingPatched = patchProviderThinkingPayload(payload, currentModel, state.currentThinkingLevel);
				const basePayload = thinkingPatched ?? payload;
				if (state.synthesisToolLock) {
					return patchToolChoiceNonePayload(basePayload, currentModel) ?? thinkingPatched;
				}
				const middlewareChoice = middlewareToolChoice.current();
				if (middlewareChoice.kind === "none") {
					return patchToolChoiceNonePayload(basePayload, currentModel) ?? thinkingPatched;
				}
				if (middlewareChoice.kind === "required") {
					return patchToolChoiceNamedPayload(basePayload, currentModel, middlewareChoice.toolName) ?? thinkingPatched;
				}
				return thinkingPatched;
			},
			getApiKey: async () => {
				if (!targetRequiresAuth(target.target, target.runtime)) {
					return LOCAL_API_KEY_FALLBACK;
				}
				const resolved = await deps.providers.auth.resolveForTarget(target.target, target.runtime);
				return resolved.apiKey;
			},
		});

		// Build the runtime object before subscribing so the callback closes
		// over the same heap object the hot-swap path mutates. Reading
		// `localRuntime.targetId` / `localRuntime.wireModelId` at event time
		// instead of the captured `target` guarantees per-turn observability
		// rows are tagged with whatever model is active right now, not the
		// model this agent was originally built with.
		const localRuntime: AgentRuntime = {
			agent: handle.agent,
			targetId: target.target.id,
			runtimeId: target.runtime.id,
			wireModelId: target.wireModelId,
			runtimeResolution: target.runtimeResolution,
		};
		emitThinkingClampNotice(target.runtimeResolution);

		// Stall watchdog. `agent_start` arms a timer for `retry.streamStallMs`;
		// every later engine event counts as progress and pushes the deadline
		// out. When the deadline passes with nothing from the stream, the
		// backend is presumed wedged (the server answers /health while its slot
		// is dead) and the run is aborted through the same `agent.abort()` call
		// Esc uses. `state.streamStallReason` is what tells the two aborts apart
		// once the run settles: `turn-recovery.reclassifyStallAbort` reads it and
		// hands the failure to the transient retry ladder, while an operator
		// cancel still ends the turn.
		//
		// Idle is measured on `performance.now()`. Wall time is not a duration:
		// a forward step of one threshold or more (NTP correcting a node that
		// booted without an RTC battery, a laptop resuming from suspend) would
		// otherwise make a healthy stream look silent and abort it through the
		// operator-cancel path.
		//
		// `toolsInFlight` and `stallSuspendDepth` cover the windows where silence
		// is expected and the stream is not the thing we are waiting on: a tool
		// executing (a `npm run ci` that takes ten minutes is not a stalled
		// stream) and the post-tool continuation guard, whose auto-compaction is
		// its own model call. The watchdog re-arms instead of firing while either
		// is above zero. They are counted apart because only the tool half can
		// leak: the guard's depth is a try/finally around one await, while a
		// `tool_execution_end` that never arrives would disable the watchdog for
		// the rest of the run. The engine settles an entire tool batch before it
		// emits `turn_end`, so that event bounds the tool suspension below.
		let lastActivityAt = performance.now();
		let toolsInFlight = 0;
		let stallSuspendDepth = 0;
		let stallTimer: ReturnType<typeof setTimeout> | null = null;
		const clearStallTimer = (): void => {
			if (stallTimer === null) return;
			clearTimeout(stallTimer);
			stallTimer = null;
		};
		const armStallTimer = (delayMs: number): void => {
			stallTimer = setTimeout(
				() => {
					stallTimer = null;
					const stallMs = deps.retrySettings().streamStallMs;
					// Zero disables the escalation; an operator who wants a stream to
					// hang forever keeps that by setting `retry.streamStallMs: 0`.
					if (stallMs <= 0) return;
					if (stallSuspendDepth > 0 || toolsInFlight > 0) {
						armStallTimer(stallMs);
						return;
					}
					const idleMs = performance.now() - lastActivityAt;
					if (idleMs < stallMs) {
						armStallTimer(stallMs - idleMs);
						return;
					}
					state.streamStallReason = `stream stalled: no output from ${localRuntime.targetId} for ${Math.round(idleMs / 1000)}s, aborting (stream timeout)`;
					localRuntime.agent.abort();
				},
				Math.max(1, delayMs),
			);
			// The in-flight request already holds the event loop open; this timer
			// must not keep a settled headless run alive on its own.
			stallTimer.unref?.();
		};

		handle.agent.prepareNextTurn = async (signal?: AbortSignal) => {
			stallSuspendDepth += 1;
			try {
				return await context.postToolContinuationGuard(localRuntime, signal);
			} finally {
				stallSuspendDepth -= 1;
				lastActivityAt = performance.now();
			}
		};

		let streamStartedAt: number | null = null;
		let firstAssistantDeltaAt: number | null = null;
		// Per-API-call timing (T3.2): one assistant message per provider call,
		// bounded by message_start/message_end; the first delta marks TTFT.
		let apiCallStartedAt: number | null = null;
		let apiCallFirstDeltaAt: number | null = null;
		// First call of the run is the one whose verdict says whether the
		// backend reused the session prefix; later calls in a tool loop are
		// trivially warm.
		let runFirstCallVerdict: BackendCacheVerdict | null = null;
		// artifact plan/review/report set ToolResult.terminate=true so the agent
		// loop skips the follow-up LLM call that would otherwise produce the
		// assistant message carrying the turn's terminal stopReason. Track the
		// most recent terminating tool result here; a real assistant
		// message_end (the follow-up call did happen, e.g. another tool in the
		// same batch did not also set terminate) clears it. If it is still set
		// at agent_end, no terminal ledger row was ever written for this turn,
		// so one is synthesized below.
		let pendingTerminalToolResult: { toolCallId: string; toolName: string } | null = null;
		// state.messages length when this run started; agent state appends every
		// message of the run (prompts, assistant, tool results) via message_end,
		// so the slice from here is the run's real message window.
		let runStartMessageCount = 0;

		handle.agent.subscribe(async (event) => {
			const eventAt = Date.now();
			lastActivityAt = performance.now();
			let enrichedEvent = event;
			if (event.type === "tool_execution_start") {
				toolsInFlight += 1;
				middlewareToolChoice.toolStarted(event.toolName);
				deps.toolStartTimes.set(event.toolCallId, eventAt);
				state.turnToolCalls += 1;
			} else if (event.type === "tool_execution_end") {
				toolsInFlight = Math.max(0, toolsInFlight - 1);
				const startedAt = deps.toolStartTimes.get(event.toolCallId);
				deps.toolStartTimes.delete(event.toolCallId);
				const durationMs = startedAt === undefined ? undefined : Math.max(0, eventAt - startedAt);
				// Carry the registry's verdict alongside the engine's result. The
				// panel classifies settlement from `outcome`; without it the only
				// available signal is result text, and grepping that text for
				// "blocked"/"cancelled" labels every failing `node --test` run
				// (which prints `cancelled 0`) a permission block.
				const admission = toolOutcomes.get(event.toolCallId);
				toolOutcomes.delete(event.toolCallId);
				enrichedEvent = {
					...event,
					...(durationMs !== undefined ? { durationMs } : {}),
					resultSummary: toolResultSummary(event.result),
					...(admission === undefined
						? {}
						: {
								outcome: admission.outcome,
								...(admission.reason === undefined ? {} : { blockReason: admission.reason }),
							}),
				} as typeof event;
			} else if (event.type === "agent_end") {
				// The engine's failure path (an abort or a thrown provider error)
				// replaces the run's message window with one synthetic zero-usage
				// failure message, which zeroed token usage, tool counts, and cache
				// records for every aborted turn. Rebuild the real window from agent
				// state, which already holds all of this run's messages plus that
				// failure message.
				const runMessages = localRuntime.agent.state.messages.slice(runStartMessageCount);
				if (runMessages.length > event.messages.length) {
					enrichedEvent = { ...event, messages: runMessages } as typeof event;
				}
			} else if (event.type === "message_end" && state.synthesisToolLock) {
				// Synthesis-locked turn: a model that ignores tool_choice none emits
				// its chat template's tool-call syntax as plain text. Sanitize the
				// message in place (pi stores this same object in agent state, so
				// the emitted event, ledger persistence below, and later provider
				// rounds all see the sanitized text) and mark the event so the
				// panel replaces its streamed markup tail instead of appending.
				if (sanitizeLockedSynthesisMessage(event.message)) {
					enrichedEvent = { ...event, lockedSynthesisSanitized: true } as typeof event;
				}
			}
			const publicEvent = enrichedEvent;
			if (publicEvent?.type === "agent_start") {
				runStartMessageCount = localRuntime.agent.state.messages.length;
				streamStartedAt = eventAt;
				firstAssistantDeltaAt = null;
				apiCallStartedAt = null;
				apiCallFirstDeltaAt = null;
				runFirstCallVerdict = null;
				pendingTerminalToolResult = null;
				clearStallTimer();
				toolsInFlight = 0;
				stallSuspendDepth = 0;
				state.streamStallReason = null;
				const stallMs = deps.retrySettings().streamStallMs;
				if (stallMs > 0) armStallTimer(stallMs);
			}
			// The engine runs the whole tool batch to settlement before it emits
			// `turn_end`, so nothing from this turn can still be executing here.
			// A call whose `tool_execution_end` was never emitted (a crashed
			// mediator, a dropped frame) therefore stops suspending the watchdog
			// at the turn that issued it instead of for the rest of the run.
			if (publicEvent?.type === "turn_end") toolsInFlight = 0;
			if (publicEvent?.type === "message_start" && publicEvent.message?.role === "assistant") {
				apiCallStartedAt = eventAt;
				apiCallFirstDeltaAt = null;
			}
			if (publicEvent?.type === "message_update") {
				const assistantEvent = publicEvent.assistantMessageEvent as { type?: string; delta?: unknown };
				const hasDelta =
					assistantEvent.type === "text_delta" ||
					assistantEvent.type === "thinking_delta" ||
					assistantEvent.type === "toolcall_start" ||
					assistantEvent.type === "toolcall_delta";
				if (hasDelta && firstAssistantDeltaAt === null) firstAssistantDeltaAt = eventAt;
				if (hasDelta && apiCallFirstDeltaAt === null) apiCallFirstDeltaAt = eventAt;
			}
			if (publicEvent?.type === "agent_end") {
				context.noteRunCacheSummary(publicEvent.messages, runFirstCallVerdict);
			}
			if (publicEvent?.type === "agent_end" && deps.observability) {
				const summary = sumRunUsage(publicEvent.messages);
				if (summary.hadUsage && (summary.tokens > 0 || summary.costUsd > 0)) {
					deps.observability.recordTokens(
						localRuntime.targetId,
						localRuntime.wireModelId,
						summary.tokens,
						summary.costUsd,
						{
							input: summary.input,
							output: summary.output,
							cacheRead: summary.cacheRead,
							cacheWrite: summary.cacheWrite,
							reasoningTokens: summary.reasoning,
							totalTokens: summary.tokens,
							apiCalls: summary.apiCalls,
						},
						localRuntime.runtimeResolution.costProvenance,
					);
				}
				if (summary.output > 0 && firstAssistantDeltaAt !== null) {
					const durationMs = Math.max(1, eventAt - firstAssistantDeltaAt);
					deps.observability.recordTokenThroughput({
						tokensPerSecond: summary.output / (durationMs / 1000),
						outputTokens: summary.output,
						durationMs,
						...(streamStartedAt !== null ? { ttftMs: firstAssistantDeltaAt - streamStartedAt } : {}),
						providerId: localRuntime.targetId,
						modelId: localRuntime.wireModelId,
						recordedAt: eventAt,
					});
				}
			}
			// While a loop-guard interrupt is active its closing message has
			// already been shown; the aborted follow-up calls the abort leaves
			// behind carry no content and would render as "[aborted] Request was
			// aborted." noise, so drop them from the live transcript the same way
			// persistence does.
			if (
				state.activeInterruptReason !== null &&
				publicEvent?.type === "message_end" &&
				isEmptyAbortedAssistantMessage(publicEvent.message)
			) {
				return;
			}
			if (publicEvent) deps.emit(publicEvent);
			if (publicEvent?.type === "message_update") {
				const assistantEvent = publicEvent.assistantMessageEvent as {
					type: string;
					contentIndex?: number;
					delta?: string;
					partial?: AgentMessage;
				};
				if (assistantEvent.type === "text_delta") {
					const partialText = extractText(assistantEvent.partial);
					deps.emit({
						type: "text_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialText,
					});
					const localToolRuntime = runtimeNarratesToolCalls(localRuntime.runtimeResolution.runtimeTier);
					if (
						localToolRuntime &&
						state.toolProseAbortReason === null &&
						shouldAssessToolProse(partialText.length, state.toolProseAssessedChars)
					) {
						state.toolProseAssessedChars = partialText.length;
						const activeToolNames = toolNamesFromAgentState(localRuntime.agent.state.tools);
						const assessment = assessToolProseLoop({
							text: partialText,
							activeToolNames,
							hasStructuredToolCall: hasStructuredToolCall(assistantEvent.partial),
						});
						if (assessment.kind === "loop") {
							state.toolProseAbortReason = `[Clio Coder] aborted local model turn: ${assessment.reason}.`;
							localRuntime.agent.abort();
							deps.emitNotice(state.toolProseAbortReason);
						}
					}
				}
				if (assistantEvent.type === "thinking_delta") {
					deps.emit({
						type: "thinking_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialThinking: extractThinking(assistantEvent.partial),
					});
				}
			}
			if (enrichedEvent.type === "message_end") {
				persistence.appendQueuedUserTurn(enrichedEvent.message);
				const isAssistant = enrichedEvent.message?.role === "assistant";
				if (isAssistant) pendingTerminalToolResult = null;
				const timing: AssistantCallTiming | null =
					isAssistant && apiCallStartedAt !== null
						? {
								ttftMs: apiCallFirstDeltaAt !== null ? Math.max(0, apiCallFirstDeltaAt - apiCallStartedAt) : null,
								apiMs: Math.max(0, eventAt - apiCallStartedAt),
							}
						: null;
				persistence.appendAssistantTurn(enrichedEvent.message, timing);
				if (isAssistant) apiCallStartedAt = null;
				const usage = (enrichedEvent.message as { usage?: Usage }).usage;
				if (isAssistant && usage && typeof usage === "object" && runFirstCallVerdict === null) {
					const input = typeof usage.input === "number" ? usage.input : 0;
					const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
					runFirstCallVerdict = backendCacheVerdict(input, cacheRead);
				}
				if (usage) {
					context.reconcileUsage(usage);
				}
			}
			if (enrichedEvent.type === "tool_execution_start") {
				persistence.appendToolCallTurn(enrichedEvent);
			}
			if (enrichedEvent.type === "tool_execution_end") {
				persistence.appendToolResultTurn(enrichedEvent);
				pendingTerminalToolResult =
					(enrichedEvent.result as { terminate?: boolean } | undefined)?.terminate === true
						? { toolCallId: enrichedEvent.toolCallId, toolName: enrichedEvent.toolName }
						: null;
			}
			if (enrichedEvent.type === "agent_end") {
				clearStallTimer();
				const terminal = pendingTerminalToolResult;
				pendingTerminalToolResult = null;
				if (terminal) {
					persistence.appendTerminalToolAssistantTurn(terminal);
				}
				context.flushReconciledSnapshot();
				await middleware.fireTurnEnd(localRuntime, enrichedEvent.messages, terminal ?? undefined);
			}
		});

		state.runtime = localRuntime;
		// Append a modelChange marker only when this rebuild replaces a prior
		// runtime, which is the cross-target swap case (mid-session change of
		// target or runtime id). On the initial build, the session header's
		// `meta.model` (written by `session.create()` in submit()) captures
		// the first model and a marker would be redundant.
		if (hadPriorRuntime) persistence.appendModelChangeEntry(target);
		ensureReasoningProbe(target);
		return state.runtime;
	};

	return {
		ensureRuntime,
		ensureLiveCapabilitiesForSelectedModel,
		cleanupSessionResources,
		toolTelemetry,
	};
}
