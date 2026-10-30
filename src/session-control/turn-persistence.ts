/**
 * Session-ledger persistence for the chat loop: assistant, user, tool-call,
 * tool-result, retry-status, and model-change rows, plus the queued-user-echo
 * handshake with the queue mirror. Owns the ledger cursor semantics: every
 * append advances `state.lastTurnId`.
 */

import type { BackendCompletionTimings } from "../core/cache-telemetry.js";
import type { ClioSettings } from "../core/config.js";
import { messageCallsForAccounting, messageUsageForAccounting } from "../core/message-accounting.js";
import type { PackageIdentity } from "../core/package-identity.js";
import { normalizeTokenUsage } from "../core/token-split.js";
import type { MiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import { aggregateCostAmounts } from "../domains/observability/cost.js";
import type { SessionTurnUsage } from "../domains/observability/trace-store.js";
import { normalizeCostProvenance, resolveCostProvenance } from "../domains/providers/types/cost-provenance.js";
import { noteAnthropicStreamQuota, noteCodexStreamQuota } from "../domains/quota/index.js";
import type { SessionContract, TurnInput } from "../domains/session/contract.js";
import type { BudgetBlockData, SessionEntry } from "../domains/session/entries.js";
import { BUDGET_BLOCK_ENTRY } from "../domains/session/entries.js";
import { appendSessionThinkingLevel } from "../domains/session/thinking-route.js";
import type { TokenSplit } from "../domains/turn-control/index.js";
import { replaceEngineMessages, setEngineCodexUserTurn } from "../engine/agent.js";
import type { ClioTurnRecord } from "../engine/session.js";
import type {
	AgentEvent,
	AgentMessage,
	AnthropicResponseObservation,
	CodexQuotaObservation,
	CodexTransportObservation,
	Usage,
} from "../engine/types.js";
import {
	chainStepToolCallId,
	type DisplayToolCall,
	displayToolCall,
	gatewayChainPlan,
	gatewayChainSteps,
	VIA_GATEWAY,
} from "../tools/gateway-display.js";
import {
	type AssistantCallTiming,
	assistantSessionPayload,
	estimatedUsageForInterruptedTurn,
	explainInterruptedAssistant,
	extractUserText,
	hasPersistableAssistantContent,
	hasStructuredToolCall,
	isEmptyAbortedAssistantMessage,
	isLengthStopAssistantMessage,
	recordValue,
	sumRunUsage,
	terminalFailureFromAssistantMessage,
	toolResultSummary,
} from "./chat-loop-messages.js";
import { retireActiveUserContextForNextOperator } from "./session-replay-messages.js";
import type { RetryStatusPayload } from "./turn-recovery.js";
import type { AgentRuntime, ChatLoopTarget, ChatTurnState } from "./turn-state.js";

export interface TurnPersistenceDeps {
	getToolOwner?: (name: string) => PackageIdentity | undefined;
	state: ChatTurnState;
	session?: SessionContract | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
	getSettings: () => Readonly<ClioSettings>;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	/** Consume a user text the loop already persisted itself (echo dedupe). */
	consumePersistedEcho: (text: string) => boolean;
	/** Remove a queued-mirror entry once the engine injects it. */
	/** Returns the machine origin of the queued entry this text was, when it had one. */
	removeQueuedMirrorEntry: (text: string) => string | undefined;
	/** Prompt-cache record for a persisted assistant call (T3.2 + cold stamp). */
	promptCachePayloadForAssistant: (
		usage: Usage,
		backend?: BackendCompletionTimings,
		anthropicResponse?: AnthropicResponseObservation,
		transport?: CodexTransportObservation,
	) => Record<string, unknown>;
	/**
	 * Prompt-side tokens the live context accounting holds for the turn in
	 * flight. Used only to record what an interrupted call is known to have
	 * spent when the provider reported no usage at all; 0 when unknown.
	 */
	promptSideTokens: () => number;
	/**
	 * Second sink for the same rows, mirroring the operator's own turns into the
	 * trace database beside the runs this session dispatched. Optional: absent
	 * observability leaves every append exactly as it was. The mirror is
	 * best-effort by construction, so nothing here inspects or awaits it.
	 */
	observability?: ObservabilityContract | undefined;
}

export interface TurnPersistence {
	currentTurnUsage(): TokenSplit;
	lastTracedTurn(): { runId: string; usage: SessionTurnUsage | null } | null;
	/**
	 * While an engine run is active, a final assistant row only schedules the
	 * trace close: the run may still carry a middleware continuation, whose
	 * calls belong to the same operator turn. Turning the deferral off flushes a
	 * scheduled close.
	 */
	deferTraceClose(active: boolean): void;
	/** The run continues past the row that scheduled the close; keep the trace open. */
	continueTracedTurn(): void;
	traceEventForRun(runId: string, input: TurnTraceEventInput): void;
	/** True when this exact assistant message object was already persisted. */
	wasPersisted(message: unknown): boolean;
	appendAssistantTurn(
		message: AgentMessage,
		timing?: AssistantCallTiming | null,
		deliveryId?: string,
		interruptClosure?: { operatorCancel: boolean },
	): string | undefined;
	appendQueuedUserTurn(message: AgentMessage): void;
	appendToolCallTurn(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void;
	appendToolResultTurn(
		event: Extract<AgentEvent, { type: "tool_execution_end" }> & {
			durationMs?: number;
			resultSummary?: Record<string, unknown>;
			outcome?: string;
			blockReason?: string;
			actionClass?: string;
		},
	): void;
	/** Synthesized terminal row for a turn ended by a terminating tool result. */
	appendTerminalToolAssistantTurn(terminal: { toolCallId: string; toolName: string }): void;
	/**
	 * Persist the user turn. `text` is the composed prompt the model receives
	 * (reminder block, skill preamble, handoff, then the operator's words);
	 * `operatorText`, when it differs, is what the operator actually typed and
	 * is what a transcript replay renders under the operator marker.
	 * `displayText` is the literal editor input when an expansion (a prompt
	 * template or command) replaced it; the session picker and replay show it,
	 * while compaction keeps reasserting the expanded `operatorText`.
	 */
	appendSubmittedUserTurn(
		agentRuntime: AgentRuntime,
		text: string,
		images: ReadonlyArray<unknown> | undefined,
		synthetic: boolean,
		operatorText?: string,
		displayText?: string,
		id?: string,
		/** Machine provenance, persisted as `origin` so a replay attributes the turn. */
		origin?: string,
	): string | null;
	appendBudgetBlock(block: BudgetBlockData): void;
	appendRetryStatus(status: RetryStatusPayload): void;
	appendModelChangeEntry(target: ChatLoopTarget): void;
	appendThinkingLevelChangeEntry(thinkingLevel: string, effectiveEffort?: string): void;
}

/**
 * `runs.agent` for a session turn. The chat loop is the orchestrator itself: it
 * runs under no agent recipe, so this names what actually executed the turn
 * rather than inventing an agent id that no catalog would resolve.
 */
const SESSION_TRACE_AGENT = "orchestrator";

export interface TurnTraceEventInput {
	eventId?: string;
	type: string;
	name: string;
	payload?: unknown;
	tokens?: number | null;
	startedAt?: string;
	endedAt?: string | null;
}

export function createTurnPersistence(deps: TurnPersistenceDeps): TurnPersistence {
	const { state } = deps;
	const persistedAssistantMessages = new WeakSet<object>();
	const toolOwners = new Map<string, PackageIdentity>();

	// --- ledger appends -------------------------------------------------------
	// Every turn this loop writes parents onto `state.lastTurnId`, the loop's own
	// copy of the session leaf. session.append refuses a parent that is not the
	// session's current leaf, and a refusal used to leave that copy stale, so
	// every later submit failed the same way until the operator ran /resume.
	// A stale copy has one known producer: a caller of resetForSession that
	// passed a leaf captured before another turn landed. Whatever produced it,
	// the right parent is the session's real leaf, so re-sync to it and append
	// once more; a second refusal is a genuine session fault and propagates.
	const appendTurn = (session: SessionContract, turn: Omit<TurnInput, "parentId">): ClioTurnRecord => {
		try {
			return session.append({ ...turn, parentId: state.lastTurnId } as TurnInput);
		} catch (err) {
			const current = session.current();
			if (!current) throw err;
			const leaf = session.tree(current.id).leafId;
			if (leaf === state.lastTurnId) throw err;
			state.lastTurnId = leaf;
			return session.append({ ...turn, parentId: leaf } as TurnInput);
		}
	};

	// --- trace mirror ---------------------------------------------------------
	// One open runs/phases pair per operator turn, opened by the user row that
	// starts the turn and closed by the assistant row that ends it. Every helper
	// is a no-op without an observability contract or without an open turn, so a
	// session that resumes mid-turn contributes nothing rather than half a run.
	let traceRunId: string | null = null;
	let traceSessionId: string | null = null;
	let traceEventSeq = 0;
	let traceUsage: SessionTurnUsage | null = null;
	let lastTracedTurn: { runId: string; usage: SessionTurnUsage | null } | null = null;
	let usageSources = 0;
	let reportedUsageSources = 0;
	let measuredUsageSources = 0;
	const traceToolStarts = new Map<string, string>();
	// Trace rows and the terminal row name the capability a gateway op=call
	// ran. Its result may not name it (a refused capability), so the call's own
	// reading is kept until the call settles.
	const shownToolCalls = new Map<string, DisplayToolCall>();
	let terminalToolShown: { toolCallId: string; toolName: string; viaGateway: boolean } | null = null;

	const traceNow = (): string => new Date().toISOString();

	const mirror = (record: Parameters<ObservabilityContract["recordSessionTurn"]>[0] | null): void => {
		if (record === null) return;
		deps.observability?.recordSessionTurn(record);
	};

	let traceCloseDeferred = false;
	let scheduledTraceClose: { status: "success" | "fail"; error: string | null } | null = null;
	const closeTracedTurnAtFinalRow = (status: "success" | "fail", error: string | null): void => {
		if (traceCloseDeferred) scheduledTraceClose = { status, error };
		else finishTracedTurn(status, error);
	};

	// Once per turn (traceRunId clears on close) and only into the session the turn started in; an abandoned turn
	// closing after a /resume leaves the other session's meta alone. The meta is a projection of the journal fold,
	// so side calls and runs settled since the last turn land with this one (#434 §10).
	const projectSessionUsage = (): void => {
		if (traceSessionId === null || deps.session?.current()?.id !== traceSessionId) return;
		const usage = deps.observability?.sessionUsageProjection?.();
		if (!usage) return;
		try {
			deps.session.projectUsage(usage);
		} catch {
			// Spend on the resume picker is a convenience; the journal already holds the turn.
		}
	};

	const finishTracedTurn = (status: "success" | "fail", error: string | null): void => {
		scheduledTraceClose = null;
		if (traceRunId === null) return;
		mirror({ kind: "finish", runId: traceRunId, status, error, usage: traceUsage, at: traceNow() });
		projectSessionUsage();
		// Settlement runs after the assessor; keep the facts even though the trace is already closed.
		lastTracedTurn = { runId: traceRunId, usage: traceUsage };
		traceRunId = null;
		traceSessionId = null;
		traceUsage = null;
		traceToolStarts.clear();
		shownToolCalls.clear();
		toolOwners.clear();
	};

	const startTracedTurn = (userTurnId: string, prompt: string, submitted?: AgentRuntime): void => {
		lastTracedTurn = null;
		usageSources = 0;
		reportedUsageSources = 0;
		measuredUsageSources = 0;
		if (deps.observability === undefined) return;
		const runtime = submitted ?? state.runtime;
		if (!runtime) return;
		// A previous turn still open means it ended without a final assistant row
		// (an abort, or a stream that died). The operator submitting again is the
		// honest close for it; leaving it 'running' forever would be worse.
		finishTracedTurn("fail", "interrupted: a new operator turn started before the previous turn finished");
		traceRunId = `session:${userTurnId}`;
		traceSessionId = deps.session?.current()?.id ?? null;
		traceEventSeq = 0;
		mirror({
			kind: "start",
			runId: traceRunId,
			sessionId: traceSessionId,
			agent: SESSION_TRACE_AGENT,
			target: runtime.targetId,
			model: runtime.wireModelId,
			runtime: runtime.runtimeId,
			prompt: prompt.length > 0 ? prompt : null,
			at: traceNow(),
		});
	};

	const traceEventForRun = (runId: string, input: TurnTraceEventInput): void => {
		traceEventSeq += 1;
		mirror({
			kind: "event",
			runId,
			eventId: input.eventId ?? `event:${traceEventSeq}`,
			type: input.type,
			name: input.name,
			...(input.payload === undefined ? {} : { payload: input.payload }),
			tokens: input.tokens ?? null,
			startedAt: input.startedAt ?? traceNow(),
			endedAt: input.endedAt ?? null,
		});
	};
	const traceEvent = (input: TurnTraceEventInput): void => {
		if (traceRunId !== null) traceEventForRun(traceRunId, input);
	};

	/** Fold one assistant message's provider-reported usage into the turn total. */
	const accumulateTraceUsage = (message: AgentMessage): void => {
		if (traceRunId === null) return;
		const summary = sumRunUsage([message]);
		const rawUsage = messageUsageForAccounting(message) ?? {};
		if (summary.costSummary ? !summary.hadUsage : rawUsage.callInvoked === false) return;
		const reported = normalizeTokenUsage(rawUsage);
		const apiCalls = summary.costSummary ? summary.apiCalls : 1;
		const missingTokenCalls = summary.costSummary ? (summary.missingTokenCalls ?? 0) : reported.observed ? 0 : 1;
		usageSources += apiCalls;
		reportedUsageSources += apiCalls - missingTokenCalls;
		const calls = messageCallsForAccounting(message);
		measuredUsageSources += calls
			? calls.filter((call) => call.disposition === "settled").length
			: reported.observed
				? 1
				: 0;
		const total: SessionTurnUsage = traceUsage ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: 0,
			costUsd: 0,
		};
		const pricing = resolveCostProvenance(
			rawUsage.costProvenance,
			normalizeCostProvenance(state.runtime?.runtimeResolution.costProvenance),
		);
		const costSummary = aggregateCostAmounts([
			...(total.costSummary
				? [{ usd: total.costSummary.knownUsd, provenance: pricing, costSummary: total.costSummary }]
				: []),
			{
				usd: summary.costUsd,
				provenance: pricing,
				apiCalls,
				missingTokenCalls,
				...(summary.costSummary ? { costSummary: summary.costSummary } : {}),
			},
		]);
		traceUsage = {
			inputTokens: total.inputTokens + summary.input,
			outputTokens: total.outputTokens + summary.output,
			cacheReadTokens: total.cacheReadTokens + summary.cacheRead,
			cacheWriteTokens: total.cacheWriteTokens + summary.cacheWrite,
			...(total.cacheWrite1hTokens === undefined && summary.cacheWrite1h === undefined
				? {}
				: { cacheWrite1hTokens: (total.cacheWrite1hTokens ?? 0) + (summary.cacheWrite1h ?? 0) }),
			reasoningTokens: total.reasoningTokens + summary.reasoning,
			totalTokens: total.totalTokens + summary.tokens,
			costUsd: costSummary.hasUnknown && costSummary.knownUsd === 0 ? null : costSummary.knownUsd,
			costSummary,
			apiCalls: (total.apiCalls ?? 0) + apiCalls,
			missingTokenCalls: (total.missingTokenCalls ?? 0) + missingTokenCalls,
		};
	};

	const appendAssistantTurn = (
		message: AgentMessage,
		timing?: AssistantCallTiming | null,
		deliveryId?: string,
		interruptClosure?: { operatorCancel: boolean },
	): string | undefined => {
		if (message?.role !== "assistant") return;
		if (persistedAssistantMessages.has(message)) return;
		// Keep hollow-call accounting on the warning closure without rendering a second turn (#430).
		if (state.activeInterruptReason !== null && isEmptyAbortedAssistantMessage(message)) {
			state.interruptedCall = { message, timing: timing ?? null };
			return;
		}
		if (explainInterruptedAssistant(message, state.activeInterruptReason)) state.interruptedAssistantMessage = message;
		const failure = terminalFailureFromAssistantMessage(message);
		const payload = assistantSessionPayload(message, failure);
		// Only the host argument can mark a closure; provider fields cannot opt into this presentation (#430).
		if (interruptClosure !== undefined) payload.interruptClosure = interruptClosure;
		const transport = (message as { codexTransport?: CodexTransportObservation }).codexTransport;
		if (transport) payload.codexTransport = transport;
		const quota = (message as { codexQuota?: CodexQuotaObservation }).codexQuota;
		if (quota && state.runtime?.runtimeId === "openai-codex") {
			noteCodexStreamQuota(state.runtime.targetId, quota);
			payload.codexQuota = quota;
		}
		const anthropicResponse = (message as { anthropicResponse?: AnthropicResponseObservation }).anthropicResponse;
		if (message.api === "anthropic-messages" && anthropicResponse) payload.anthropicResponse = anthropicResponse;
		if (anthropicResponse && state.runtime?.runtimeId === "anthropic-max") {
			const auth = state.runtime.lastAuthResolution;
			noteAnthropicStreamQuota(
				state.runtime.targetId,
				anthropicResponse,
				auth?.source === "stored-oauth" ? auth.providerId : null,
			);
		}
		if (timing) {
			payload.timing = timing;
			payload.apiMs = timing.apiMs;
		} else if (messageUsageForAccounting(message)?.callInvoked === false || payload.callInvoked === false) {
			payload.apiMs = 0;
		}
		if (deliveryId) {
			payload.continuityDeliveryId = deliveryId;
			payload.stopReason = message.stopReason;
		}
		// A synthetic notice is not output, so it can only carry the hollow call's display estimate (#423, #430).
		const interruptedUsage =
			(message as { estimatedUsage?: Record<string, unknown> }).estimatedUsage ??
			(interruptClosure === undefined ? estimatedUsageForInterruptedTurn(message, deps.promptSideTokens()) : null);
		if (payload.callInvoked !== false && interruptedUsage !== null) payload.estimatedUsage = interruptedUsage;

		if (isLengthStopAssistantMessage(message) && state.runtime) {
			const contextExhaustion = recordValue(payload.contextExhaustion);
			const contextWindow = state.runtime.runtimeResolution.capabilityDecisions.contextWindow;
			if (contextExhaustion && contextWindow > 0) contextExhaustion.contextWindow = contextWindow;
		}
		accumulateTraceUsage(message);
		// The turn is over unless this message asked for tools. A message the
		// ledger declines to keep still ended the turn, so the mirror closes on
		// the same signal either way rather than on persistence.
		const turnContinues = hasStructuredToolCall(message);
		if (!deps.session || !hasPersistableAssistantContent(payload, failure)) {
			if (!turnContinues) closeTracedTurnAtFinalRow(failure ? "fail" : "success", failure?.errorMessage ?? null);
			return;
		}
		// #423: only persisted calls advance the cache comparison baseline.
		const usage = (message as { usage?: Usage }).usage;
		if (usage && typeof usage === "object") {
			const backendTimings = (message as { backendTimings?: BackendCompletionTimings }).backendTimings;
			payload.promptCache = deps.promptCachePayloadForAssistant(usage, backendTimings, anthropicResponse, transport);
		}
		if (message && typeof message === "object") persistedAssistantMessages.add(message as object);
		const turn = appendTurn(deps.session, {
			kind: "assistant",
			payload,
		});
		if (
			payload.callInvoked === false ||
			recordValue(payload.usage)?.callInvoked === false ||
			recordValue(payload.failure)?.invoked === false
		) {
			deps.observability?.recordNeverSentCalls(1);
		}
		state.lastTurnId = turn.id;
		traceEvent({
			type: "message",
			name: "assistant",
			payload: {
				text: payload.text,
				stopReason: payload.stopReason ?? null,
				model: payload.model ?? null,
				toolCalls: turnContinues,
			},
			tokens: traceUsage?.totalTokens ?? null,
		});
		if (!turnContinues) closeTracedTurnAtFinalRow(failure ? "fail" : "success", failure?.errorMessage ?? null);
		return turn.id;
	};

	return {
		lastTracedTurn: () =>
			lastTracedTurn === null
				? null
				: { runId: lastTracedTurn.runId, usage: lastTracedTurn.usage === null ? null : { ...lastTracedTurn.usage } },
		traceEventForRun,
		deferTraceClose(active) {
			traceCloseDeferred = active;
			const scheduled = scheduledTraceClose;
			if (!active && scheduled !== null) finishTracedTurn(scheduled.status, scheduled.error);
		},
		continueTracedTurn() {
			scheduledTraceClose = null;
		},
		currentTurnUsage() {
			const usage = traceUsage ?? lastTracedTurn?.usage;
			return {
				inputTokens: usage?.inputTokens ?? 0,
				outputTokens: usage?.outputTokens ?? 0,
				cacheReadTokens: usage?.cacheReadTokens ?? 0,
				totalTokens: usage?.totalTokens ?? 0,
				provenance: measuredUsageSources === 0 ? "none" : reportedUsageSources === usageSources ? "reported" : "partial",
			};
		},
		wasPersisted(message: unknown): boolean {
			return !!message && typeof message === "object" && persistedAssistantMessages.has(message as object);
		},

		appendAssistantTurn,

		appendQueuedUserTurn(message: AgentMessage): void {
			if (message?.role !== "user") return;
			// Byte-exact. Trimming here wrote a second, shortened row that the
			// assistant then parented to, so the model's parent turn disagreed with
			// the expansion the operator actually submitted: `/raw   bar` produced a
			// correct 5-byte row and a 3-byte one, and the 3-byte one won (issue
			// #244). Only the emptiness test reads the trimmed form, and the
			// echo/mirror lookups match on the same bytes the engine was given, so a
			// payload with edge whitespace is recognized as the echo it is instead
			// of being persisted a second time.
			const text = extractUserText(message);
			if (deps.consumePersistedEcho(text)) {
				if (state.activeUserTurnId) setEngineCodexUserTurn(message, state.activeUserTurnId);
				return;
			}
			if (text.trim().length === 0) return;
			const origin = deps.removeQueuedMirrorEntry(text);
			if (!deps.session) return;
			if (!deps.session.current()) {
				const settings = deps.getSettings();
				const input: { cwd: string; target?: string; model?: string } = { cwd: process.cwd() };
				if (settings.chat.target) input.target = settings.chat.target;
				if (settings.chat.model) input.model = settings.chat.model;
				deps.session.create(input);
			}
			this.appendThinkingLevelChangeEntry(
				deps.getSettings().chat.thinkingLevel ?? "off",
				state.runtime?.runtimeResolution.modelRuntime.thinking.effort ??
					state.runtime?.runtimeResolution.effectiveThinkingLevel,
			);
			const userTurn = appendTurn(deps.session, {
				kind: "user",
				payload: origin === undefined ? { text } : { text, origin },
			});
			state.lastTurnId = userTurn.id;
			state.activeUserTurnId = userTurn.id;
			setEngineCodexUserTurn(message, userTurn.id);
			if (state.runtime && deps.readSessionEntries) {
				const prior = state.runtime.agent.state.messages;
				const retired = retireActiveUserContextForNextOperator(prior, deps.readSessionEntries(), {
					activeLeafTurnId: userTurn.id,
				});
				if (retired.length < prior.length) replaceEngineMessages(state.runtime.agent, retired);
			}
			state.synthesisToolLock = false;
			state.toolBudgetLock = false;
			deps.middlewareToolChoice.reset();
			startTracedTurn(userTurn.id, text);
		},

		appendToolCallTurn(event): void {
			if (!deps.session) return;
			const shown = displayToolCall(event.toolName, event.args);
			const owner = deps.getToolOwner?.(shown.toolName);
			if (owner) toolOwners.set(event.toolCallId, owner);
			for (const step of gatewayChainPlan(event.toolName, event.args)) {
				const stepOwner = deps.getToolOwner?.(step.capability);
				if (stepOwner) toolOwners.set(chainStepToolCallId(event.toolCallId, step.id), stepOwner);
			}
			const turn = appendTurn(deps.session, {
				kind: "tool_call",
				payload: {
					toolCallId: event.toolCallId,
					name: event.toolName,
					args: event.args,
					...(owner ? { owner } : {}),
				},
			});
			state.lastTurnId = turn.id;
			const startedAt = traceNow();
			traceToolStarts.set(event.toolCallId, startedAt);
			shownToolCalls.set(event.toolCallId, shown);
			traceEvent({
				eventId: `tool:${event.toolCallId}`,
				type: "tool_call",
				name: shown.toolName,
				payload: {
					tool: shown.toolName,
					tool_call_id: event.toolCallId,
					args: shown.viaGateway ? (shown.args ?? {}) : event.args,
					...(owner ? { owner } : {}),
					...(shown.viaGateway ? { via: VIA_GATEWAY } : {}),
				},
				startedAt,
			});
		},

		appendToolResultTurn(event): void {
			if (!deps.session) return;
			const owner = toolOwners.get(event.toolCallId);
			toolOwners.delete(event.toolCallId);
			const payload: Record<string, unknown> = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
				resultSummary: event.resultSummary ?? toolResultSummary(event.result),
				...(owner ? { owner } : {}),
			};
			if (event.durationMs !== undefined) payload.durationMs = event.durationMs;
			// The admission verdict, so a resumed session and an exported
			// transcript label a blocked call the same way the live panel did
			// instead of re-deriving it from result text.
			if (event.outcome !== undefined) payload.outcome = event.outcome;
			if (event.blockReason !== undefined) payload.blockReason = event.blockReason;
			// Admission's action class, so a resumed session classifies an unknown
			// dynamic tool by the same rule the live row used.
			if (event.actionClass !== undefined) payload.actionClass = event.actionClass;
			const turn = appendTurn(deps.session, {
				kind: "tool_result",
				payload,
			});
			state.lastTurnId = turn.id;
			// Same event row as the call, completed in place: `clio-coder trace tail`
			// shows one line per tool call carrying the E14 verdict fields, which
			// is what "what did this turn actually execute" means.
			const endedAt = traceNow();
			const startedAt = traceToolStarts.get(event.toolCallId) ?? endedAt;
			traceToolStarts.delete(event.toolCallId);
			const result = event.result as { details?: unknown; terminate?: unknown } | undefined;
			const shown = shownToolCalls.get(event.toolCallId) ?? displayToolCall(event.toolName, undefined, result?.details);
			shownToolCalls.delete(event.toolCallId);
			traceEvent({
				eventId: `tool:${event.toolCallId}`,
				type: "tool_call",
				name: shown.toolName,
				payload: {
					tool: shown.toolName,
					tool_call_id: event.toolCallId,
					...(shown.viaGateway ? { via: VIA_GATEWAY } : {}),
					args: shown.args ?? (shown.viaGateway ? {} : null),
					ok: event.isError !== true && event.outcome !== "error" && event.outcome !== "blocked",
					duration_ms: event.durationMs ?? null,
					result_summary: payload.resultSummary,
					...(owner ? { owner } : {}),
					outcome: event.outcome ?? null,
					block_reason: event.blockReason ?? null,
				},
				startedAt,
				endedAt,
			});
			// A chain's settled steps are spans of their own, named by capability
			// and linked to the chain call; the ledger keeps the one aggregate.
			const steps = gatewayChainSteps(event.toolName, event.result);
			for (const step of steps) {
				const stepCallId = chainStepToolCallId(event.toolCallId, step.id);
				const stepOwner = toolOwners.get(stepCallId);
				toolOwners.delete(stepCallId);
				traceEvent({
					eventId: `tool:${stepCallId}`,
					type: "tool_call",
					name: step.capability,
					payload: {
						tool: step.capability,
						tool_call_id: stepCallId,
						parent_tool_call_id: event.toolCallId,
						via: VIA_GATEWAY,
						args: step.args,
						...(stepOwner ? { owner: stepOwner } : {}),
						ok: !step.isError && step.outcome !== "blocked",
						outcome: step.outcome ?? null,
						block_reason: step.blockReason ?? null,
					},
					startedAt,
					endedAt,
				});
			}
			const terminalStep = steps.find((step) => step.terminate === true);
			terminalToolShown =
				result?.terminate === true
					? {
							toolCallId: event.toolCallId,
							toolName: terminalStep?.capability ?? shown.toolName,
							viaGateway: terminalStep !== undefined || shown.viaGateway,
						}
					: null;
		},

		appendTerminalToolAssistantTurn(terminal): void {
			if (!deps.session) return;
			// The synthesized row names the capability that ended the turn. It is
			// no provider message, so the wire name `gateway` has nothing to replay.
			const shown =
				terminalToolShown?.toolCallId === terminal.toolCallId
					? terminalToolShown
					: { toolName: terminal.toolName, viaGateway: false };
			terminalToolShown = null;
			const named = {
				toolName: shown.toolName,
				...(shown.viaGateway ? { via: VIA_GATEWAY } : {}),
			};
			const turn = appendTurn(deps.session, {
				kind: "assistant",
				payload: {
					text: "",
					stopReason: "stop",
					terminalToolResult: true,
					toolCallId: terminal.toolCallId,
					...named,
				},
			});
			state.lastTurnId = turn.id;
			traceEvent({
				type: "message",
				name: "assistant",
				payload: { terminalToolResult: true, ...named, toolCallId: terminal.toolCallId },
			});
			finishTracedTurn("success", null);
		},

		appendSubmittedUserTurn(agentRuntime, text, images, synthetic, operatorText, displayText, id, origin): string | null {
			if (!deps.session) return null;
			if (!deps.session.current()) {
				deps.session.create({
					cwd: process.cwd(),
					target: agentRuntime.targetId,
					model: agentRuntime.wireModelId,
				});
			}
			this.appendThinkingLevelChangeEntry(
				agentRuntime.runtimeResolution.requestedThinkingLevel,
				agentRuntime.runtimeResolution.modelRuntime.thinking.effort ??
					agentRuntime.runtimeResolution.effectiveThinkingLevel,
			);
			const payload: Record<string, unknown> = images ? { content: [{ type: "text", text }, ...images] } : { text };
			if (operatorText !== undefined && operatorText !== text) payload.operatorText = operatorText;
			if (displayText !== undefined && displayText !== (operatorText ?? text)) payload.displayText = displayText;
			if (origin !== undefined) payload.origin = origin;
			if (synthetic) {
				payload.synthetic = true;
				payload.source = "middleware_request_continuation";
			}
			const userTurn = appendTurn(deps.session, {
				...(id === undefined ? {} : { id }),
				kind: "user",
				payload,
			});
			state.lastTurnId = userTurn.id;
			state.activeUserTurnId = userTurn.id;
			state.synthesisToolLock = false;
			state.toolBudgetLock = false;
			const sessionId = deps.session.current()?.id ?? null;
			if (sessionId) {
				agentRuntime.agent.sessionId = sessionId;
			}
			// The submitted runtime identity is the authority here: state.runtime is
			// only set once the turn's agent is built, and a first submit runs
			// before it.
			startTracedTurn(userTurn.id, text, agentRuntime);
			return userTurn.id;
		},

		appendBudgetBlock(block): void {
			if (!deps.session?.current()) return;
			deps.session.appendEntry({
				kind: "custom",
				parentTurnId: state.lastTurnId,
				customType: BUDGET_BLOCK_ENTRY,
				display: true,
				data: block,
			});
		},

		appendRetryStatus(status): void {
			if (!deps.session?.current()) return;
			deps.session.appendEntry({
				kind: "custom",
				parentTurnId: state.lastTurnId,
				customType: "retryStatus",
				display: true,
				data: status,
			});
		},

		/**
		 * Append a `modelChange` session entry so /resume and /fork can replay the
		 * sequence of models a long-running session ran under. Silent no-op when
		 * the session contract is absent or no session is current. The
		 * orchestrator's chat-loop is the only writer; chat-renderer.ts already
		 * knows how to display the entry.
		 */
		appendModelChangeEntry(target): void {
			if (!deps.session?.current()) return;
			try {
				deps.session.appendEntry({
					kind: "modelChange",
					parentTurnId: state.lastTurnId,
					provider: target.runtime.id,
					modelId: target.wireModelId,
					target: target.target.id,
				});
			} catch {
				// Persistence failures must not break chat. The marker is a
				// best-effort breadcrumb; absence falls back to current behavior.
			}
		},

		/**
		 * Append a `thinkingLevelChange` entry for the requested level, the
		 * thinking half of the route /resume restores (see
		 * domains/session/resumed-route.ts). Same best-effort contract as
		 * appendModelChangeEntry.
		 */
		appendThinkingLevelChangeEntry(thinkingLevel, effectiveEffort): void {
			const model = state.runtime?.agent.state.model;
			if (effectiveEffort !== undefined && model?.api === "openai-codex-responses") {
				const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
				effectiveEffort = map?.[effectiveEffort] ?? (effectiveEffort === "off" ? "none" : effectiveEffort);
			}
			if (!deps.session?.current()) return;
			try {
				appendSessionThinkingLevel(deps.session, thinkingLevel, effectiveEffort, state.lastTurnId);
			} catch {
				// Same as appendModelChangeEntry: a lost marker only means resume
				// falls back to its recorded level or configured default.
			}
		},
	};
}
