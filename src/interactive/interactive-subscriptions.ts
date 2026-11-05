import type { ContextOperation } from "../core/context-operation.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type {
	DispatchFailedPayload,
	DispatchRunIdentity,
	DispatchStartedPayload,
} from "../core/telemetry/live-events.js";
import { plainOutcomeLabel, workerFailureHeadline } from "../domains/dispatch/failure-headline.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { readWorkerRunResultFacts } from "../session-control/worker-run-results.js";
import {
	createWorkerStream,
	isContextOperationRun,
	type WorkerEntryState,
	type WorkerRunResultReader,
	type WorkerStream,
	type WorkerStreamChange,
	workerAskedByModel,
} from "../session-control/worker-stream.js";
import { showsContextResult } from "./context-operation-view.js";
import type { NoticeSupersedeScope } from "./footer/notifications.js";
import {
	type WorkerRunEntryFields,
	type WorkerSettledFields,
	workerRunEntryFields,
	workerSettledFields,
} from "./worker-replay.js";

export type InteractiveNoticeLevel = "info" | "success" | "warning" | "error";

const WORKER_PAINT_INTERVAL_MS = 16;
/** A failover's next attempt starts within this, so a failure it overturns never reaches the footer. */
const FAILED_RUN_NOTICE_HOLD_MS = 400;

export interface InteractiveSubscriptionsDeps {
	bus: TelemetryHub;
	getSessionId?: () => string | null;
	contextResult?: (operation: ContextOperation) => void;
	refreshFooter: () => void;
	renderTaskIsland: () => void;
	renderContextIsland: () => void;
	requestRender: () => void;
	notify: (level: InteractiveNoticeLevel, text: string, key?: string, ttlMs?: number) => void;
	/**
	 * Place or refresh a worker's transcript block. Optional only so a host
	 * without a chat panel still gets the footer and island repaints. Without it
	 * no block is placed and nothing is shareable, because `/share` reads
	 * `chatPanel.workerStates()`. Tests rely on the contract staying optional.
	 */
	applyWorkerState?: (state: WorkerEntryState) => void;
	/**
	 * Record one attempt of a transcript-bound run in the session ledger, so a
	 * resumed session can redraw the block from the entry plus its receipt.
	 * Called where the block opens and once per failover; absent hosts simply
	 * do not persist, which costs replay and nothing else. The argument is a
	 * snapshot, not the live block, so a host that defers the write records the
	 * attempt it was handed.
	 */
	recordWorkerRun?: (fields: WorkerRunEntryFields) => void;
	/**
	 * Record what a settled run's stream knew and its receipt does not (the
	 * context its last call occupied), so a resumed card states the same spend.
	 */
	recordWorkerSettled?: (fields: WorkerSettledFields) => void;
	/** Drop one notice by its key once what it reported is over. */
	dismissNotice?: (key: string) => void;
	/** A new run started: notices about earlier work stop reading as current. */
	supersedeNotices?: (scope: NoticeSupersedeScope) => void;
	/** Run record reader, injected by tests. Defaults to the run's sealed scope. */
	readWorkerRunResult?: WorkerRunResultReader;
	/**
	 * A dispatch run reached a terminal state. The desktop notification uses it
	 * to look for a detached batch that settled with this run; nothing else
	 * derives state from it.
	 */
	onDispatchSettled?: () => void;
}

export interface InteractiveSubscriptions {
	/** Live worker blocks folded from the dispatch lifecycle, keyed by assignment. */
	workers: WorkerStream;
	dispose(): void;
}

/**
 * Own the non-modal dispatch and context repaint subscriptions. Bus delivery
 * is synchronous, so worker state stays current as events arrive. Lifecycle
 * handlers paint immediately; streaming changes invalidate each worker card
 * once per frame without repeating the projection's footer reads (#428).
 */
