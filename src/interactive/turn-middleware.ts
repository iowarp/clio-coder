/**
 * Middleware turn hooks for the chat loop: turn_start / turn_end /
 * on_compaction dispatch, the pending-reminder buffer that flushes into the
 * next request, hard-block interrupts, and the stalled-turn continuation
 * nudge. Owns every `deps.middleware` interaction of the loop.
 */

import {
	MIDDLEWARE_HOOK_TEXT_MAX_CHARS,
	type MiddlewareContract,
	type MiddlewareEffect,
	type MiddlewareHookInput,
	type MiddlewareMetadataValue,
	type MiddlewareReminderSeverity,
	type MiddlewareToolChoiceControl,
} from "../domains/middleware/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { CompactionTrigger } from "../domains/session/entries.js";
import type { AgentMessage } from "../engine/types.js";
import { extractText, hasStructuredToolCall, toolNamesFromAgentState } from "./chat-loop-messages.js";
import type { AgentRuntime, ChatTurnState } from "./turn-state.js";

export interface TurnMiddlewareDeps {
	state: ChatTurnState;
	middleware?: MiddlewareContract | undefined;
	session?: SessionContract | undefined;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	emitNotice: (text: string) => void;
	emitFooterNotice: (level: "info" | "success" | "warning" | "error", text: string, key: string) => void;
}

export interface TurnMiddleware {
	fireTurnStart(
		agentRuntime: AgentRuntime,
		promptText: string,
		pendingSkillRequestCount?: number,
		requestContinuation?: boolean,
	): void;
	fireTurnEnd(
		agentRuntime: AgentRuntime,
		messages: ReadonlyArray<AgentMessage>,
		terminalToolResult?: { toolCallId: string; toolName: string },
	): Promise<void>;
	fireCompactionHook(
		stage: "mask_observations" | "llm_summary",
		trigger: CompactionTrigger,
		tokensBefore?: number,
	): void;
	flushPendingReminders(): string;
	clearPendingReminders(): void;
	/**
	 * Deliver a reminder produced after its own turn boundary already closed.
	 * Background observers that outlive a turn use this instead of a hook return
	 * value; the reminder joins the same buffer, ledger, and transcript path a
	 * turn_end reminder takes.
	 */
	injectDeferredReminder(message: string, severity?: MiddlewareReminderSeverity): void;
}

