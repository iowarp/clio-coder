import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { PermissionRequestedPayload } from "../core/telemetry/live-events.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import { sanitizeCallTargetText, WORKER_CALL_TARGET_MAX_CHARS } from "../domains/safety/call-target.js";
import { COMMAND_CONSEQUENCE_MAX_SEVERE, fitConsequenceLine } from "../domains/safety/command-consequence.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { decisionActionClass } from "../domains/safety/decision-presentation.js";
import { UNATTENDED_DECIDED_BY, unattendedPermissionReason } from "../domains/safety/unattended.js";
import { axisViewFromId, mainApprovalRequestView } from "../session-control/approval-request-facts.js";
import type { ToolApprovalStateEvent } from "../session-control/chat-loop.js";
import { resolvePermission } from "../session-control/index.js";
import type { NoticeSource } from "../session-control/notice-source.js";
import type { PermissionRequiredMeta, ToolRegistry } from "../tools/registry.js";
import { approvalParkedNotice } from "./bus-notices.js";
import type { NoticeLevel } from "./command-output.js";
import { createMutationInspector, type MutationInspector } from "./mutation-preview.js";
import type { OverlayState } from "./overlay-key-routing.js";
import type {
	ApprovalRequestView,
	PermissionAdvisoryReader,
	PermissionCountdownReader,
	WorkerWindowReader,
} from "./permission-overlay.js";
import { formatCompactMs } from "./theme/index.js";
import { startUnattendedCountdown, type UnattendedCountdown, type UnattendedTimers } from "./unattended-countdown.js";

/**
 * What the card advisory is told about a parked call: the sanitized target the
 * operator is looking at, never the raw arguments. `requestId` joins the
 * advisory to the operator's answer.
 */
export interface ToolRiskSubject {
	readonly tool: string;
	readonly actionClass: string;
	readonly target: string;
	readonly requestId?: string;
}

type PermissionToolRegistry = Pick<
	ToolRegistry,
	| "cancelParkedCall"
	| "cancelParkedCalls"
	| "hasParkedCalls"
	| "isParked"
	| "onPermissionRequired"
	| "onAdmissionReview"
	| "parkedCount"
	| "renotifyHead"
	| "resumeParkedCalls"
>;

/** What an unattended denial says about the call it refuses. */
interface UnattendedPark {
	tool: string;
	actionClass: string;
	seconds: number;
	sessionId?: string;
	turnId?: string;
}

interface WorkerEscalationEntry {
	runId: string;
	requestId: string;
	agentId: string;
	tool: string;
	actionClass: ActionClass;
	axis: ApprovalRequestView["axis"];
	reason: string;
	target?: string;
	consequence?: string[];
	fallback: "deny" | "fail";
	/** The worker's own window for this ask, when it named one. */
	timeoutMs?: number;
	/** Present on a worker ask routed through the main agent (Phase D). */
	grant?: ApprovalRequestView["workerGrant"];
}

export interface OverlayPermissionLifecycleDeps {
	toolRegistry?: PermissionToolRegistry;
	bus: Pick<TelemetryHub, "emit" | "subscribe">;
	dispatch: Pick<
		DispatchContract,
		| "resolveWorkerPermission"
		| "workerPermissionWindow"
		| "holdWorkerPermission"
		| "restartWorkerPermission"
		| "workerRunEndsWithTurn"
	>;
	getAutonomy(): string;
	/** The operator's request a main-agent card names on its `task` row, read from the session ledger. */
	getApprovalTask?(turnId: string | undefined): ApprovalRequestView["task"];
	getOverlayState(): OverlayState;
	/**
	 * Open the dialog for one parked call. `inspect` carries the complete
	 * mutation text and is the only channel that does; it is process-local by
	 * construction, so it is passed here rather than folded into the view.
	 */
	openPermissionOverlay(
		view: ApprovalRequestView,
		inspect?: MutationInspector,
		invocation?: () => unknown,
		advisory?: PermissionAdvisoryReader,
		countdown?: PermissionCountdownReader,
		workerWindow?: WorkerWindowReader,
	): boolean;
	closeOverlay(): void;
	appendNotice(level: NoticeLevel, text: string, source?: NoticeSource): void;
	applyApprovalState(event: ToolApprovalStateEvent): void;
	requestRender(): void;
	/** End the in-flight run, carrying the text the operator will see. */
	stopActiveTurn(reason: string): void;
	/**
	 * A permission request parked waiting for the operator. Fired once per
	 * request, on the same dedup the operator-facing surfaces use, so a
	 * re-presented dialog does not notify twice.
	 */
	onOperatorParked?(): void;
	/**
	 * How long a main-agent card waits for the operator before Clio denies the
	 * call and the turn continues (`safety.unattendedAfterSeconds`, #421). Read
	 * once per request when it parks; 0 or absent waits forever. Worker
	 * escalations keep their own `fleet.permissions.escalate.timeoutMs`.
	 */
	getUnattendedWindowMs?(): number;
	/** Monotonic timers for the countdowns; tests inject a manual clock. */
	unattendedTimers?: UnattendedTimers;
}

