/**
 * Session-ledger persistence for the chat loop: assistant, user, tool-call,
 * tool-result, retry-status, and model-change rows, plus the queued-user-echo
 * handshake with the queue mirror. Owns the ledger cursor semantics: every
 * append advances `state.lastTurnId`.
 */

import type { ClioSettings } from "../core/config.js";
import type { MiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { AgentEvent, AgentMessage, Usage } from "../engine/types.js";
import {
	type AssistantCallTiming,
	assistantSessionPayload,
	estimatedUsageForInterruptedTurn,
	extractUserText,
	hasPersistableAssistantContent,
	isEmptyAbortedAssistantMessage,
	isLengthStopAssistantMessage,
	recordValue,
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
		},
	): void;
	/** Synthesized terminal row for a turn ended by a terminating tool result. */
	appendTerminalToolAssistantTurn(terminal: { toolCallId: string; toolName: string }): void;
	appendSubmittedUserTurn(
		agentRuntime: AgentRuntime,
		text: string,
		images: ReadonlyArray<unknown> | undefined,
		synthetic: boolean,
	): string | null;
	appendRetryStatus(status: RetryStatusPayload): void;
	appendModelChangeEntry(target: ChatLoopTarget): void;
}

export function createTurnPersistence(deps: TurnPersistenceDeps): TurnPersistence {
	const { state } = deps;
	const persistedAssistantMessages = new WeakSet<object>();

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
		if (!deps.session || !hasPersistableAssistantContent(payload, failure)) return;
		if (message && typeof message === "object") persistedAssistantMessages.add(message as object);
		const turn = deps.session.append({
			kind: "assistant",
			parentId: state.lastTurnId,
			payload,
		});
		state.lastTurnId = turn.id;
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
			const userTurn = deps.session.append({
				kind: "user",
				parentId: state.lastTurnId,
				payload: { text },
			});
			state.lastTurnId = userTurn.id;
			state.activeUserTurnId = userTurn.id;
			state.synthesisToolLock = false;
			deps.middlewareToolChoice.reset();
		},

		appendToolCallTurn(event): void {
			if (!deps.session) return;
			const turn = deps.session.append({
				kind: "tool_call",
				parentId: state.lastTurnId,
				payload: {
					toolCallId: event.toolCallId,
					name: event.toolName,
					args: event.args,
				},
			});
			state.lastTurnId = turn.id;
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
			const turn = deps.session.append({
				kind: "tool_result",
				parentId: state.lastTurnId,
				payload,
			});
			state.lastTurnId = turn.id;
		},

		appendTerminalToolAssistantTurn(terminal): void {
			if (!deps.session) return;
			const turn = deps.session.append({
				kind: "assistant",
				parentId: state.lastTurnId,
				payload: {
					text: "",
					stopReason: "stop",
					terminalToolResult: true,
					toolCallId: terminal.toolCallId,
					toolName: terminal.toolName,
				},
			});
			state.lastTurnId = turn.id;
		},

		appendSubmittedUserTurn(agentRuntime, text, images, synthetic): string | null {
			if (!deps.session) return null;
			if (!deps.session.current()) {
				deps.session.create({
					cwd: process.cwd(),
					target: agentRuntime.targetId,
					model: agentRuntime.wireModelId,
				});
			}
			const payload: Record<string, unknown> = images ? { content: [{ type: "text", text }, ...images] } : { text };
			if (synthetic) {
				payload.synthetic = true;
				payload.source = "middleware_request_continuation";
			}
			const userTurn = deps.session.append({
				kind: "user",
				parentId: state.lastTurnId,
				payload,
			});
			state.lastTurnId = userTurn.id;
			state.activeUserTurnId = userTurn.id;
			state.synthesisToolLock = false;
			const sessionId = deps.session.current()?.id ?? null;
			if (sessionId) {
				agentRuntime.agent.sessionId = sessionId;
			}
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
