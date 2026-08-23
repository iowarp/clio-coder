import { BusChannels, type PermissionRequestedPayload } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { ToolNames } from "../core/tool-names.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import type { PermissionRequiredMeta, ToolRegistry } from "../tools/registry.js";
import { approvalParkedNotice, autonomyDeniedNotice, workerEscalationNotice } from "./bus-notices.js";
import type { ToolApprovalStateEvent } from "./chat-loop.js";
import type { NoticeLevel } from "./command-output.js";
import type { OverlayState } from "./overlay-key-routing.js";
import { type ApprovalRequestView, askAxis, describeCallTarget } from "./permission-overlay.js";

type PermissionToolRegistry = Pick<
	ToolRegistry,
	| "cancelParkedCall"
	| "cancelParkedCalls"
	| "hasParkedCalls"
	| "onAutonomyDenied"
	| "onPermissionRequired"
	| "parkedCount"
	| "renotifyHead"
	| "resumeParkedCalls"
>;

interface WorkerEscalationEntry {
	runId: string;
	requestId: string;
	agentId: string;
	tool: string;
	actionClass: string;
	axis: ApprovalRequestView["axis"];
	reason: string;
	target?: string;
}

export interface OverlayPermissionLifecycleDeps {
	toolRegistry?: PermissionToolRegistry;
	bus: Pick<SafeEventBus, "emit" | "on">;
	dispatch: Pick<DispatchContract, "resolveWorkerPermission">;
	getAutonomy(): string;
	getOverlayState(): OverlayState;
	openPermissionOverlay(view: ApprovalRequestView): boolean;
	closeOverlay(): void;
	appendNotice(level: NoticeLevel, text: string): void;
	applyApprovalState(event: ToolApprovalStateEvent): void;
	requestRender(): void;
	/** End the in-flight run, carrying the text the operator will see. */
	stopActiveTurn(reason: string): void;
}