export interface OverlayPermissionLifecycle {
	confirm(): void;
	cancel(): void;
	/**
	 * Deny the parked call and end the turn that keeps asking. Escape answers one
	 * call and leaves the run going, which is the loop the operator could not get
	 * out of: six denials produced six re-requests with the command mutated each
	 * time, and quitting the app was the only exit.
	 */
	stopTurn(): void;
	/**
	 * The operator pressed a key while a card was on screen. The card's own
	 * countdown stops for good, and calls queued behind it start their window
	 * again, so a present operator never loses a queued ask to the timeout.
	 */
	notePresence(): void;
	/** Worker asks waiting behind the card on screen, so its count names them. */
	queuedWorkerAsks(): number;
	onPermissionOverlayClosed(): void;
	/**
	 * Re-present whatever is still parked once no overlay holds the screen. A
	 * request that arrived while `/context` or a picker was open could only be
	 * announced, and nothing re-attempted the dialog when that overlay closed:
	 * the transcript said awaiting approval, the footer said confirm, and the
	 * operator had no key to press (issue #186).
	 */
	retryPending(): void;
	dispose(): void;
}

/**
 * Mark a permission request as surfaced to the operator and report whether this
 * was the first time. Both surfaces (the dialog and the fallback notice) mark,
 * so a re-notified head that already had a dialog does not also produce a
 * notice.
 */
function markPermissionRequestSurfaced(seenRequestIds: Set<string>, requestId: string, maxSize = 2048): boolean {
	if (seenRequestIds.has(requestId)) return false;
	seenRequestIds.add(requestId);
	if (seenRequestIds.size > maxSize) {
		const oldest = seenRequestIds.values().next().value;
		if (oldest !== undefined) seenRequestIds.delete(oldest);
	}
	return true;
}

function isLiveWorkerEscalationRequest(payload: PermissionRequestedPayload): boolean {
	if (typeof payload.requestId !== "string" || payload.escalation !== true) return false;
	const origin = typeof payload.origin === "string" ? payload.origin : undefined;
	const legacyWorkerEvent = origin === undefined && typeof payload.requestedBy === "string";
	if (!(origin?.startsWith("worker:") || legacyWorkerEvent)) return false;
	const runId = typeof payload.requestedBy === "string" ? payload.requestedBy : origin?.slice("worker:".length);
	return typeof runId === "string" && runId.length > 0;
}

/**
 * The sentences a worker wrote from its own full arguments. They cross the
 * stdout seam as data, so each is sanitized again, and anything that is not a
 * short list of strings is dropped. The host never rebuilds them from the
 * bounded `target`, which is flattened to one line and cut.
 */
function workerConsequenceLines(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const lines: string[] = [];
	for (const entry of value.slice(0, COMMAND_CONSEQUENCE_MAX_SEVERE + 1)) {
		if (typeof entry !== "string") return [];
		const line = fitConsequenceLine(sanitizeCallTargetText(entry));
		if (line.length > 0) lines.push(line);
	}
	return lines;
}

/**
 * The inspector for a main-agent ask, or undefined when there is nothing local
 * to read. A worker escalation never gets one: its arguments stay in the
 * worker, and the card says so rather than implying an inspection it cannot do.
 */
