/**
 * The time a person has to answer a worker's permission ask, owned by the
 * process that dispatched the worker.
 *
 * The parent runs the visible window here and answers with the existing
 * `permission_decision` line, marked as a timeout so fallback deny and fallback
 * fail behave exactly as the worker's own timer does. The worker's timer stays
 * armed as a backstop past the parent's latest possible answer, which bounds an
 * ask whose parent is wedged rather than gone. A parent that is gone closes the
 * worker's stdin, and the worker aborts on that without waiting for any timer.
 *
 * A first hold runs to the ceiling, inside the backstop the worker started
 * with. A person still at the card can renew the hold past it only when the
 * worker honors the `permission_hold` frame, which moves its backstop; every
 * renewal stays within WORKER_PERMISSION_HOLD_LIMIT_MS of the ask opening.
 */

import { WORKER_APPROVAL_BACKSTOP_MARGIN_MS, WORKER_PERMISSION_HOLD_LIMIT_MS } from "../../worker/protocol.js";

/** The longest a first hold waits, counted from when the ask was opened; a renewal waits this long from the key that renewed it. */
export const WORKER_APPROVAL_HOLD_CEILING_MS = 15 * 60_000;

/** A renewal that would gain less than this changes nothing, so a person typing at a card sends at most one hold frame a minute. */
const WORKER_APPROVAL_RENEW_STEP_MS = 60_000;

/** The whole wait a hold can reach, counted from when the ask was opened. */
export function workerApprovalCeilingMs(windowMs: number): number {
	return Math.max(windowMs, WORKER_APPROVAL_HOLD_CEILING_MS);
}

/** The worker's own timer for an ask whose parent owns the window. */
export function workerApprovalBackstopMs(windowMs: number): number {
	return workerApprovalCeilingMs(windowMs) + WORKER_APPROVAL_BACKSTOP_MARGIN_MS;
}

/** Who an ask waits on now. A brokered ask reaches the person only if the judge or the main agent passes it on. */
export type WorkerApprovalDecider = "operator" | "main" | "judge";

export interface WorkerApprovalWindowView {
	held: boolean;
	decider: WorkerApprovalDecider;
	remainingMs: number;
	/** The whole wait a hold can reach, from when the ask was opened. */
	ceilingMs: number;
	/** Time left until that ceiling, however the window stands now. */
	ceilingRemainingMs: number;
	fallback: "deny" | "fail";
}

export interface WorkerApprovalWindowInput {
	runId: string | null;
	agentId: string;
	requestId: string;
	windowMs: number;
	fallback: "deny" | "fail";
	/** Absent reads as the operator. */
	decider?: WorkerApprovalDecider;
	/** Send the timeout denial; false when the worker's channel is gone. */
	deny(): boolean;
	/**
	 * Tell the worker the parent answers within `holdMs`, so its backstop moves
	 * past that. False when the worker does not honor the frame or its channel
	 * is gone; absent when the ask cannot be held past its ceiling.
	 */
	extend?(holdMs: number): boolean;
}

export interface WorkerApprovalWindowsDeps {
	/** Monotonic milliseconds, so a wall-clock jump cannot end a window. */
	now(): number;
	onChange?(ask: { runId: string; agentId: string; requestId: string }, view: WorkerApprovalWindowView): void;
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
}

export interface WorkerApprovalWindows {
	open(input: WorkerApprovalWindowInput): void;
	read(requestId: string): WorkerApprovalWindowView | null;
	/**
	 * The person is present: the ask waits until its ceiling. A later hold renews
	 * it to a ceiling away from now, within the hold limit, when the worker can
	 * extend its backstop; otherwise it changes nothing.
	 */
	hold(requestId: string): boolean;
	/** The person is present but looking at another card: a running window starts again, never past its ceiling. */
	restart(requestId: string): boolean;
	/** The ask reached the person's card: the whole window starts there, never past its ceiling. */
	handToOperator(requestId: string): boolean;
	/** The parent already sent the timeout denial, so an answer now reaches nothing. */
	isExpired(requestId: string): boolean;
	/** The current session changed: every open ask states its window again, so its surfaces learn whose it is now. */
	republish(): void;
	settle(requestId: string): void;
	settleRun(runId: string): void;
	dispose(): void;
}

interface OpenWindow extends WorkerApprovalWindowInput {
	openedAt: number;
	/** No renewal reaches past this. */
	limitAt: number;
	ceilingAt: number;
	ceilingMs: number;
	deadline: number;
	held: boolean;
	expired: boolean;
	timer: unknown;
}

