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
import { readDispatchScopeNotice } from "../core/dispatch-scope-notice.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { routingChangeNotices } from "../core/session-routing.js";
import { ToolNames } from "../core/tool-names.js";
import { chainStepToolCallId, displayToolCall, gatewayChainSteps } from "../tools/gateway-display.js";
import { effectiveToolCall, gatewayChainReceipts } from "../tools/surface.js";
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
import type { NoticeSource } from "./notice-source.js";
import type { AgentStatus, TurnSummary } from "./status/index.js";

export type InteractiveProjectionNoticeLevel = "info" | "success" | "warning" | "error";
export type InteractiveTranscriptNoticeLevel = "info" | "success" | "warn" | "error";

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
	/**
	 * Publish the live turn's reasoning projection to the transcript. Optional so
	 * a host without a chat panel still gets every other projection.
	 */
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
	dismissHelperNotifications?: () => void;
	appendTranscriptNotice: (level: InteractiveTranscriptNoticeLevel, text: string, source?: NoticeSource) => void;
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
	if (event.isError === true) return false;
	const toolName = typeof event.toolName === "string" ? event.toolName : "";
	const result = recordObject(event.result);
	// The coordinator runs ask_user through gateway op=call or as a chain step.
	const results =
		effectiveToolCall(toolName, undefined, result?.details).toolName === ToolNames.AskUser
			? [result]
			: gatewayChainReceipts(toolName, event.result)
					.filter((child) => child.capability === ToolNames.AskUser && child.admission.outcome === "ok")
					.map((child) => child.result);
	return results.some((candidate) => {
		const interview = recordObject(recordObject(candidate?.details)?.interview);
		return interview?.status === "complete" || interview?.status === "cancelled";
	});
}

/**
 * Project chat, status, and operator-facing bus events onto interactive UI
 * collaborators. Event delivery is synchronous, so handler statement order is
 * the rendering contract and intentionally matches the former composition-root
 * subscriptions.
 */
export function createInteractiveEventProjection(deps: InteractiveEventProjectionDeps): InteractiveEventProjection {
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
				// Context stages already occupy the rail above the editor. Legacy status
				// receipts belong in the footer; errors retain their transcript evidence.
				// The compaction receipt is the exception: it is the only record that the
				// context shrank, and the footer line is gone on the next notice (p9/D3).
				if (
					event.level === "info" &&
					event.text.startsWith("[context engine] ") &&
					!event.text.startsWith("[context engine] compacted ")
				) {
					deps.notify("info", event.text, "compaction-notice");
					return;
				}
				if (event.surface === "transcript") {
					deps.applyChatEvent(event);
					// The footer names the armed skill surface; a change repaints it.
					if (event.skillSurface !== undefined) deps.refreshFooter();
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
				// Footer tallies count the capability that ran, as a direct call of
				// it counted in v056, not the gateway wrapper the coordinator used.
				deps.recordToolStart(displayToolCall(event.toolName, event.args).toolName, event.toolCallId);
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
				const details = recordObject(recordObject(event.result)?.details);
				// A chain is one gateway call and one tally; each settled step also
				// counts as the capability it ran, with its own error and cut. A
				// chain fails only through a failed step, so its own error counts
				// only when no step settled (a plan that never parsed).
				const steps = gatewayChainSteps(event.toolName, event.result);
				deps.recordToolEnd(
					displayToolCall(event.toolName, undefined, details).toolName,
					event.toolCallId,
					event.isError && steps.length === 0,
					summary?.truncated === true,
				);
				for (const step of steps) {
					const stepId = chainStepToolCallId(event.toolCallId, step.id);
					const stepDetails = recordObject(step.result.details);
					deps.recordToolStart(step.capability, stepId);
					deps.recordToolEnd(
						step.capability,
						stepId,
						step.isError,
						recordObject(stepDetails?.resultSize)?.truncated === true ||
							recordObject(stepDetails?.observation)?.truncated === true,
					);
				}
				deps.refreshFooter();
			}
			deps.applyChatEvent(event);
		}),
	);

	primaryUnsubscribers.push(
		deps.status.subscribe((status) => {
			if (status.phase === "ended" && status.summary) deps.setLastTurnSummary(status.summary);
			deps.refreshFooter();
			deps.requestRender();
		}),
	);

	remainingUnsubscribers.push(
		deps.chat.onEvent((event) => {
			const showProgress = deps.getSettings?.().interface.terminalProgress ?? false;
			// A footer hint describes the turn that raised it. Warnings persist until
			// dismissed, so without this the last turn's interruption or unverified
			// notice outlived the successful turn that followed.
			if (event.type === "agent_start") {
				deps.dismissNotification("turn.interrupted");
				deps.dismissNotification("finish.unverified");
				deps.dismissNotification("finish.coverage-unverified");
				deps.dismissHelperNotifications?.();
			}
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
				const outcome = event.tokensAfter < event.tokensBefore ? "Reclaimed context" : "Context updated";
				deps.notify(
					"info",
					`[Compaction] ${outcome}: ${event.tokensBefore} -> ${event.tokensAfter} tokens (${event.stage})`,
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
		deps.bus.on(BusChannels.DispatchScopeNotice, (payload) => {
			const notice = readDispatchScopeNotice(payload);
			if (notice === null) return;
			// Both scope notices are two sentences: what was replaced, then what it does not affect.
			deps.appendTranscriptNotice("warn", notice.message, "fleet");
			deps.requestRender();
		}),
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
			deps.appendTranscriptNotice(notice.level, notice.text, notice.source);
			deps.requestRender();
		}),
		// The blocked call's row states the refusal and its body the rule that
		// fired, live and on /resume; the policy source and scope pass through
		// the footer's notice slot rather than a third, live-only transcript copy.
		deps.bus.on(BusChannels.SafetyBlocked, (payload) => {
			const notice = safetyBlockedNotice(payload);
			if (notice === null) return;
			deps.notify("warning", notice.text, "safety:blocked");
			deps.requestRender();
		}),
	);

	const seenMiddlewareBudgetWarnings = new Set<string>();
	remainingUnsubscribers.push(
		deps.bus.on(BusChannels.ExtensionsLoadIssue, (payload) => {
			if (typeof payload?.message !== "string" || payload.message.trim().length === 0) return;
			deps.notify("warning", payload.message, `extension:${payload.message}`);
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.MiddlewareHookFailed, (payload) => {
			const notice = middlewareHookFailedSessionNotice(payload, seenMiddlewareBudgetWarnings);
			if (notice === null) return;
			deps.notify(
				notice.level === "warn" ? "warning" : "error",
				notice.text,
				`middleware:${payload.registrationId}:${payload.hook}:${payload.kind}`,
			);
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
