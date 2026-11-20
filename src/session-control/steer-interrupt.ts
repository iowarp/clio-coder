/**
 * A queued steer ends a running tool call instead of waiting for it (FX-32).
 *
 * A steer the operator queues lands at the next tool boundary, so a hung command held it for as long as the command
 * ran. Each interruptible call (a tool marked `steerInterruptible`) registers here while it runs; once a steer has
 * waited the grace period, counted from when it was queued or when the call started, whichever is later, the call's
 * own abort signal fires. Only that call ends: the run goes on, the call's result carries its partial output marked
 * aborted-by-steer, and the steer lands at the tool boundary that follows. With no steer queued nothing changes.
 */

import type { SteerInterruptHost } from "../tools/registry.js";

/** How long a queued steer lets a running call finish on its own before it ends it. */
export const STEER_INTERRUPT_GRACE_MS = 10_000;

export interface SteerInterrupter extends SteerInterruptHost {
	/** The queue changed: a steer may have arrived or left. */
	poke(): void;
	dispose(): void;
}

interface RunningCall {
	controller: AbortController;
	startedAt: number;
	toolName: string;
}

export function createSteerInterrupter(deps: {
	/** Epoch ms the oldest steer still waiting in the queue was queued, or null when none waits. */
	pendingSteerSince: () => number | null;
	/** A call was ended for a steer. */
	onInterrupt?: (toolName: string, graceMs: number) => void;
	graceMs?: number;
	now?: () => number;
}): SteerInterrupter {
	const graceMs = deps.graceMs ?? STEER_INTERRUPT_GRACE_MS;
	const now = deps.now ?? (() => Date.now());
	const running = new Set<RunningCall>();
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clear = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	const dueAt = (call: RunningCall, since: number): number => Math.max(since, call.startedAt) + graceMs;

	const check = (): void => {
		clear();
		if (running.size === 0) return;
		const since = deps.pendingSteerSince();
		if (since === null) return;
		const at = now();
		let next = Number.POSITIVE_INFINITY;
		for (const call of running) {
			const due = dueAt(call, since);
			if (due > at) {
				next = Math.min(next, due);
				continue;
			}
			running.delete(call);
			call.controller.abort();
			deps.onInterrupt?.(call.toolName, graceMs);
		}
		if (Number.isFinite(next)) {
			timer = setTimeout(check, Math.max(0, next - at));
			timer.unref?.();
		}
	};

	return {
		begin(toolName) {
			const call: RunningCall = { controller: new AbortController(), startedAt: now(), toolName };
			let fired = false;
			call.controller.signal.addEventListener("abort", () => {
				fired = true;
			});
			running.add(call);
			check();
			return {
				signal: call.controller.signal,
				fired: () => fired,
				end() {
					if (running.delete(call)) check();
				},
			};
		},
		poke: check,
		dispose() {
			clear();
			running.clear();
		},
	};
}