export interface OverlayPermissionLifecycle {
	confirm(): void;
	/**
	 * Deny the parked call and end the turn that keeps asking. Escape answers one
	 * call and leaves the run going, which is the loop the operator could not get
	 * out of: six denials produced six re-requests with the command mutated each
	 * time, and quitting the app was the only exit.
	 */
	stopTurn(): void;
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

function axisViewFromId(axisId: string | undefined, fallbackLevel: string): ApprovalRequestView["axis"] | null {
	if (axisId?.startsWith("net:")) {
		const ruleId = axisId.slice("net:".length);
		return { kind: "net", ruleId: ruleId.length > 0 ? ruleId : "unknown" };
	}
	if (axisId?.startsWith("autonomy:")) {
		const level = axisId.slice("autonomy:".length);
		return { kind: "autonomy", level: level.length > 0 ? level : fallbackLevel };
	}
	return null;
}

function mainApprovalRequestView(
	call: ClassifierCall,
	decision: SafetyDecision,
	meta: PermissionRequiredMeta | undefined,
	autonomy: string,
	queueDepth: number | undefined,
): ApprovalRequestView {
	const axisFromMeta = axisViewFromId(meta?.axis, autonomy);
	const axisFromDecision = askAxis(decision);
	const axis =
		axisFromMeta ??
		(axisFromDecision.kind === "net"
			? { kind: "net" as const, ruleId: axisFromDecision.ruleId }
			: { kind: "autonomy" as const, level: autonomy });
	const target = describeCallTarget(call.args);
	return {
		requestId: meta?.requestId ?? "permission-pending",
		tool: call.tool,
		actionClass: decision.classification.actionClass,
		axis,
		origin: { kind: "main" },
		reason:
			decision.kind === "ask" ? decision.rejection.short : `${call.tool} requests ${decision.classification.actionClass}`,
		...(call.tool === ToolNames.Dispatch && decision.kind === "ask"
			? { artifact: { kind: "dispatch-plan" as const, text: decision.rejection.detail } }
			: {}),
		...(target.length > 0 ? { target } : {}),
		...(queueDepth !== undefined && queueDepth > 1 ? { queueDepth } : {}),
	};
}

function workerEscalationEntry(payload: PermissionRequestedPayload, autonomy: string): WorkerEscalationEntry | null {
	if (!isLiveWorkerEscalationRequest(payload) || typeof payload.requestId !== "string") return null;
	const origin = typeof payload.origin === "string" ? payload.origin : undefined;
	const runId = typeof payload.requestedBy === "string" ? payload.requestedBy : origin?.slice("worker:".length);
	if (!runId) return null;
	return {
		runId,
		requestId: payload.requestId,
		agentId: typeof payload.agentId === "string" ? payload.agentId : "worker",
		tool: typeof payload.tool === "string" ? payload.tool : "unknown",
		actionClass: typeof payload.actionClass === "string" ? payload.actionClass : "unknown",
		axis:
			axisViewFromId(typeof payload.axis === "string" ? payload.axis : undefined, autonomy) ??
			(typeof payload.ruleId === "string"
				? { kind: "net" as const, ruleId: payload.ruleId }
				: { kind: "autonomy" as const, level: autonomy }),
		reason:
			payload.rejection?.short ??
			(typeof payload.summary === "string" ? payload.summary : `${payload.tool ?? "worker"} requires approval`),
		...(typeof payload.target === "string" && payload.target.length > 0
			? { target: sanitizeCallTargetText(payload.target).slice(0, 200) }
			: {}),
	};
}

function workerApprovalRequestView(entry: WorkerEscalationEntry): ApprovalRequestView {
	return {
		requestId: entry.requestId,
		tool: entry.tool,
		actionClass: entry.actionClass,
		axis: entry.axis,
		origin: { kind: "worker", agentId: entry.agentId, runId: entry.runId },
		reason: entry.reason,
		...(entry.target !== undefined && entry.target.length > 0 ? { target: entry.target } : {}),
	};
}

export function createOverlayPermissionLifecycle(deps: OverlayPermissionLifecycleDeps): OverlayPermissionLifecycle {
	let pendingPermission: { call: ClassifierCall; decision: SafetyDecision; meta?: PermissionRequiredMeta } | null = null;
	let pendingWorker: Pick<WorkerEscalationEntry, "agentId" | "requestId" | "runId"> | null = null;
	const workerQueue: WorkerEscalationEntry[] = [];
	const announcedRequestIds = new Set<string>();
	let confirmed = false;
	let stopping = false;

	const openWorker = (entry: WorkerEscalationEntry): void => {
		if (deps.getOverlayState() !== "closed") return;
		if (!deps.openPermissionOverlay(workerApprovalRequestView(entry))) return;
		pendingWorker = { runId: entry.runId, requestId: entry.requestId, agentId: entry.agentId };
		pendingPermission = null;
		confirmed = false;
	};
	const maybeOpenWorker = (): void => {
		if (deps.getOverlayState() !== "closed") return;
		const next = workerQueue.shift();
		if (next) openWorker(next);
	};
	const retryPending = (): void => {
		maybeOpenWorker();
		if (deps.getOverlayState() === "closed" && deps.toolRegistry?.hasParkedCalls()) {
			deps.toolRegistry.renotifyHead();
		}
	};

	const unsubscribePermission =
		deps.toolRegistry?.onPermissionRequired((call, decision, meta) => {
			const autonomy = deps.getAutonomy();
			const view = mainApprovalRequestView(call, decision, meta, autonomy, deps.toolRegistry?.parkedCount());
			// The dialog states the tool, the target, the action class, the axis
			// that asked, and the keys that answer it. While it is on screen the
			// notice repeats all of that one line above the transcript, so it is
			// emitted only when no dialog could open (another overlay holds the
			// screen), which is the case where it is the operator's only signal.
			const announceParked = (): void => {
				if (!markPermissionRequestSurfaced(announcedRequestIds, meta.requestId)) return;
				const notice = approvalParkedNotice(call.tool, decision, autonomy);
				deps.appendNotice(notice.level, notice.text);
			};
			if (meta.toolCallId !== undefined) {
				deps.applyApprovalState({
					type: "tool_approval_state",
					toolCallId: meta.toolCallId,
					state: "awaiting-approval",
					view,
				});
			}
			if (deps.getOverlayState() !== "closed") {
				announceParked();
				return;
			}
			if (!deps.openPermissionOverlay(view)) {
				announceParked();
				return;
			}
			markPermissionRequestSurfaced(announcedRequestIds, meta.requestId);
			pendingPermission = { call, decision, meta };
			pendingWorker = null;
			confirmed = false;
		}) ?? (() => {});

	const unsubscribeWorker = deps.bus.on(BusChannels.PermissionRequested, (payload) => {
		const entry = workerEscalationEntry(payload, deps.getAutonomy());
		if (!entry) return;
		const notice = workerEscalationNotice(payload);
		if (notice !== null) deps.appendNotice(notice.level, notice.text);
		workerQueue.push(entry);
		maybeOpenWorker();
	});

	const unsubscribeAutonomy =
		deps.toolRegistry?.onAutonomyDenied((_call, decision, level) => {
			const notice = autonomyDeniedNotice(decision, level);
			deps.appendNotice(notice.level, notice.text);
			deps.requestRender();
		}) ?? (() => {});

	const onPermissionOverlayClosed = (): void => {
		const permission = pendingPermission;
		const worker = pendingWorker;
		pendingPermission = null;
		pendingWorker = null;
		const wasConfirmed = confirmed;
		confirmed = false;
		if (worker) {
			try {
				deps.dispatch.resolveWorkerPermission?.(worker.runId, worker.requestId, wasConfirmed ? "approve" : "deny");
			} catch (error) {
				deps.appendNotice(
					"warn",
					`Could not deliver permission decision to run ${worker.runId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else if (wasConfirmed && permission) {
			deps.bus.emit(BusChannels.PermissionResolved, {
				status: "granted",
				...(permission.meta ? { requestId: permission.meta.requestId } : {}),
				origin: "main",
				decidedBy: "operator",
				tool: permission.call.tool,
				actionClass: permission.decision.classification.actionClass,
				requestedBy: "tool",
				at: Date.now(),
			});
			if (permission.meta?.toolCallId !== undefined) {
				deps.applyApprovalState({
					type: "tool_approval_state",
					toolCallId: permission.meta.toolCallId,
					state: "resumed",
				});
			}
			void deps.toolRegistry?.resumeParkedCalls({
				actionClass: permission.decision.classification.actionClass,
				...(permission.meta ? { requestId: permission.meta.requestId } : {}),
				requestedBy: "tool:one_shot",
			});
		} else {
			// One sentence each. The blocked-call composer always closes with the
			// standing "do not retry, pivot or report" instruction, so restating it
			// here printed the same guidance twice in one payload.
			const cancellationReason = stopping
				? "User denied this tool call and stopped the turn from the permission confirmation prompt. The turn is over."
				: "User cancelled this tool call from the permission confirmation prompt. Wait for new instruction.";
			deps.bus.emit(BusChannels.PermissionResolved, {
				status: "denied",
				...(permission?.meta ? { requestId: permission.meta.requestId } : {}),
				origin: "main",
				decidedBy: "operator",
				...(permission ? { tool: permission.call.tool } : {}),
				...(permission ? { actionClass: permission.decision.classification.actionClass } : {}),
				reason: "operator cancelled",
				requestedBy: "tool",
				at: Date.now(),
			});
			// A stop answers every call the turn has parked, not just the one on
			// screen. Denying the head and re-notifying the next would put the
			// operator straight back in the loop they asked to leave.
			if (stopping) deps.toolRegistry?.cancelParkedCalls(cancellationReason);
			else if (permission?.meta) deps.toolRegistry?.cancelParkedCall(permission.meta.requestId, cancellationReason);
			else deps.toolRegistry?.cancelParkedCalls(cancellationReason);
		}
		if (stopping) {
			stopping = false;
			workerQueue.length = 0;
			return;
		}
		retryPending();
	};

	return {
		confirm: () => {
			confirmed = true;
			deps.closeOverlay();
		},
		stopTurn: () => {
			const tool = pendingPermission?.call.tool ?? pendingWorker?.agentId;
			stopping = true;
			confirmed = false;
			// closeOverlay drives onPermissionOverlayClosed, which denies under the
			// stop reason. The run is cancelled after that, so the denial reaches the
			// parked calls before the abort settles them.
			deps.closeOverlay();
			deps.stopActiveTurn(
				tool === undefined
					? "[Clio Coder] turn stopped: you denied the tool call and asked to stop being asked."
					: `[Clio Coder] turn stopped: you denied ${tool} and asked to stop being asked.`,
			);
		},
		onPermissionOverlayClosed,
		retryPending,
		dispose: () => {
			unsubscribePermission();
			unsubscribeWorker();
			unsubscribeAutonomy();
		},
	};
}
