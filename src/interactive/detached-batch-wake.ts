/**
 * Wakes the main agent when a detached dispatch batch settles, or stops for a
 * decision only the main agent can make, while the session is idle.
 *
 * A turn that is still running when its batch settles needs nothing from
 * here: the detached-dispatch nudge continues it at turn end, and the turn
 * controller collects the batch before the next model call. What had no path
 * was a batch that settled after the turn ended, or a worker that asked the
 * main agent for a permission decision after it. Either sat waiting until the
 * operator typed something, so a coordinator had to poll for it.
 *
 * The wake is an ordinary turn through `chat.submit`, the same door the peer
 * inbox uses, so it runs under the same permissions, budget and cost caps as
 * any other turn, and the turn controller collects a settled batch into it
 * before the model call. It starts only when nothing is running, nothing is
 * queued and the operator is not in the middle of something (a draft in the
 * composer, an open dialog). Until then it waits and looks again.
 *
 * Only a batch this session watched while it was still running can wake it,
 * and each settled batch and each decision wakes it at most once. A batch
 * that finished before it was ever seen open (a resumed session, a batch that
 * settled inside the turn that dispatched it) is left to the turn-end nudge
 * and the next turn's collection, as before.
 */

import type { DispatchContract } from "../domains/dispatch/contract.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { DetachedBatchNudgeView } from "../domains/middleware/index.js";
import type { ChatLoop } from "../session-control/chat-loop.js";
import { grantRequestLines, requestsAwaitingMain } from "../tools/grant-request-text.js";

/**
 * How often watched batches are looked at again. A run's terminal event can
 * reach the host before its assignment is durably settled, so the event alone
 * cannot say the batch is done; a later look does.
 */
const DETACHED_BATCH_WAKE_POLL_MS = 2_000;
export const DETACHED_BATCH_WAKE_ORIGIN = "detached batch update";

/** A request from a worker in an open batch that waits on the main agent. */
export interface DetachedBatchDecision {
	/** Stable id of the request, so one request wakes the session once. */
	id: string;
	batchId: string;
	/** What the request asks and how to answer it. */
	lines: ReadonlyArray<string>;
}

export interface DetachedBatchWakeDeps {
	/** Open (uncollected) detached batches this session owns; see openDetachedBatchViews. */
	openBatches(): ReadonlyArray<DetachedBatchNudgeView>;
	/** Requests from workers in this session's open batches that the main agent must answer. */
	pendingDecisions(): ReadonlyArray<DetachedBatchDecision>;
	chat: Pick<ChatLoop, "submit" | "isStreaming" | "turnPreparation" | "queuedMessages" | "getSessionId">;
	/** True while the operator has nothing in progress: an empty composer and no dialog open. */
	operatorIdle(): boolean;
	/** Paint the wake turn into the transcript once it is admitted, as the composer does for typed text. */
	showTurn(text: string, origin: string): void;
	pollMs?: number;
	setInterval?: (callback: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

export interface DetachedBatchWake {
	/** Look now: a run settled, a turn ended or the operator cleared the composer. */
	poke(): void;
	dispose(): void;
}

const finished = (view: DetachedBatchNudgeView): boolean => view.total > 0 && view.terminal >= view.total;

/** Pending main-authority permission requests from workers in the open detached batches this dispatch owner owns. */
export function detachedBatchDecisions(
	dispatch: Pick<DispatchContract, "detached" | "grants" | "owner">,
): DetachedBatchDecision[] {
	const detached = dispatch.detached;
	if (!detached || !dispatch.grants) return [];
	const ownership = dispatchOwnership(dispatchOwnerOf(dispatch));
	const decisions: DetachedBatchDecision[] = [];
	for (const record of detached.list()) {
		if (!ownership.ownsBatch(record)) continue;
		const runIds = record.runs.flatMap((run) => [run.runId, run.assignmentId]);
		for (const view of requestsAwaitingMain(dispatch, runIds))
			decisions.push({ id: `permission:${view.requestId}`, batchId: record.id, lines: grantRequestLines(view) });
		// Any other request a worker parks on the main agent joins here, keyed by its own id.
	}
	return decisions;
}

function buildDetachedBatchWakeMessage(
	ready: ReadonlyArray<DetachedBatchNudgeView>,
	running: ReadonlyArray<DetachedBatchNudgeView>,
	decisions: ReadonlyArray<DetachedBatchDecision> = [],
): string {
	const parts = ["[Clio Coder] Detached dispatch work changed while this session was idle."];
	if (ready.length > 0)
		parts.push(
			`${ready.length} batch(es) settled:\n` +
				ready.map((view) => `  - batch ${view.id}: ${view.terminal}/${view.total} run(s) finished`).join("\n") +
				`\nTheir results are collected into this turn. Any batch that is not, collect with monitor mode="collect" batch_id=<id>. Act on the results and continue the work they were dispatched for.`,
		);
	if (decisions.length > 0)
		parts.push(
			`${decisions.length} worker request(s) are waiting for your decision; the worker stays blocked until you answer:\n` +
				decisions.map((decision) => `batch ${decision.batchId}: ${decision.lines.join("\n")}`).join("\n"),
		);
	const others = running.length - new Set(decisions.map((decision) => decision.batchId)).size;
	if (others > 0) parts.push(`${others} other detached batch(es) are still running; leave those for later.`);
	return parts.join("\n");
}

export function createDetachedBatchWake(deps: DetachedBatchWakeDeps): DetachedBatchWake {
	const pollMs = deps.pollMs ?? DETACHED_BATCH_WAKE_POLL_MS;
	const startTimer = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms).unref());
	const stopTimer = deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
	// Batches seen open and not yet finished: the only ones whose settling may wake this session.
	const watching = new Set<string>();
	// Decisions already put to the agent, kept while they stay pending.
	const raised = new Set<string>();
	let timer: unknown = null;
	let waking = false;
	let disposed = false;