export function createInteractiveSubscriptions(deps: InteractiveSubscriptionsDeps): InteractiveSubscriptions {
	const workers = createWorkerStream({ readResult: deps.readWorkerRunResult ?? readWorkerRunResultFacts });
	/**
	 * One notice per assignment, not per run. A failed attempt's warning never
	 * expires and outranks a success, so keyed by run it stayed on the footer
	 * after its retry settled the assignment `succeeded`. Keyed by assignment,
	 * each attempt replaces the last and the footer ends on the terminal state.
	 */
	const assignmentOfRun = new Map<string, string>();
	const heldRunFailures = new Map<string, ReturnType<typeof setTimeout>>();
	const helperNotice = (
		payload: DispatchRunIdentity & { assignmentId?: string; attempt?: number; lineage?: { attempt: number } },
		status: "working" | "completed" | "failed",
	): void => {
		if (isContextOperationRun(payload)) return;
		const attempt = payload.lineage?.attempt ?? payload.attempt ?? 0;
		const helper =
			payload.agentAudience === "shadow" ||
			payload.agentAudience === "internal" ||
			payload.requestOrigin === "internal" ||
			payload.requestOrigin === "harness";
		if (payload.assignmentId !== undefined && status === "working") {
			// The next attempt overturns the failure the last one reported.
			clearRunFailure(payload.assignmentId);
		}
		// A later run makes an old failure history: the board and the dashboard keep
		// it, and the footer stops reading as though it were current (NO01). A failover
		// continues the same work, and background helpers say nothing about the operator's.
		if (status === "working" && attempt === 0) deps.supersedeNotices?.(helper ? "helper" : "work");
		// A failover attempt is stamped internal, but the run it continues may be the operator's own and reports there.
		if (attempt > 0 && payload.agentAudience !== "shadow" && payload.agentAudience !== "internal") return;
		if (payload.assignmentId !== undefined) assignmentOfRun.set(payload.runId, payload.assignmentId);
		const assignment = assignmentOfRun.get(payload.runId) ?? payload.runId;
		if (status !== "working") assignmentOfRun.delete(payload.runId);
		if (!helper) return;
		const name = sanitizeCallTargetText(payload.agentId)
			.slice(0, 80)
			.replace(/^./, (letter) => letter.toUpperCase());
		deps.notify(
			status === "failed" ? "warning" : status === "completed" ? "success" : "info",
			// A helper runs for Clio, not for the operator's turn, so its failure costs that turn nothing and the run itself is on the board.
			status === "failed"
				? `Clio's ${name} helper failed; your turn is not affected · /fleet shows why`
				: status === "completed"
					? `Clio's ${name} helper finished`
					: `Clio's ${name} helper is working`,
			`helper:${assignment}`,
		);
	};
	const clearRunFailure = (assignmentId: string): void => {
		const held = heldRunFailures.get(assignmentId);
		if (held !== undefined) clearTimeout(held);
		heldRunFailures.delete(assignmentId);
		deps.dismissNotice?.(`run-failed:${assignmentId}`);
	};
	/**
	 * A run the operator started can fail while the transcript is somewhere else,
	 * and nothing else speaks for it: the model reports the runs it asked for.
	 */
	const runFailureNotice = (payload: DispatchFailedPayload, entry: WorkerEntryState): void => {
		if (workerAskedByModel(entry) || entry.helper === true || payload.outcome === "canceled") return;
		const why = workerFailureHeadline(payload.outcomeDetail);
		const text = sanitizeCallTargetText(
			`${payload.agentId} ${plainOutcomeLabel(payload.outcome)}${why === null ? "" : `: ${why}`} · /view dispatch:${payload.runId}`,
		);
		const hold = setTimeout(() => {
			heldRunFailures.delete(entry.assignmentId);
			deps.notify("warning", text, `run-failed:${entry.assignmentId}`);
		}, FAILED_RUN_NOTICE_HOLD_MS);
		hold.unref?.();
		heldRunFailures.set(entry.assignmentId, hold);
	};
	/** A request about a run is over when the run is: `cancellation requested` must not outlive it (NO06). */
	const settleRunNotices = (runId: string): void => {
		deps.dismissNotice?.(`dispatch-board:cancel:${runId}`);
		deps.dismissNotice?.(`dispatch-board:steer:${runId}`);
		deps.dismissNotice?.(`steer:${runId}`);
	};
	const repaint = (): void => {
		deps.refreshFooter();
		deps.renderTaskIsland();
		deps.requestRender();
	};
	// Keep the stream current for /share, but invalidate each card at most once
	// per frame. The telemetry projection already refreshes the footer and
	// task data; repeating those reads per token also hashes the live budget (#428).
	const pendingWorkers = new Map<string, WorkerEntryState>();
	let workerPaintTimer: ReturnType<typeof setTimeout> | null = null;
	const paintWorkers = (): void => {
		workerPaintTimer = null;
		const pending = [...pendingWorkers.values()];
		pendingWorkers.clear();
		for (const entry of pending) {
			if (workers.get(entry.assignmentId) === entry) deps.applyWorkerState?.(entry);
		}
		if (pending.length > 0) deps.requestRender();
	};
	const queueWorkerPaint = (entry: WorkerEntryState): void => {
		pendingWorkers.set(entry.assignmentId, entry);
		if (workerPaintTimer !== null) return;
		workerPaintTimer = setTimeout(paintWorkers, WORKER_PAINT_INTERVAL_MS);
		workerPaintTimer.unref?.();
	};
	const recordSettled = (change: WorkerStreamChange): void => {
		const fields = workerSettledFields(change.entry);
		if (fields !== null) deps.recordWorkerSettled?.(fields);
	};
	/** Fold one lifecycle payload into its worker block, place the block, then repaint. */
	const folded =
		<P>(reduce: (payload: P) => WorkerStreamChange | null, after?: (change: WorkerStreamChange) => void) =>
		(payload: P): void => {
			const change = reduce(payload);
			if (change !== null) {
				pendingWorkers.delete(change.entry.assignmentId);
				deps.applyWorkerState?.(change.entry);
				after?.(change);
			}
			repaint();
		};
	const routeMoveNotice = (payload: DispatchStartedPayload): void => {
		const move = payload.routeMove;
		if (move === undefined || isContextOperationRun(payload)) return;
		// The target says where a run went; the model only tells a move inside one target apart.
		const sameTarget = move.fromTargetId === payload.targetId;
		const from = sameTarget ? `${move.fromTargetId}/${move.fromModelId}` : move.fromTargetId;
		const to = sameTarget ? `${payload.targetId}/${payload.wireModelId}` : payload.targetId;
		deps.notify(
			"warning",
			sanitizeCallTargetText(`${payload.agentId} moved from ${from} to ${to}: ${move.reason}`),
			`route-move:${payload.runId}`,
		);
	};
	// A settled operation can reach the bus more than once (replayed progress); its card renders once.
	const renderedContextResults = new Set<string>();
	const unsubscribers = [
		deps.bus.subscribe("run.enqueued", repaint),
		// Every attempt writes its own session entry: a failover is history, and
		// the attempt trail a resumed block shows is that history read back.
		deps.bus.subscribe("run.started", (payload) => {
			helperNotice(payload, "working");
			routeMoveNotice(payload);
			folded(workers.started, (change) => deps.recordWorkerRun?.(workerRunEntryFields(change.entry)))(payload);
		}),
		deps.bus.subscribe("run.progressed", (payload) => {
			const workerEvent = payload.event as { type?: unknown } | null | undefined;
			if (workerEvent?.type === "clio_coder_steer_received") {
				deps.notify("success", `steer received by ${payload.agentId} (${payload.runId})`, `steer:${payload.runId}`);
			}
			const change = workers.progress(payload);
			if (change !== null) queueWorkerPaint(change.entry);
		}),
		// An abort settles the block provisionally; the terminal event dispatch
		// publishes for every finalized run seals it, and that event writes the one
		// settled row. Recording here as well left two rows per aborted run.
		deps.bus.subscribe("run.aborted", (payload) => {
			settleRunNotices(payload.runId);
			folded(workers.aborted)(payload);
		}),
		deps.bus.subscribe("run.completed", (payload) => {
			settleRunNotices(payload.runId);
			helperNotice(payload, "completed");
			folded(workers.completed, recordSettled)(payload);
			deps.onDispatchSettled?.();
		}),
		deps.bus.subscribe("run.failed", (payload) => {
			settleRunNotices(payload.runId);
			helperNotice(payload, "failed");
			folded(workers.failed, (change) => {
				recordSettled(change);
				runFailureNotice(payload, change.entry);
			})(payload);
			deps.onDispatchSettled?.();
		}),
		deps.bus.subscribe("context.activity_changed", (event) => {
			const operation = event.operation;
			if (
				operation &&
				(operation.cwd !== process.cwd() || (deps.getSessionId && operation.sessionId !== deps.getSessionId()))
			)
				return;
			if (operation && showsContextResult(operation) && !renderedContextResults.has(operation.id)) {
				renderedContextResults.add(operation.id);
				// One id per settled operation is enough for the life of a session.
				if (renderedContextResults.size > 64)
					renderedContextResults.delete(renderedContextResults.values().next().value as string);
				deps.contextResult?.(operation);
			}
			deps.refreshFooter();
			deps.renderContextIsland();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
	];

	let disposed = false;
	return {
		workers,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
			if (workerPaintTimer !== null) clearTimeout(workerPaintTimer);
			for (const held of heldRunFailures.values()) clearTimeout(held);
			heldRunFailures.clear();
			pendingWorkers.clear();
		},
	};
}
