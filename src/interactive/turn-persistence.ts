/**
 * Session-ledger persistence for the chat loop: assistant, user, tool-call,
 * tool-result, retry-status, and model-change rows, plus the queued-user-echo
 * handshake with the queue mirror. Owns the ledger cursor semantics: every
 * append advances `state.lastTurnId`.
 */

import type { ClioSettings } from "../core/config.js";
import type { MiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import type { SessionTurnUsage } from "../domains/observability/trace-store.js";
import type { SessionContract, TurnInput } from "../domains/session/contract.js";
import type { ClioTurnRecord } from "../engine/session.js";
import type { AgentEvent, AgentMessage, Usage } from "../engine/types.js";
import {
	type AssistantCallTiming,
	assistantSessionPayload,
	estimatedUsageForInterruptedTurn,
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
import type { RetryStatusPayload } from "./turn-recovery.js";
import type { AgentRuntime, ChatLoopTarget, ChatTurnState } from "./turn-state.js";

export interface TurnPersistenceDeps {
	state: ChatTurnState;
	session?: SessionContract | undefined;
	getSettings: () => Readonly<ClioSettings>;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	/** Consume a user text the loop already persisted itself (echo dedupe). */
	consumePersistedEcho: (text: string) => boolean;
	/** Remove a queued-mirror entry once the engine injects it. */
	removeQueuedMirrorEntry: (text: string) => void;
	/** Prompt-cache record for a persisted assistant call (T3.2 + cold stamp). */
	promptCachePayloadForAssistant: (usage: Usage) => Record<string, unknown>;
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
	/** True when this exact assistant message object was already persisted. */
	wasPersisted(message: unknown): boolean;
	appendAssistantTurn(message: AgentMessage, timing?: AssistantCallTiming | null): void;
	appendQueuedUserTurn(message: AgentMessage): void;
	appendToolCallTurn(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void;
	appendToolResultTurn(
		event: Extract<AgentEvent, { type: "tool_execution_end" }> & {
			durationMs?: number;
			resultSummary?: Record<string, unknown>;
			outcome?: string;
			blockReason?: string;
		},
	): void;
	/** Synthesized terminal row for a turn ended by a terminating tool result. */
	appendTerminalToolAssistantTurn(terminal: { toolCallId: string; toolName: string }): void;
	/**
	 * Persist the user turn. `text` is the composed prompt the model receives
	 * (reminder block, skill preamble, handoff, then the operator's words);
	 * `operatorText`, when it differs, is what the operator actually typed and
	 * is what a transcript replay renders under the operator marker.
	 */
	appendSubmittedUserTurn(
		agentRuntime: AgentRuntime,
		text: string,
		images: ReadonlyArray<unknown> | undefined,
		synthetic: boolean,
		operatorText?: string,
	): string | null;
	appendRetryStatus(status: RetryStatusPayload): void;
	appendModelChangeEntry(target: ChatLoopTarget): void;
}

/**
 * `runs.agent` for a session turn. The chat loop is the orchestrator itself: it
 * runs under no agent recipe, so this names what actually executed the turn
 * rather than inventing an agent id that no catalog would resolve.
 */
const SESSION_TRACE_AGENT = "orchestrator";

export function createTurnPersistence(deps: TurnPersistenceDeps): TurnPersistence {
	const { state } = deps;
	const persistedAssistantMessages = new WeakSet<object>();

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
	let traceEventSeq = 0;
	let traceUsage: SessionTurnUsage | null = null;
	const traceToolStarts = new Map<string, string>();

	const traceNow = (): string => new Date().toISOString();

	const mirror = (record: Parameters<ObservabilityContract["recordSessionTurn"]>[0] | null): void => {
		if (record === null) return;
		deps.observability?.recordSessionTurn(record);
	};

	const finishTracedTurn = (status: "success" | "fail", error: string | null): void => {
		if (traceRunId === null) return;
		mirror({ kind: "finish", runId: traceRunId, status, error, usage: traceUsage, at: traceNow() });
		traceRunId = null;
		traceUsage = null;
		traceToolStarts.clear();
	};

	const startTracedTurn = (userTurnId: string, prompt: string, submitted?: AgentRuntime): void => {
		if (deps.observability === undefined) return;
		const runtime = submitted ?? state.runtime;
		if (!runtime) return;
		// A previous turn still open means it ended without a final assistant row
		// (an abort, or a stream that died). The operator submitting again is the
		// honest close for it; leaving it 'running' forever would be worse.
		finishTracedTurn("success", null);
		traceRunId = `session:${userTurnId}`;
		traceEventSeq = 0;
		mirror({
			kind: "start",
			runId: traceRunId,
			agent: SESSION_TRACE_AGENT,
			target: runtime.targetId,
			model: runtime.wireModelId,
			runtime: runtime.runtimeId,
			prompt: prompt.length > 0 ? prompt : null,
			at: traceNow(),
		});
	};

	const traceEvent = (input: {
		eventId?: string;
		type: string;
		name: string;
		payload?: unknown;
		tokens?: number | null;
		startedAt?: string;
		endedAt?: string | null;
	}): void => {
		if (traceRunId === null) return;
		traceEventSeq += 1;
		mirror({
			kind: "event",
			runId: traceRunId,
			eventId: input.eventId ?? `event:${traceEventSeq}`,
			type: input.type,
			name: input.name,
			...(input.payload === undefined ? {} : { payload: input.payload }),
			tokens: input.tokens ?? null,
			startedAt: input.startedAt ?? traceNow(),
			endedAt: input.endedAt ?? null,
		});
	};

	/** Fold one assistant message's provider-reported usage into the turn total. */
	const accumulateTraceUsage = (message: AgentMessage): void => {
		if (traceRunId === null) return;
		const summary = sumRunUsage([message]);
		if (!summary.hadUsage) return;
		const total: SessionTurnUsage = traceUsage ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: 0,
			costUsd: 0,
		};
		traceUsage = {
			inputTokens: total.inputTokens + summary.input,
			outputTokens: total.outputTokens + summary.output,
			cacheReadTokens: total.cacheReadTokens + summary.cacheRead,
			cacheWriteTokens: total.cacheWriteTokens + summary.cacheWrite,
			reasoningTokens: total.reasoningTokens + summary.reasoning,
			totalTokens: total.totalTokens + summary.tokens,
			costUsd: (total.costUsd ?? 0) + summary.costUsd,
		};
	};

	const appendAssistantTurn = (message: AgentMessage, timing?: AssistantCallTiming | null): void => {
		if (message?.role !== "assistant") return;
		// A loop-guard interrupt already persisted a durable closing turn with the
		// stop reason; drop the empty aborted message the abort leaves behind so
		// the operator does not see a hollow "request aborted" turn after it.
		if (state.activeInterruptReason !== null && isEmptyAbortedAssistantMessage(message)) return;
		const failure = terminalFailureFromAssistantMessage(message);
		const payload = assistantSessionPayload(message, failure);
		if (timing) payload.timing = timing;
		const usage = (message as { usage?: Usage }).usage;
		if (usage && typeof usage === "object") {
			payload.promptCache = deps.promptCachePayloadForAssistant(usage);
		}
		// A cancelled turn's provider usage is the object the stream started with
		// and never updated. Record what the call is known to have spent instead of
		// the zeros, in the shape a completed turn uses and flagged as an estimate.
		const interruptedUsage = estimatedUsageForInterruptedTurn(message, deps.promptSideTokens());
		if (interruptedUsage !== null) payload.usage = interruptedUsage;
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
			if (!turnContinues) finishTracedTurn(failure ? "fail" : "success", failure?.errorMessage ?? null);
			return;
		}
		if (message && typeof message === "object") persistedAssistantMessages.add(message as object);
		const turn = appendTurn(deps.session, {
			kind: "assistant",
			payload,
		});
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
		if (!turnContinues) finishTracedTurn(failure ? "fail" : "success", failure?.errorMessage ?? null);
	};

	return {
		wasPersisted(message: unknown): boolean {
			return !!message && typeof message === "object" && persistedAssistantMessages.has(message as object);
		},

		appendAssistantTurn,

		appendQueuedUserTurn(message: AgentMessage): void {
			if (message?.role !== "user") return;
			const text = extractUserText(message).trim();
			if (text.length === 0) return;
			if (deps.consumePersistedEcho(text)) return;
			deps.removeQueuedMirrorEntry(text);
			if (!deps.session) return;
			if (!deps.session.current()) {
				const settings = deps.getSettings();
				const input: { cwd: string; target?: string; model?: string } = { cwd: process.cwd() };
				if (settings.orchestrator.target) input.target = settings.orchestrator.target;
				if (settings.orchestrator.model) input.model = settings.orchestrator.model;
				deps.session.create(input);
			}
			const userTurn = appendTurn(deps.session, {
				kind: "user",
				payload: { text },
			});
			state.lastTurnId = userTurn.id;
			state.activeUserTurnId = userTurn.id;
			state.synthesisToolLock = false;
			deps.middlewareToolChoice.reset();
			startTracedTurn(userTurn.id, text);
		},

		appendToolCallTurn(event): void {
			if (!deps.session) return;
			const turn = appendTurn(deps.session, {
				kind: "tool_call",
				payload: {
					toolCallId: event.toolCallId,
					name: event.toolName,
					args: event.args,
				},
			});
			state.lastTurnId = turn.id;
			const startedAt = traceNow();
			traceToolStarts.set(event.toolCallId, startedAt);
			traceEvent({
				eventId: `tool:${event.toolCallId}`,
				type: "tool_call",
				name: event.toolName,
				payload: { tool: event.toolName, tool_call_id: event.toolCallId, args: event.args },
				startedAt,
			});
		},

		appendToolResultTurn(event): void {
			if (!deps.session) return;
			const payload: Record<string, unknown> = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
				resultSummary: event.resultSummary ?? toolResultSummary(event.result),
			};
			if (event.durationMs !== undefined) payload.durationMs = event.durationMs;
			// The admission verdict, so a resumed session and an exported
			// transcript label a blocked call the same way the live panel did
			// instead of re-deriving it from result text.
			if (event.outcome !== undefined) payload.outcome = event.outcome;
			if (event.blockReason !== undefined) payload.blockReason = event.blockReason;
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
			traceEvent({
				eventId: `tool:${event.toolCallId}`,
				type: "tool_call",
				name: event.toolName,
				payload: {
					tool: event.toolName,
					tool_call_id: event.toolCallId,
					ok: event.isError !== true && event.outcome !== "error" && event.outcome !== "blocked",
					duration_ms: event.durationMs ?? null,
					result_summary: payload.resultSummary,
					outcome: event.outcome ?? null,
					block_reason: event.blockReason ?? null,
				},
				startedAt,
				endedAt,
			});
		},

		appendTerminalToolAssistantTurn(terminal): void {
			if (!deps.session) return;
			const turn = appendTurn(deps.session, {
				kind: "assistant",
				payload: {
					text: "",
					stopReason: "stop",
					terminalToolResult: true,
					toolCallId: terminal.toolCallId,
					toolName: terminal.toolName,
				},
			});
			state.lastTurnId = turn.id;
			traceEvent({
				type: "message",
				name: "assistant",
				payload: { terminalToolResult: true, toolName: terminal.toolName, toolCallId: terminal.toolCallId },
			});
			finishTracedTurn("success", null);
		},

		appendSubmittedUserTurn(agentRuntime, text, images, synthetic, operatorText): string | null {
			if (!deps.session) return null;
			if (!deps.session.current()) {
				deps.session.create({
					cwd: process.cwd(),
					target: agentRuntime.targetId,
					model: agentRuntime.wireModelId,
				});
			}
			const payload: Record<string, unknown> = images ? { content: [{ type: "text", text }, ...images] } : { text };
			if (operatorText !== undefined && operatorText !== text) payload.operatorText = operatorText;
			if (synthetic) {
				payload.synthetic = true;
				payload.source = "middleware_request_continuation";
			}
			const userTurn = appendTurn(deps.session, {
				kind: "user",
				payload,
			});
			state.lastTurnId = userTurn.id;
			state.activeUserTurnId = userTurn.id;
			state.synthesisToolLock = false;
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
	};
}