	const sessionIdle = (): boolean => {
		if (waking || deps.chat.isStreaming() || deps.chat.turnPreparation().phase !== "idle") return false;
		const queued = deps.chat.queuedMessages();
		return queued.steer.length + queued.followUp.length === 0;
	};

	const syncTimer = (): void => {
		if (!disposed && watching.size > 0) {
			if (timer === null) timer = startTimer(check, pollMs);
		} else if (timer !== null) {
			stopTimer(timer);
			timer = null;
		}
	};

	const wake = (text: string): void => {
		const origin = DETACHED_BATCH_WAKE_ORIGIN;
		const sessionId = deps.chat.getSessionId();
		waking = true;
		// A wake the session declines is not retried: a settled batch stays open
		// and the next turn, whoever starts it, collects it before its model call.
		void deps.chat
			.submit(text, {
				display: { text, note: origin },
				origin,
				isAdmissionCurrent: () => !disposed && deps.chat.getSessionId() === sessionId,
				onAdmitted: () => deps.showTurn(text, origin),
			})
			.catch(() => {})
			.finally(() => {
				waking = false;
				syncTimer();
			});
	};

	function check(): void {
		if (disposed) return;
		let views: ReadonlyArray<DetachedBatchNudgeView>;
		let decisions: ReadonlyArray<DetachedBatchDecision>;
		try {
			views = deps.openBatches();
			decisions = deps.pendingDecisions();
		} catch {
			return;
		}
		const open = new Set(views.map((view) => view.id));
		// A collected batch leaves the open list, whoever collected it; an answered request leaves the pending list.
		for (const id of [...watching]) if (!open.has(id)) watching.delete(id);
		const pending = new Set(decisions.map((decision) => decision.id));
		for (const id of [...raised]) if (!pending.has(id)) raised.delete(id);
		for (const view of views) if (!finished(view)) watching.add(view.id);
		const ready = views.filter((view) => finished(view) && watching.has(view.id));
		const fresh = decisions.filter((decision) => watching.has(decision.batchId) && !raised.has(decision.id));
		if ((ready.length > 0 || fresh.length > 0) && sessionIdle() && deps.operatorIdle()) {
			for (const view of ready) watching.delete(view.id);
			for (const decision of fresh) raised.add(decision.id);
			wake(
				buildDetachedBatchWakeMessage(
					ready,
					views.filter((view) => !finished(view)),
					fresh,
				),
			);
		}
		syncTimer();
	}

	return {
		poke: check,
		dispose(): void {
			disposed = true;
			watching.clear();
			raised.clear();
			syncTimer();
		},
	};
}