function mainMutationInspector(call: ClassifierCall, view: ApprovalRequestView): MutationInspector | undefined {
	if (view.mutation === undefined) return undefined;
	return createMutationInspector(call.tool, call.args, view.mutation);
}

function workerEscalationEntry(payload: PermissionRequestedPayload, autonomy: string): WorkerEscalationEntry | null {
	if (!isLiveWorkerEscalationRequest(payload) || typeof payload.requestId !== "string") return null;
	const consequence = workerConsequenceLines(payload.consequence);
	const origin = typeof payload.origin === "string" ? payload.origin : undefined;
	const runId = typeof payload.requestedBy === "string" ? payload.requestedBy : origin?.slice("worker:".length);
	if (!runId) return null;
	return {
		runId,
		requestId: payload.requestId,
		agentId: typeof payload.agentId === "string" ? payload.agentId : "worker",
		tool: typeof payload.tool === "string" ? payload.tool : "unknown",
		actionClass: decisionActionClass(payload.actionClass),
		axis:
			axisViewFromId(typeof payload.axis === "string" ? payload.axis : undefined, autonomy) ??
			(typeof payload.ruleId === "string"
				? { kind: "net" as const, ruleId: payload.ruleId }
				: { kind: "autonomy" as const, level: autonomy }),
		reason:
			payload.rejection?.short ??
			(typeof payload.summary === "string" ? payload.summary : `${payload.tool ?? "worker"} requires approval`),
		...(typeof payload.target === "string" && payload.target.length > 0
			? { target: sanitizeCallTargetText(payload.target).slice(0, WORKER_CALL_TARGET_MAX_CHARS) }
			: {}),
		...(consequence.length > 0 ? { consequence } : {}),
		fallback: payload.fallback === "fail" ? "fail" : "deny",
		...(typeof payload.timeoutMs === "number" && payload.timeoutMs > 0 ? { timeoutMs: payload.timeoutMs } : {}),
		...(payload.approvalAuthority === "main" || payload.approvalAuthority === "operator"
			? {
					grant: {
						authority: payload.approvalAuthority,
						forwardedByMain: payload.forwardedByMain === true,
						...(payload.reviewer === "safety-judge" ? { fromJudge: true } : {}),
					},
				}
			: {}),
	};
}

function workerApprovalRequestView(
	entry: WorkerEscalationEntry,
	queueDepth: number,
	endsWithTurn: boolean,
): ApprovalRequestView {
	return {
		requestId: entry.requestId,
		tool: entry.tool,
		actionClass: entry.actionClass,
		axis: entry.axis,
		origin: { kind: "worker", agentId: entry.agentId, runId: entry.runId, ...(endsWithTurn ? { endsWithTurn } : {}) },
		reason: entry.reason,
		...(entry.target !== undefined && entry.target.length > 0 ? { target: entry.target } : {}),
		...(entry.consequence !== undefined ? { consequence: entry.consequence } : {}),
		...(entry.grant !== undefined ? { workerGrant: entry.grant } : {}),
		workerFallback: entry.fallback,
		...(queueDepth > 1 ? { queueDepth } : {}),
	};
}

/**
 * The advisory of a card the safety judge handed over: the judge's own reason,
 * present from the first frame. It passes the same sanitizer as a call target
 * before it is drawn. A reason may end with the answering build in parentheses
 * and the Requested-by row already names that build. Only that exact suffix is
 * dropped, so a reason in any other shape keeps every word it has.
 */
function gateAdvisory(reason: string, build: string | undefined): PermissionAdvisoryReader {
	const line = sanitizeCallTargetText(reason);
	const buildText = build === undefined ? "" : sanitizeCallTargetText(build);
	const suffix = buildText === "" ? "" : ` (${buildText})`;
	const shown = suffix !== "" && line.endsWith(suffix) ? line.slice(0, -suffix.length) : line;
	return () => shown;
}