export function createWorkerApprovalWindows(deps: WorkerApprovalWindowsDeps): WorkerApprovalWindows {
	const setTimer =
		deps.setTimer ??
		((callback: () => void, ms: number): unknown => {
			const handle = setTimeout(callback, ms);
			// The worker's backstop bounds the ask, so this never keeps a finished process alive.
			handle.unref?.();
			return handle;
		});
	const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const windows = new Map<string, OpenWindow>();

	const viewOf = (entry: OpenWindow): WorkerApprovalWindowView => {
		const at = deps.now();
		return {
			held: entry.held,
			decider: entry.decider ?? "operator",
			remainingMs: Math.max(0, entry.deadline - at),
			ceilingMs: entry.ceilingMs,
			ceilingRemainingMs: Math.max(0, entry.ceilingAt - at),
			fallback: entry.fallback,
		};
	};
	const disarm = (entry: OpenWindow): void => {
		if (entry.timer !== null) clearTimer(entry.timer);
		entry.timer = null;
	};
	const expire = (entry: OpenWindow): void => {
		entry.timer = null;
		entry.expired = true;
		// The entry stays until the worker's resolution arrives, so an answer racing it is known to be late.
		if (!entry.deny()) windows.delete(entry.requestId);
	};
	const arm = (entry: OpenWindow): void => {
		disarm(entry);
		entry.timer = setTimer(() => expire(entry), Math.max(0, entry.deadline - deps.now()));
	};
	const changed = (entry: OpenWindow): void => {
		if (entry.runId === null) return;
		deps.onChange?.({ runId: entry.runId, agentId: entry.agentId, requestId: entry.requestId }, viewOf(entry));
	};
	const live = (requestId: string): OpenWindow | null => {
		const entry = windows.get(requestId);
		return entry === undefined || entry.expired ? null : entry;
	};

	return {
		open(input) {
			if (windows.has(input.requestId)) return;
			const at = deps.now();
			const ceilingMs = workerApprovalCeilingMs(input.windowMs);
			const entry: OpenWindow = {
				...input,
				openedAt: at,
				limitAt: at + Math.max(ceilingMs, WORKER_PERMISSION_HOLD_LIMIT_MS),
				ceilingAt: at + ceilingMs,
				ceilingMs,
				deadline: at + input.windowMs,
				held: false,
				expired: false,
				timer: null,
			};
			windows.set(input.requestId, entry);
			arm(entry);
			changed(entry);
		},
		read(requestId) {
			const entry = windows.get(requestId);
			return entry === undefined ? null : viewOf(entry);
		},
		hold(requestId) {
			const entry = live(requestId);
			if (entry === null) return false;
			if (!entry.held) {
				entry.held = true;
				entry.deadline = entry.ceilingAt;
				arm(entry);
				changed(entry);
				return true;
			}
			if (entry.extend === undefined) return false;
			const at = deps.now();
			const renewed = Math.min(at + WORKER_APPROVAL_HOLD_CEILING_MS, entry.limitAt);
			// The last renewal may gain less than a step, so a held ask reaches its limit exactly.
			if (renewed <= entry.deadline) return false;
			if (renewed - entry.deadline < WORKER_APPROVAL_RENEW_STEP_MS && renewed < entry.limitAt) return false;
			// The worker learns first: a deadline it was never told of would meet its backstop.
			if (!entry.extend(renewed - at)) return false;
			entry.deadline = renewed;
			entry.ceilingAt = renewed;
			entry.ceilingMs = renewed - entry.openedAt;
			arm(entry);
			changed(entry);
			return true;
		},
		restart(requestId) {
			const entry = live(requestId);
			if (entry === null || entry.held) return false;
			entry.deadline = Math.min(deps.now() + entry.windowMs, entry.ceilingAt);
			arm(entry);
			changed(entry);
			return true;
		},
		handToOperator(requestId) {
			const entry = live(requestId);
			if (entry === null) return false;
			entry.decider = "operator";
			if (!entry.held) {
				entry.deadline = Math.min(deps.now() + entry.windowMs, entry.ceilingAt);
				arm(entry);
			}
			changed(entry);
			return true;
		},
		isExpired(requestId) {
			return windows.get(requestId)?.expired === true;
		},
		republish() {
			for (const entry of windows.values()) if (!entry.expired) changed(entry);
		},
		settle(requestId) {
			const entry = windows.get(requestId);
			if (entry === undefined) return;
			disarm(entry);
			windows.delete(requestId);
		},
		settleRun(runId) {
			for (const entry of [...windows.values()]) {
				if (entry.runId !== runId) continue;
				disarm(entry);
				windows.delete(entry.requestId);
			}
		},
		dispose() {
			for (const entry of windows.values()) disarm(entry);
			windows.clear();
		},
	};
}
