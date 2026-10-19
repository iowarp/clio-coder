/**
 * The countdown behind an attended wait that may resolve itself (#421). One
 * countdown runs per waiting card or interview round: it ticks once a second so
 * the surface can redraw the time left, fires once at its deadline, and stops
 * for good when the operator shows they are present.
 *
 * Time is monotonic and injectable: a wall-clock jump must not expire a card,
 * and tests drive the deadline without waiting for it.
 */

export interface UnattendedTimers {
	/** Monotonic milliseconds. */
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const SYSTEM_UNATTENDED_TIMERS: UnattendedTimers = {
	now: () => performance.now(),
	setTimeout: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		// The countdown never keeps an otherwise finished process alive.
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How often a running countdown wakes to let its surface redraw the time left. */
const TICK_MS = 1000;

export type UnattendedCountdownState = "running" | "held" | "expired" | "cancelled";

export interface UnattendedCountdown {
	state(): UnattendedCountdownState;
	/** Milliseconds left while running, else null. */
	remainingMs(): number | null;
	/** The operator is present: stop for good without firing. */
	hold(): void;
	/** Start the whole window again from now; a stopped countdown stays stopped. */
	restart(): void;
	/** The wait ended some other way; stop without firing. */
	cancel(): void;
}

export interface UnattendedCountdownInput {
	windowMs: number;
	timers?: UnattendedTimers;
	onExpire(): void;
	/** Each wake before the deadline, for a redraw. */
	onTick?(): void;
}

export function startUnattendedCountdown(input: UnattendedCountdownInput): UnattendedCountdown {
	const timers = input.timers ?? SYSTEM_UNATTENDED_TIMERS;
	let state: UnattendedCountdownState = "running";
	let deadline = timers.now() + Math.max(0, input.windowMs);
	let handle: unknown = null;

	const clear = (): void => {
		if (handle !== null) timers.clearTimeout(handle);
		handle = null;
	};
	const schedule = (): void => {
		clear();
		const left = deadline - timers.now();
		handle = timers.setTimeout(wake, Math.max(0, Math.min(TICK_MS, left)));
	};
	function wake(): void {
		handle = null;
		if (state !== "running") return;
		if (timers.now() >= deadline) {
			state = "expired";
			input.onExpire();
			return;
		}
		input.onTick?.();
		schedule();
	}
	const stop = (next: UnattendedCountdownState): void => {
		if (state !== "running") return;
		state = next;
		clear();
	};
	schedule();
	return {
		state: () => state,
		remainingMs: () => (state === "running" ? Math.max(0, deadline - timers.now()) : null),
		hold: () => stop("held"),
		restart: () => {
			if (state !== "running") return;
			deadline = timers.now() + Math.max(0, input.windowMs);
			schedule();
		},
		cancel: () => stop("cancelled"),
	};
}

/** `4:59` from five minutes down, `45 s` under one. */
export function formatUnattendedRemaining(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
