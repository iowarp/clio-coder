import {
	BusChannels,
	type ConfigReloadFailedPayload,
	type ContextPrunedPayload,
	type ContextWarningPayload,
	type LoopBlockedPayload,
	type RuntimeNoticePayload,
	type ToolBudgetExceededPayload,
} from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { routingChangeNotices } from "../core/session-routing.js";
import { visibleWidth } from "../engine/tui.js";
import {
	budgetAlertNotice,
	middlewareHookFailedSessionNotice,
	restartRequiredNotice,
	safetyBlockedNotice,
} from "./bus-notices.js";
import type { ChatCancelOptions, ChatLoopEvent, QueuedChatMessage } from "./chat-loop.js";
import { classifyNoticeLevel } from "./footer/notifications.js";
import {
	loopBlockedAuditReason,
	loopBlockedStopReason,
	toolBudgetAuditReason,
	toolBudgetStopReason,
} from "./loop-guard-interrupt.js";
import {
	type AgentStatus,
	INLINE_STATUS_INDENT_COLS,
	type ReasoningUsageView,
	reasoningFromTally,
	resolveInlineVerb,
	type StatusPhase,
	spinnerFrame,
	type TurnSummary,
	type VerbRender,
} from "./status/index.js";

export type InteractiveProjectionNoticeLevel = "info" | "success" | "warning" | "error";
export type InteractiveTranscriptNoticeLevel = "info" | "success" | "warn" | "error";

export interface InteractiveStatusLine {
	phase: StatusPhase;
	verb: string;
	toneHint: VerbRender["toneHint"];
}

export interface InteractiveEventProjectionDeps {
	bus: SafeEventBus;
	chat: {
		onEvent(handler: (event: ChatLoopEvent) => void): () => void;
		cancel(options?: ChatCancelOptions): void;
	};
	status: {
		subscribe(listener: (status: AgentStatus) => void): () => void;
	};
	initialNotices?: ReadonlyArray<string>;
	getSettings?: () => Readonly<ClioSettings>;
	getTerminalColumns: () => number;
	now?: () => number;
	/** Canonical synchronous ingress hook, before any projection branch consumes the event. */
	onChatEventIngress?: (event: ChatLoopEvent) => void;
	applyChatEvent: (event: ChatLoopEvent) => void;
	setFollowUpMessages: (messages: QueuedChatMessage[]) => void;
	isAskUserWaiting: () => boolean;
	closeAskUserSession: () => void;
	resetAskUserCancellation: () => void;
	recordToolStart: (toolName: string, toolCallId: string) => void;
	recordToolEnd: (toolName: string, toolCallId: string, isError: boolean, truncated: boolean) => void;
	setStatusLine: (line: InteractiveStatusLine | null) => void;
	/**
	 * Publish the live turn's reasoning projection to the transcript. Optional so
	 * a host without a chat panel still gets every other projection.
	 */
	setLiveReasoning?: (view: ReasoningUsageView | null) => void;
	setLastTurnSummary: (summary: TurnSummary) => void;
	startTerminalProgress: () => void;
	stopTerminalProgress: () => void;
	/**
	 * One model turn reached its end. Wired to the desktop notification; absent
	 * on hosts that do not own a terminal to notify through.
	 */
	onTurnEnded?: () => void;
	refreshLiveWorkspaceGit: (force: boolean) => void;
	refreshFooter: () => void;
	requestRender: () => void;
	notify: (level: InteractiveProjectionNoticeLevel, text: string, key?: string) => void;
	dismissNotification: (key: string) => void;
	appendTranscriptNotice: (level: InteractiveTranscriptNoticeLevel, text: string) => void;
	refreshSettingsOverlay: () => void;
	onConfigHotReload?: (settings: Readonly<ClioSettings>) => void;
}

export interface InteractiveEventProjection {
	/** Unsubscribe the primary chat and status projections before disposing the status controller. */
	disposePrimary(): void;
	/** Unsubscribe progress and bus projections after disposing the status controller. */
	disposeRemaining(): void;
	dispose(): void;
}

function recordObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function askUserInterviewClosedByToolResult(event: {
	toolName?: unknown;
	isError?: unknown;
	result?: unknown;
}): boolean {
	if (event.toolName !== "ask_user" || event.isError === true) return false;
	const result = recordObject(event.result);
	const details = recordObject(result?.details);
	const interview = recordObject(details?.interview);
	return interview?.status === "complete" || interview?.status === "cancelled";
}

/**
 * Project chat, status, and operator-facing bus events onto interactive UI
 * collaborators. Event delivery is synchronous, so handler statement order is
 * the rendering contract and intentionally matches the former composition-root
 * subscriptions.
 */