export function createTurnMiddleware(deps: TurnMiddlewareDeps): TurnMiddleware {
	const { state, middlewareToolChoice } = deps;

	// Reminders accumulated from middleware `inject_reminder` effects
	// (turn_end advisories, hard-block recovery guidance, turn_start
	// injections). The next accepted prompt flushes them into the model
	// request as one system-reminder block; the buffer clears on session
	// switch.
	const pendingReminders: Array<{ message: string; severity: MiddlewareReminderSeverity }> = [];

	const bufferReminder = (message: string, severity: MiddlewareReminderSeverity): void => {
		if (pendingReminders.some((entry) => entry.message === message && entry.severity === severity)) return;
		pendingReminders.push({ message, severity });
	};

	const runMiddlewareTurnHook = (input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> => {
		if (!deps.middleware) return [];
		try {
			return deps.middleware.runHook(input).effects;
		} catch {
			// Per-registration throws are already isolated inside the runtime;
			// anything escaping runHook is a runtime bug and must not break the
			// turn.
			return [];
		}
	};

	const runMiddlewareTurnHookAsync = async (
		input: MiddlewareHookInput,
		priorEffects: ReadonlyArray<MiddlewareEffect>,
	): Promise<ReadonlyArray<MiddlewareEffect>> => {
		if (!deps.middleware?.runAsyncHook) return [];
		try {
			return (await deps.middleware.runAsyncHook(input, priorEffects)).effects;
		} catch {
			return [];
		}
	};

	const appendMiddlewareReminderEntry = (message: string, severity: MiddlewareReminderSeverity): void => {
		if (!deps.session?.current()) return;
		try {
			deps.session.appendEntry({
				kind: "custom",
				parentTurnId: state.lastTurnId,
				customType: "middlewareReminder",
				display: true,
				data: { message, severity },
			});
		} catch {
			// Reminder persistence is best-effort; the live notice still
			// reaches the operator through the existing chat event path.
		}
	};

	const applyTurnEndReminder = (
		agentRuntime: AgentRuntime,
		message: string,
		severity: MiddlewareReminderSeverity,
	): void => {
		bufferReminder(message, severity);
		if (severity === "hard-block") {
			// Interrupt the turn unless the streaming tool-prose cutoff already
			// aborted it mid-delta; the buffered reminder carries the recovery
			// guidance into the next request either way.
			if (state.toolProseAbortReason === null) {
				state.toolProseAbortReason = message;
				agentRuntime.agent.abort();
				deps.emitNotice(message);
			}
			return;
		}
		appendMiddlewareReminderEntry(message, severity);
		deps.emitNotice(message);
	};

	const applyRequestContinuation = (message: string): void => {
		if (state.stalledTurnNudgeSpent) {
			// One continuation per user prompt, and that cap is all this branch
			// knows. It cannot tell whether the model stalled, answered, or was
			// carried here by a second producer entirely, so it reports the cap and
			// leaves any claim about a stall to the watchdog that measures one.
			deps.emitFooterNotice("warning", "turn still has open work; this turn's nudge is spent", "nudge.continuation.spent");
			return;
		}
		state.stalledTurnNudgeSpent = true;
		state.pendingRequestContinuation = true;
		bufferReminder(message, "info");
		// Producer-neutral wording: stalled-turn, the high-rigor finish contract,
		// and the open-tasks nudge all arrive here, and the buffered reminder
		// already carries each producer's specific message into the transcript.
		deps.emitFooterNotice("info", "turn ended with open work; nudge sent", "nudge.continuation.sent");
	};

	const lastAssistantMessage = (messages: ReadonlyArray<AgentMessage>): AgentMessage | null => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				return message;
			}
		}
		return null;
	};

	return {
		fireTurnStart(agentRuntime, promptText, pendingSkillRequestCount = 0, requestContinuation = false): void {
			const sessionId = deps.session?.current()?.id;
			const input: MiddlewareHookInput = {
				hook: "turn_start",
				...(sessionId ? { sessionId } : {}),
				modelId: agentRuntime.wireModelId,
				// The raw user text so the skills reminder can tell a substantive task
				// turn from a bare greeting; the runtime caps it on clone.
				text: promptText.slice(0, MIDDLEWARE_HOOK_TEXT_MAX_CHARS),
				metadata: {
					promptChars: promptText.length,
					queued: false,
					requestContinuation,
					activeToolNames: toolNamesFromAgentState(agentRuntime.agent.state.tools).join(","),
					// First-substantive-turn signal for once-per-session reminders:
					// a fresh session's opening turn has an empty conversation.
					conversationMessages: agentRuntime.agent.state.messages.length,
					pendingSkillRequests: pendingSkillRequestCount,
				},
			};
			const effects = runMiddlewareTurnHook(input);
			middlewareToolChoice.apply(effects);
			for (const effect of effects) {
				if (effect.kind === "inject_reminder") {
					bufferReminder(effect.message, effect.severity ?? "info");
				}
			}
		},

		async fireTurnEnd(agentRuntime, messages, terminalToolResult): Promise<void> {
			if (!deps.middleware) return;
			const message = terminalToolResult === undefined ? lastAssistantMessage(messages) : null;
			if (message === null && terminalToolResult === undefined) return;
			const text = message === null ? "" : extractText(message);
			if (terminalToolResult === undefined && text.trim().length === 0) return;
			const stopReason = message === null ? "stop" : (message as { stopReason?: unknown }).stopReason;
			const metadata: Record<string, MiddlewareMetadataValue> = {
				assistantTextChars: text.length,
				hasStructuredToolCall: terminalToolResult !== undefined || (message !== null && hasStructuredToolCall(message)),
				runtimeId: agentRuntime.runtimeId,
				runtimeTier: agentRuntime.runtimeResolution.runtimeTier ?? "",
				activeToolNames: toolNamesFromAgentState(agentRuntime.agent.state.tools).join(","),
				turnToolCalls: state.turnToolCalls,
				sharedWorkerNote: state.turnSharedWorkerNote,
			};
			if (terminalToolResult !== undefined) {
				metadata.terminalToolResult = true;
				metadata.terminalToolCallId = terminalToolResult.toolCallId;
				metadata.terminalToolName = terminalToolResult.toolName;
			}
			// turnId intentionally identifies the final assistant ledger entry (the
			// finish contract needs that evidence boundary). Registrations that span
			// tool hooks and turn_end correlate through the initiating user turn.
			if (state.activeUserTurnId) metadata.userTurnId = state.activeUserTurnId;
			if (typeof stopReason === "string") metadata.stopReason = stopReason;
			const sessionId = deps.session?.current()?.id;
			const input: MiddlewareHookInput = {
				hook: "turn_end",
				...(sessionId ? { sessionId } : {}),
				...(state.lastTurnId ? { turnId: state.lastTurnId } : {}),
				modelId: agentRuntime.wireModelId,
				text: text.slice(0, MIDDLEWARE_HOOK_TEXT_MAX_CHARS),
				metadata,
			};
			const syncEffects = runMiddlewareTurnHook(input);
			const effects = [...syncEffects, ...(await runMiddlewareTurnHookAsync(input, syncEffects))];
			for (const effect of effects) {
				if (effect.kind === "inject_reminder") {
					applyTurnEndReminder(agentRuntime, effect.message, effect.severity ?? "info");
					continue;
				}
				if (effect.kind === "request_continuation") {
					applyRequestContinuation(effect.message);
				}
			}
		},

		/**
		 * Observe-only lifecycle point fired before each compaction stage, at the
		 * existing CompactionBegin emit sites. Consumers record telemetry or state
		 * ahead of context loss; returned effects are discarded by design.
		 */
		fireCompactionHook(stage, trigger, tokensBefore): void {
			if (!deps.middleware) return;
			const sessionId = deps.session?.current()?.id;
			const metadata: Record<string, MiddlewareMetadataValue> = { stage, trigger };
			if (tokensBefore !== undefined) metadata.tokensBefore = tokensBefore;
			runMiddlewareTurnHook({
				hook: "on_compaction",
				...(sessionId ? { sessionId } : {}),
				...(state.activeUserTurnId ? { turnId: state.activeUserTurnId } : {}),
				metadata,
			});
		},

		flushPendingReminders(): string {
			if (pendingReminders.length === 0) return "";
			const messages = pendingReminders.map((entry) => entry.message);
			pendingReminders.length = 0;
			return `<system-reminder>\n${messages.join("\n\n")}\n</system-reminder>`;
		},

		clearPendingReminders(): void {
			pendingReminders.length = 0;
		},

		injectDeferredReminder(message, severity = "advisory"): void {
			const text = message.trim();
			if (text.length === 0) return;
			// A deferred reminder never carries hard-block authority: the turn it
			// could have interrupted is already over.
			const level: MiddlewareReminderSeverity = severity === "hard-block" ? "advisory" : severity;
			if (pendingReminders.some((entry) => entry.message === text)) return;
			bufferReminder(text, level);
			appendMiddlewareReminderEntry(text, level);
			deps.emitNotice(text);
		},
	};
}