export function createOverlayPermissionLifecycle(deps: OverlayPermissionLifecycleDeps): OverlayPermissionLifecycle {
	let pendingPermission: {
		call: ClassifierCall;
		decision: SafetyDecision;
		meta?: PermissionRequiredMeta;
		view: ApprovalRequestView;
	} | null = null;
	let pendingWorker: WorkerEscalationEntry | null = null;
	const workerQueue: WorkerEscalationEntry[] = [];
	const announcedRequestIds = new Set<string>();
	/** Worker escalations already surfaced, so one request parks the operator once. */
	const announcedWorkerRequestIds = new Set<string>();
	/** Expiry notices already printed, including a decision that lost the terminal-state race. */
	const expiredWorkerRequestIds = new Set<string>();
	let confirmed = false;
	let denied = false;
	let stopping = false;
	let withdrawingWorker = false;
	/** Set when the card on screen closed because its countdown ran out, not because anyone answered. */
	let timedOut: UnattendedPark | null = null;
	/**
	 * Display clocks of worker asks. Dispatch runs the window where it can, and this
	 * only redraws the card until the longest that window can last. Elsewhere the
	 * worker's process owns the window and this is the time shown.
	 */
	const workerCountdowns = new Map<string, UnattendedCountdown>();
	/** Asks whose window dispatch runs, so its answer is the only time to show for them. */
	const dispatchWindows = new Set<string>();
	/** The whole wait of an ask a key held, so its expiry says how long it was held. */
	const heldWorkerCeilings = new Map<string, number>();
	/** Unattended countdowns of parked main-agent calls, by approval request id. */
	const countdowns = new Map<string, UnattendedPark & { countdown: UnattendedCountdown }>();
	const onScreenRequestId = (): string | undefined => pendingPermission?.meta?.requestId;
	const dropCountdown = (requestId: string | undefined): void => {
		if (requestId === undefined) return;
		countdowns.get(requestId)?.countdown.cancel();
		countdowns.delete(requestId);
	};
	const dropAllCountdowns = (): void => {
		for (const entry of countdowns.values()) entry.countdown.cancel();
		countdowns.clear();
	};
	/**
	 * Deny one parked call nobody answered. It goes back to the model as an
	 * ordinary denial, so the turn continues; a timeout never approves and never
	 * stops the turn. A call already settled some other way (an abort, a
	 * shutdown) is left alone, so nothing is counted for it.
	 */
	const denyUnattended = (requestId: string, entry: UnattendedPark): void => {
		if (deps.toolRegistry?.isParked(requestId) !== true) return;
		resolvePermission(
			{ bus: deps.bus, registry: deps.toolRegistry },
			{
				action: "deny",
				reason: unattendedPermissionReason(entry.tool, entry.seconds),
				payload: {
					status: "denied",
					requestId,
					...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
					...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
					origin: "main",
					decidedBy: UNATTENDED_DECIDED_BY,
					tool: entry.tool,
					actionClass: entry.actionClass,
					reason: `no operator answer within ${entry.seconds} s`,
					requestedBy: "tool",
					at: Date.now(),
				},
			},
		);
		deps.appendNotice(
			"warn",
			`No answer within ${entry.seconds} s: Clio denied ${entry.tool}, which did not run, and the turn continued.`,
		);
	};
	const expireUnattended = (requestId: string): void => {
		const entry = countdowns.get(requestId);
		countdowns.delete(requestId);
		if (entry === undefined) return;
		if (onScreenRequestId() === requestId) {
			// The close answers through onPermissionOverlayClosed, the same path
			// an operator's key takes, so the next parked call is presented after.
			timedOut = entry;
			deps.closeOverlay();
			return;
		}
		denyUnattended(requestId, entry);
	};
	const armCountdown = (meta: PermissionRequiredMeta, tool: string, actionClass: string): void => {
		const { requestId } = meta;
		// Requests settled without this lifecycle (an abort, a cancelled turn)
		// leave their countdowns behind; the next park is the moment to drop them.
		for (const known of [...countdowns.keys()]) {
			if (deps.toolRegistry?.isParked(known) !== true) dropCountdown(known);
		}
		if (countdowns.has(requestId)) return;
		const windowMs = deps.getUnattendedWindowMs?.() ?? 0;
		if (!(windowMs > 0)) return;
		const countdown = startUnattendedCountdown({
			windowMs,
			...(deps.unattendedTimers !== undefined ? { timers: deps.unattendedTimers } : {}),
			onExpire: () => expireUnattended(requestId),
			onTick: () => {
				if (onScreenRequestId() === requestId) deps.requestRender();
			},
		});
		countdowns.set(requestId, {
			countdown,
			tool,
			actionClass,
			seconds: Math.round(windowMs / 1000),
			...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
			...(meta.turnId !== undefined ? { turnId: meta.turnId } : {}),
		});
	};
	const countdownReader =
		(requestId: string): PermissionCountdownReader =>
		() => {
			const countdown = countdowns.get(requestId)?.countdown;
			if (countdown === undefined) return null;
			return countdown.state() === "held" ? "held" : countdown.remainingMs();
		};

	/** Started when the ask arrives, because the worker's window runs from then, seen or not. */
	const armWorkerCountdown = (entry: WorkerEscalationEntry): void => {
		if (workerCountdowns.has(entry.requestId)) return;
		const window = deps.dispatch.workerPermissionWindow?.(entry.requestId) ?? null;
		if (window !== null) dispatchWindows.add(entry.requestId);
		const windowMs = window?.ceilingRemainingMs ?? entry.timeoutMs;
		if (windowMs === undefined) return;
		workerCountdowns.set(
			entry.requestId,
			startUnattendedCountdown({
				windowMs,
				...(deps.unattendedTimers !== undefined ? { timers: deps.unattendedTimers } : {}),
				// The worker applies its fallback itself and that resolution withdraws the card.
				onExpire: () => {},
				onTick: () => {
					if (pendingWorker?.requestId === entry.requestId) deps.requestRender();
				},
			}),
		);
	};
	const dropWorkerCountdown = (requestId: string): void => {
		workerCountdowns.get(requestId)?.cancel();
		workerCountdowns.delete(requestId);
		dispatchWindows.delete(requestId);
		heldWorkerCeilings.delete(requestId);
	};
	/** The clock of an ask only the worker times. An ask dispatch times reads its window instead. */
	const workerClockReader =
		(requestId: string): PermissionCountdownReader =>
		() =>
			dispatchWindows.has(requestId) ? null : (workerCountdowns.get(requestId)?.remainingMs() ?? null);
	const workerWindowReader =
		(requestId: string): WorkerWindowReader =>
		() => {
			const window = deps.dispatch.workerPermissionWindow?.(requestId) ?? null;
			return window === null ? null : { remainingMs: window.remainingMs, held: window.held };
		};
	const openWorker = (entry: WorkerEscalationEntry): boolean => {
		// The entry is still at the head of the queue here, so the queue's length counts it.
		const endsWithTurn = deps.dispatch.workerRunEndsWithTurn?.(entry.runId) === true;
		const view = workerApprovalRequestView(entry, workerQueue.length, endsWithTurn);
		const { requestId } = entry;
		if (
			!deps.openPermissionOverlay(
				view,
				undefined,
				undefined,
				undefined,
				workerClockReader(requestId),
				workerWindowReader(requestId),
			)
		) {
			return false;
		}
		pendingWorker = entry;
		pendingPermission = null;
		confirmed = false;
		denied = false;
		return true;
	};
	const maybeOpenWorker = (): void => {
		const next = workerQueue[0];
		if (next && openWorker(next)) workerQueue.shift();
	};
	const retryPending = (): void => {
		maybeOpenWorker();
		if (deps.getOverlayState() !== "permission-confirm" && deps.toolRegistry?.hasParkedCalls()) {
			deps.toolRegistry.renotifyHead();
		}
	};
	const announceWorkerExpiry = (
		entry: WorkerEscalationEntry,
		fallback: "deny" | "fail",
		cause: "timeout" | "terminal" | "late-answer" | "revoked",
	): void => {
		const heldFor = heldWorkerCeilings.get(entry.requestId);
		dropWorkerCountdown(entry.requestId);
		if (!markPermissionRequestSurfaced(expiredWorkerRequestIds, entry.requestId)) return;
		const call = `${entry.agentId}'s ${entry.tool} call`;
		const after = fallback === "fail" ? "and the worker run fails" : "and the worker carries on without it";
		const waited =
			heldFor !== undefined
				? `in the ${formatCompactMs(heldFor)} it was held`
				: `in ${entry.timeoutMs === undefined ? "its window" : formatCompactMs(entry.timeoutMs)}`;
		const what =
			cause === "timeout"
				? `${call} was denied: nobody answered ${waited}. It did not run, ${after}.`
				: cause === "terminal"
					? `${call} no longer needs an answer: its run ended, and the call did not run.`
					: cause === "revoked"
						? `${call} no longer needs an answer: the ask was withdrawn, and the call did not run.`
						: `Your answer to ${call} came too late. It did not run, ${after}.`;
		deps.appendNotice("warn", `${what} /view dispatch:${entry.runId}`);
	};
	const removeQueuedWorkers = (matches: (entry: WorkerEscalationEntry) => boolean): WorkerEscalationEntry[] => {
		const removed: WorkerEscalationEntry[] = [];
		for (let index = workerQueue.length - 1; index >= 0; index -= 1) {
			const entry = workerQueue[index];
			if (entry === undefined || !matches(entry)) continue;
			removed.unshift(entry);
			workerQueue.splice(index, 1);
		}
		return removed;
	};
	const withdrawWorkers = (
		matches: (entry: WorkerEscalationEntry) => boolean,
		cause: "timeout" | "terminal" | "revoked",
		fallback?: "deny" | "fail",
	): void => {
		const active = pendingWorker !== null && matches(pendingWorker) ? pendingWorker : null;
		const expired = [...(active === null ? [] : [active]), ...removeQueuedWorkers(matches)];
		if (expired.length === 0) return;
		if (active !== null) {
			pendingWorker = null;
			confirmed = false;
			withdrawingWorker = true;
			deps.closeOverlay();
		}
		for (const entry of expired) announceWorkerExpiry(entry, fallback ?? entry.fallback, cause);
		deps.requestRender();
	};

	// The judge holds a started call before admission: the transcript and the rail say so until it is admitted (B01).
	const unsubscribeAdmissionReview =
		deps.toolRegistry?.onAdmissionReview?.((event) =>
			deps.applyApprovalState({
				type: "tool_approval_state",
				toolCallId: event.toolCallId,
				state: event.state === "judging" ? "judging" : "resumed",
			}),
		) ?? (() => {});

	const unsubscribePermission =
		deps.toolRegistry?.onPermissionRequired((call, decision, meta) => {
			const autonomy = deps.getAutonomy();
			const view = mainApprovalRequestView(
				call,
				decision,
				meta,
				autonomy,
				deps.toolRegistry?.parkedCount(),
				deps.getApprovalTask?.(meta.turnId),
			);
			// The dialog states the tool, target, action class, asking axis, and
			// decision keys. Another modal is interrupted so this prompt can take
			// focus. The notice remains for a second queued approval or a frame that
			// could not mount, when it is the operator's only additional signal.
			const announceParked = (): void => {
				if (!markPermissionRequestSurfaced(announcedRequestIds, meta.requestId)) return;
				deps.onOperatorParked?.();
				const notice = approvalParkedNotice(call.tool, decision, autonomy);
				deps.appendNotice(notice.level, notice.text, notice.source);
			};
			if (meta.toolCallId !== undefined) {
				deps.applyApprovalState({
					type: "tool_approval_state",
					toolCallId: meta.toolCallId,
					state: "awaiting-approval",
					view,
				});
			}
			// The window runs from the park whether or not a card can show yet: an
			// operator who left a picker open is as absent as one who left the card.
			armCountdown(meta, call.tool, decision.classification.actionClass);
			const advisory = meta.gateReason !== undefined ? gateAdvisory(meta.gateReason, meta.gateBuild) : undefined;
			if (
				!deps.openPermissionOverlay(
					view,
					mainMutationInspector(call, view),
					() => call.args,
					advisory,
					countdownReader(meta.requestId),
				)
			) {
				announceParked();
				return;
			}
			if (markPermissionRequestSurfaced(announcedRequestIds, meta.requestId)) deps.onOperatorParked?.();
			if (meta.toolCallId !== undefined) {
				deps.applyApprovalState({
					type: "tool_approval_state",
					toolCallId: meta.toolCallId,
					state: "awaiting-approval",
					view,
					docked: true,
				});
			}
			pendingPermission = { call, decision, meta, view };
			pendingWorker = null;
			confirmed = false;
			denied = false;
		}) ?? (() => {});

	const unsubscribeWorker = deps.bus.subscribe("approval.requested", (payload) => {
		const entry = workerEscalationEntry(payload, deps.getAutonomy());
		if (!entry) return;
		if (!markPermissionRequestSurfaced(announcedWorkerRequestIds, entry.requestId)) return;
		deps.onOperatorParked?.();
		armWorkerCountdown(entry);
		workerQueue.push(entry);
		maybeOpenWorker();
	});
	const unsubscribeWorkerResolution = deps.bus.subscribe("approval.resolved", (payload) => {
		if (typeof payload.requestId !== "string") return;
		// A brokered request the owner revoked (turn cancel, session end) leaves
		// the card the same way an expired one does.
		if (payload.decidedBy !== "timeout" && payload.decidedBy !== "revoked" && payload.status !== "expired") return;
		const fallback = payload.fallback === "fail" ? "fail" : "deny";
		withdrawWorkers(
			(entry) => entry.requestId === payload.requestId,
			payload.decidedBy === "revoked" ? "revoked" : "timeout",
			fallback,
		);
	});
	const withdrawTerminalRun = (payload: { runId?: unknown }): void => {
		if (typeof payload.runId !== "string") return;
		withdrawWorkers((entry) => entry.runId === payload.runId, "terminal");
	};
	const unsubscribeWorkerCompleted = deps.bus.subscribe("run.completed", withdrawTerminalRun);
	const unsubscribeWorkerFailed = deps.bus.subscribe("run.failed", withdrawTerminalRun);

	const onPermissionOverlayClosed = (): void => {
		if (withdrawingWorker) {
			withdrawingWorker = false;
			confirmed = false;
			retryPending();
			return;
		}
		const permission = pendingPermission;
		const worker = pendingWorker;
		pendingPermission = null;
		pendingWorker = null;
		const wasConfirmed = confirmed;
		const wasDenied = denied;
		const wasTimedOut = timedOut;
		confirmed = false;
		denied = false;
		timedOut = null;
		// Closing a modal is not an operator decision. Re-present the parked
		// request when another lifecycle closes its screen without an answer.
		if (!wasConfirmed && !wasDenied && !stopping && wasTimedOut === null) {
			// The card left the dock unanswered, so the row carries its facts again until it returns.
			if (permission?.meta?.toolCallId !== undefined) {
				deps.applyApprovalState({
					type: "tool_approval_state",
					toolCallId: permission.meta.toolCallId,
					state: "awaiting-approval",
					view: permission.view,
				});
			}
			if (worker) workerQueue.unshift(worker);
			retryPending();
			return;
		}
		dropCountdown(permission?.meta?.requestId);
		if (wasTimedOut !== null && permission?.meta !== undefined) {
			denyUnattended(permission.meta.requestId, wasTimedOut);
		} else if (worker) {
			dropWorkerCountdown(worker.requestId);
			try {
				deps.dispatch.resolveWorkerPermission?.(worker.runId, worker.requestId, wasConfirmed ? "approve" : "deny");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (
					/run or assignment '.+' is not active|run '.+' is (?:aborting|terminating)|no longer accepts input/u.test(message)
				) {
					announceWorkerExpiry(worker, worker.fallback, "late-answer");
				} else {
					deps.appendNotice("warn", `Could not deliver permission decision to run ${worker.runId}: ${message}`);
				}
			}
		} else if (wasConfirmed && permission) {
			void resolvePermission(
				{ bus: deps.bus, ...(deps.toolRegistry ? { registry: deps.toolRegistry } : {}) },
				{
					action: "grant",
					payload: {
						status: "granted",
						...(permission.meta ? { requestId: permission.meta.requestId } : {}),
						...(permission.meta?.sessionId !== undefined ? { sessionId: permission.meta.sessionId } : {}),
						...(permission.meta?.turnId !== undefined ? { turnId: permission.meta.turnId } : {}),
						origin: "main",
						decidedBy: "operator",
						tool: permission.call.tool,
						actionClass: permission.decision.classification.actionClass,
						requestedBy: "tool",
						at: Date.now(),
					},
					grantRequestedBy: "tool:one_shot",
					beforeRelease: () => {
						if (permission.meta?.toolCallId !== undefined)
							deps.applyApprovalState({
								type: "tool_approval_state",
								toolCallId: permission.meta.toolCallId,
								state: "resumed",
							});
					},
				},
			);
		} else {
			// One sentence each. The blocked-call composer always closes with the
			// standing "do not retry, pivot or report" instruction, so restating it
			// here printed the same guidance twice in one payload.
			const cancellationReason = stopping
				? "User stopped the turn at this call's approval card. It did not run, and the turn is over."
				: "User denied this call at the permission prompt. It will not run; no approval is pending.";
			resolvePermission(
				{ bus: deps.bus, ...(deps.toolRegistry ? { registry: deps.toolRegistry } : {}) },
				{
					action: stopping ? "stop" : "deny",
					reason: cancellationReason,
					payload: {
						status: "denied",
						...(permission?.meta ? { requestId: permission.meta.requestId } : {}),
						...(permission?.meta?.sessionId !== undefined ? { sessionId: permission.meta.sessionId } : {}),
						...(permission?.meta?.turnId !== undefined ? { turnId: permission.meta.turnId } : {}),
						origin: "main",
						decidedBy: "operator",
						...(permission
							? { tool: permission.call.tool, actionClass: permission.decision.classification.actionClass }
							: {}),
						reason: "operator cancelled",
						requestedBy: "tool",
						at: Date.now(),
					},
				},
			);
		}
		if (stopping) {
			stopping = false;
			dropAllCountdowns();
			// Another worker's ask is not part of the turn this ended. Dropping it from the
			// queue left that worker waiting out its window on a card nobody could see.
			maybeOpenWorker();
			return;
		}
		retryPending();
	};

	return {
		confirm: () => {
			if (pendingPermission === null && pendingWorker === null) return;
			confirmed = true;
			deps.closeOverlay();
		},
		cancel: () => {
			if (pendingPermission === null && pendingWorker === null) return;
			denied = true;
			deps.closeOverlay();
		},
		stopTurn: () => {
			if (pendingPermission === null && pendingWorker === null) return;
			const tool =
				pendingPermission?.call.tool ??
				(pendingWorker === null ? undefined : `${pendingWorker.agentId}'s ${pendingWorker.tool} call`);
			stopping = true;
			confirmed = false;
			// closeOverlay drives onPermissionOverlayClosed, which denies under the
			// stop reason. The run is cancelled after that, so the denial reaches the
			// parked calls before the abort settles them.
			deps.closeOverlay();
			deps.stopActiveTurn(
				tool === undefined
					? "[Clio Coder] turn stopped at the approval card; the tool call did not run."
					: `[Clio Coder] turn stopped at the approval card; ${tool} did not run.`,
			);
		},
		notePresence: () => {
			if (pendingPermission === null && pendingWorker === null) return;
			const onScreen = onScreenRequestId();
			let changed = false;
			for (const [requestId, entry] of countdowns) {
				if (entry.countdown.state() !== "running") continue;
				if (requestId === onScreen) entry.countdown.hold();
				else entry.countdown.restart();
				changed = true;
			}
			if (pendingWorker !== null && deps.dispatch.holdWorkerPermission?.(pendingWorker.requestId) === true) {
				const ceiling = deps.dispatch.workerPermissionWindow?.(pendingWorker.requestId)?.ceilingMs;
				if (ceiling !== undefined) heldWorkerCeilings.set(pendingWorker.requestId, ceiling);
				changed = true;
			}
			for (const queued of workerQueue) {
				if (deps.dispatch.restartWorkerPermission?.(queued.requestId) === true) changed = true;
			}
			if (changed) deps.requestRender();
		},
		queuedWorkerAsks: () => workerQueue.length,
		onPermissionOverlayClosed,
		retryPending,
		dispose: () => {
			dropAllCountdowns();
			for (const countdown of workerCountdowns.values()) countdown.cancel();
			workerCountdowns.clear();
			dispatchWindows.clear();
			heldWorkerCeilings.clear();
			unsubscribePermission();
			unsubscribeAdmissionReview();
			unsubscribeWorker();
			unsubscribeWorkerResolution();
			unsubscribeWorkerCompleted();
			unsubscribeWorkerFailed();
		},
	};
}
