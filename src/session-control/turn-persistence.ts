/**
 * Session-ledger persistence for the chat loop: assistant, user, tool-call,
 * tool-result, retry-status, and model-change rows, plus the queued-user-echo
 * handshake with the queue mirror. Owns the ledger cursor semantics: every
 * append advances `state.lastTurnId`.
 */

import type { BackendCompletionTimings } from "../core/cache-telemetry.js";
import type { ClioSettings } from "../core/config.js";
import { messageUsageForAccounting } from "../core/message-accounting.js";
import type { PackageIdentity } from "../core/package-identity.js";
import type { FactSum } from "../core/telemetry/fact.js";
import { sumFacts } from "../core/telemetry/pricing.js";
import type { MiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import { noteAnthropicStreamQuota, noteCodexStreamQuota } from "../domains/quota/index.js";
import type { SessionContract, TurnInput } from "../domains/session/contract.js";
import type { BudgetBlockData, SessionEntry } from "../domains/session/entries.js";
import { BUDGET_BLOCK_ENTRY } from "../domains/session/entries.js";
import { appendSessionThinkingLevel } from "../domains/session/thinking-route.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";
import { sumFactSums } from "../domains/telemetry/folds.js";
import type { TurnTokens } from "../domains/turn-control/index.js";
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
import { type DisplayToolCall, displayToolCall, gatewayChainSteps, VIA_GATEWAY } from "../tools/gateway-display.js";
import {
	type AssistantCallTiming,
	assistantSessionPayload,
	explainInterruptedAssistant,
	extractUserText,
	hasPersistableAssistantContent,
	isEmptyAbortedAssistantMessage,
	isLengthStopAssistantMessage,
	recordValue,
	sumRunUsage,
	terminalFailureFromAssistantMessage,
	toolResultSummary,
} from "./chat-loop-messages.js";
import { retireActiveUserContextForNextOperator, retiredUserContextWasSent } from "./session-replay-messages.js";
import type { ExpectedColdReason } from "./turn-context.js";
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
	/** Stamp a disturbance on the first request of the next run, which is the first to send it (#434). */
	noteNextRunColdReason?: (reason: ExpectedColdReason) => void;
	/** Counts calls that never reached the provider; absent telemetry leaves every append as it was. */
	telemetry?: TelemetryContract | undefined;
}

export interface TurnPersistence {
	/**
	 * Provider-reported usage of every call since the user row `userTurnId`
	 * opened, or null once a later user row has opened another turn.
	 */
	turnUsage(userTurnId: string): TurnTokens | null;
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

	// --- turn usage -----------------------------------------------------------
	// One usage total per operator turn, opened by the user row that starts it.
	// Calls after the final row of a run, such as a middleware continuation,
	// still belong to that turn, so the total stays open until the next user row.
	let usageTurnId: string | null = null;
	let turnUsage: TurnTokens | null = null;
	// The terminal row names the capability a gateway op=call ran. Its result
	// may not name it (a refused capability), so the call's own reading is kept
	// until the call settles.
	const shownToolCalls = new Map<string, DisplayToolCall>();
	let terminalToolShown: { toolCallId: string; toolName: string; viaGateway: boolean } | null = null;

	const startTurnUsage = (userTurnId: string): void => {
		usageTurnId = userTurnId;
		turnUsage = null;
		shownToolCalls.clear();
		toolOwners.clear();
	};

	/** Fold one assistant message's calls into the turn total, each call one contribution (#434). */
	const accumulateTurnUsage = (message: AgentMessage): void => {
		if (usageTurnId === null) return;
		const { totals, hadUsage } = sumRunUsage([message]);
		if (!hadUsage) return;
		const add = (prior: FactSum | undefined, next: FactSum) => (prior ? sumFactSums([prior, next]) : next);
		turnUsage = {
			input: add(turnUsage?.input, totals.usage.input),
			output: add(turnUsage?.output, totals.usage.output),
			cacheRead: add(turnUsage?.cacheRead, totals.usage.cacheRead),
			total: add(turnUsage?.total, totals.totalTokens),
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
		if (isLengthStopAssistantMessage(message) && state.runtime) {
			const contextExhaustion = recordValue(payload.contextExhaustion);
			const contextWindow = state.runtime.runtimeResolution.capabilityDecisions.contextWindow;
			if (contextExhaustion && contextWindow > 0) contextExhaustion.contextWindow = contextWindow;
		}
		accumulateTurnUsage(message);
		if (!deps.session || !hasPersistableAssistantContent(payload, failure)) return;
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
		state.lastTurnId = turn.id;
		return turn.id;
	};

	return {
		turnUsage(userTurnId) {
			if (usageTurnId !== userTurnId) return null;
			const empty = sumFacts([]);
			return turnUsage ?? { input: empty, output: empty, cacheRead: empty, total: empty };
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
				if (retired.length < prior.length) {
					replaceEngineMessages(state.runtime.agent, retired);
					// The running loop keeps its own copy of the history, so the rewrite first reaches the next run (#434).
					if (retiredUserContextWasSent(prior, retired)) deps.noteNextRunColdReason?.("input_changed");
				}
			}
			state.synthesisToolLock = false;
			state.toolBudgetLock = false;
			deps.middlewareToolChoice.reset();
			startTurnUsage(userTurn.id);
		},

		appendToolCallTurn(event): void {
			if (!deps.session) return;
			const shown = displayToolCall(event.toolName, event.args);
			const owner = deps.getToolOwner?.(shown.toolName);
			if (owner) toolOwners.set(event.toolCallId, owner);
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
			shownToolCalls.set(event.toolCallId, shown);
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
			const result = event.result as { details?: unknown; terminate?: unknown } | undefined;
			const shown = shownToolCalls.get(event.toolCallId) ?? displayToolCall(event.toolName, undefined, result?.details);
			shownToolCalls.delete(event.toolCallId);
			const steps = gatewayChainSteps(event.toolName, event.result);
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
			startTurnUsage(userTurn.id);
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