export function createInteractiveEventProjection(deps: InteractiveEventProjectionDeps): InteractiveEventProjection {
	const now = deps.now ?? Date.now;

	for (const notice of deps.initialNotices ?? []) {
		const text = notice.trim();
		if (text.length === 0) continue;
		const key = text.toLowerCase().includes("keybinding notice") ? "startup:keybinding-notice" : text;
		deps.notify(classifyNoticeLevel(text), text, key);
	}

	const primaryUnsubscribers: Array<() => void> = [];
	const remainingUnsubscribers: Array<() => void> = [];
	primaryUnsubscribers.push(
		deps.chat.onEvent((event) => {
			deps.onChatEventIngress?.(event);
			if (event.type === "notice") {
				if (event.surface === "transcript") {
					deps.applyChatEvent(event);
					return;
				}
				deps.notify(event.level, event.text, event.key);
				return;
			}
			if (event.type === "queue_update") {
				deps.setFollowUpMessages(event.messages);
				deps.requestRender();
				return;
			}
			if (deps.isAskUserWaiting() && event.type === "message_update") {
				const assistantEvent = event.assistantMessageEvent as { type?: unknown };
				if (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") {
					deps.closeAskUserSession();
				}
			}
			if (event.type === "agent_end") {
				deps.closeAskUserSession();
				deps.resetAskUserCancellation();
			}
			if (event.type === "tool_execution_start") {
				if (event.toolName.toLowerCase() === "dispatch") {
					deps.applyChatEvent(event);
					return;
				}
				deps.recordToolStart(event.toolName, event.toolCallId);
				deps.refreshFooter();
			} else if (event.type === "tool_execution_end") {
				if (event.toolName.toLowerCase() === "dispatch") {
					deps.applyChatEvent(event);
					return;
				}
				if (askUserInterviewClosedByToolResult(event)) {
					deps.closeAskUserSession();
					deps.resetAskUserCancellation();
				}
				const summary = (event as { resultSummary?: { truncated?: unknown } }).resultSummary;
				deps.recordToolEnd(event.toolName, event.toolCallId, event.isError, summary?.truncated === true);
				deps.refreshFooter();
			}
			deps.applyChatEvent(event);
		}),
	);

	let statusInlineFrame = 0;
	primaryUnsubscribers.push(
		deps.status.subscribe((status) => {
			// One projection of the run tally reaches the transcript, so the live
			// line, the turn receipt, and the footer state the same number.
			deps.setLiveReasoning?.(
				status.phase === "idle" || status.phase === "ended" ? null : reasoningFromTally(status.runTally),
			);
			if (status.phase === "idle") {
				deps.setStatusLine(null);
			} else if (status.phase === "ended") {
				deps.setStatusLine(null);
				if (status.summary) deps.setLastTurnSummary(status.summary);
			} else {
				const cols = deps.getTerminalColumns();
				const frame = cols < 30 ? "" : `${spinnerFrame(statusInlineFrame)} `;
				const verb = resolveInlineVerb(status, now(), cols, INLINE_STATUS_INDENT_COLS + visibleWidth(frame));
				if (verb) {
					deps.setStatusLine({ phase: status.phase, verb: `${frame}${verb.text}`, toneHint: verb.toneHint });
					statusInlineFrame = (statusInlineFrame + 1) % 10;
				} else {
					deps.setStatusLine(null);
				}
			}
			deps.refreshFooter();
			deps.requestRender();
		}),
	);

	remainingUnsubscribers.push(
		deps.chat.onEvent((event) => {
			const showProgress = deps.getSettings?.().terminal.showTerminalProgress ?? false;
			if (event.type === "agent_start" && showProgress) deps.startTerminalProgress();
			else if (event.type === "agent_end") {
				deps.stopTerminalProgress();
				deps.onTurnEnded?.();
			}
		}),
		deps.bus.on(BusChannels.RunAborted, () => {
			deps.stopTerminalProgress();
		}),
		deps.chat.onEvent((event) => {
			if (event.type !== "message_end" && event.type !== "agent_end") return;
			if (event.type === "agent_end") deps.refreshLiveWorkspaceGit(true);
			deps.refreshFooter();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.ContextWarning, (payload) => {
			const event = payload as ContextWarningPayload | null | undefined;
			if (event && typeof event === "object" && "warning" in event) {
				if (event.warning !== null) deps.notify("warning", event.warning, "context-low-warning");
				else deps.dismissNotification("context-low-warning");
			}
			deps.refreshFooter();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.ContextPruned, (payload) => {
			const event = payload as ContextPrunedPayload | null | undefined;
			if (
				event &&
				typeof event === "object" &&
				typeof event.tokensBefore === "number" &&
				typeof event.tokensAfter === "number"
			) {
				deps.notify(
					"info",
					`[Compaction] Reclaimed context: ${event.tokensBefore} -> ${event.tokensAfter} tokens (${event.stage})`,
					"compaction-notice",
				);
			}
			deps.refreshFooter();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.RuntimeNotice, (payload) => {
			const event = payload as RuntimeNoticePayload | null | undefined;
			if (!event || typeof event !== "object" || typeof event.message !== "string" || typeof event.kind !== "string") {
				return;
			}
			deps.notify(event.level, event.message, `runtime-notice:${event.kind}:${event.targetId}`);
			deps.refreshFooter();
			deps.requestRender();
		}),
	);

	remainingUnsubscribers.push(
		deps.bus.on(BusChannels.LoopBlocked, (payload) => {
			const event = payload as LoopBlockedPayload | null | undefined;
			if (!event || typeof event !== "object" || typeof event.tool !== "string" || typeof event.repeatCount !== "number") {
				return;
			}
			if (event.disposition === "stop") {
				deps.chat.cancel({
					reason: loopBlockedStopReason(event),
					source: "loop_guard",
					auditReason: loopBlockedAuditReason(event),
				});
			} else if (event.disposition === "lockout") {
				deps.appendTranscriptNotice(
					"warn",
					`[loop-guard] ${event.tool} looped ${event.repeatCount}x; tools disabled for the rest of this turn — the model is answering from what it gathered.`,
				);
			} else {
				deps.appendTranscriptNotice(
					"warn",
					`[loop-guard] blocked ${event.tool}: identical call repeated ${event.repeatCount}x in window (block ${event.blocksThisTurn}/${event.budget} this turn).`,
				);
			}
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.ToolBudgetExceeded, (payload) => {
			const event = payload as ToolBudgetExceededPayload | null | undefined;
			if (
				!event ||
				typeof event !== "object" ||
				typeof event.tool !== "string" ||
				typeof event.callsThisTurn !== "number"
			) {
				return;
			}
			if (event.interrupted) {
				deps.chat.cancel({
					reason: toolBudgetStopReason(event),
					source: "loop_guard",
					auditReason: toolBudgetAuditReason(event),
				});
			} else {
				deps.appendTranscriptNotice(
					"warn",
					`[loop-guard] tool-call budget reached: ${event.callsThisTurn} calls this turn (soft budget ${event.softBudget}); ${event.tool} blocked, model asked to re-plan.`,
				);
			}
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.ConfigNextTurn, (payload) => {
			const event = payload as { diff?: { nextTurn?: string[] }; settings?: Readonly<ClioSettings> } | null | undefined;
			const effective = deps.getSettings?.();
			if (!effective || !event?.settings || !Array.isArray(event.diff?.nextTurn)) return;
			for (const notice of routingChangeNotices(event.diff.nextTurn, event.settings, effective, { commandHints: true })) {
				deps.notify(
					notice.level,
					notice.text,
					notice.kind === "external-divergence" ? "config:routing-divergence" : "config:target-removed",
				);
			}
			deps.refreshSettingsOverlay();
			deps.refreshFooter();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.ConfigHotReload, (payload) => {
			deps.onConfigHotReload?.(payload.settings);
			deps.refreshSettingsOverlay();
		}),
		deps.bus.on(BusChannels.ConfigReloadFailed, (payload) => {
			const event = payload as ConfigReloadFailedPayload | null | undefined;
			if (!event || typeof event !== "object" || !("message" in event)) return;
			// The domain already folded this to one line with a remedy; the frame
			// only ever sees a notice, never an error object or a stack.
			if (typeof event.message === "string" && event.message.length > 0) {
				deps.notify("error", `[config] settings reload rejected: ${event.message}`, "config:reload-failed");
			} else if (event.message === null) {
				deps.dismissNotification("config:reload-failed");
			}
			deps.refreshFooter();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.ConfigRestartRequired, (payload) => {
			const text = restartRequiredNotice(payload);
			if (text === null) return;
			deps.notify("warning", text, "config:restart-required");
			deps.refreshFooter();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.BudgetAlert, (payload) => {
			const notice = budgetAlertNotice(payload);
			if (notice === null) return;
			deps.appendTranscriptNotice(notice.level, notice.text);
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.SafetyBlocked, (payload) => {
			const notice = safetyBlockedNotice(payload);
			if (notice === null) return;
			deps.appendTranscriptNotice(notice.level, notice.text);
			deps.requestRender();
		}),
	);

	const seenMiddlewareBudgetWarnings = new Set<string>();
	remainingUnsubscribers.push(
		deps.bus.on(BusChannels.MiddlewareHookFailed, (payload) => {
			const notice = middlewareHookFailedSessionNotice(payload, seenMiddlewareBudgetWarnings);
			if (notice === null) return;
			deps.appendTranscriptNotice(notice.level, notice.text);
			deps.requestRender();
		}),
	);

	let primaryDisposed = false;
	let remainingDisposed = false;
	const disposePrimary = (): void => {
		if (primaryDisposed) return;
		primaryDisposed = true;
		for (const unsubscribe of primaryUnsubscribers) unsubscribe();
	};
	const disposeRemaining = (): void => {
		if (remainingDisposed) return;
		remainingDisposed = true;
		for (const unsubscribe of remainingUnsubscribers) unsubscribe();
	};
	return {
		disposePrimary,
		disposeRemaining,
		dispose(): void {
			disposePrimary();
			disposeRemaining();
		},
	};
}
