/**
 * Simple sliding-window loop detector. Pure logic; the caller owns state
 * storage. Slice 3 hands this an identity key composed of tool name + canonical
 * arg hash and a `Date.now()` reading so runaway workers can be caught before
 * their audit trail floods disk.
 */

export interface LoopDetectorState {
	recent: ReadonlyArray<{ key: string; at: number }>;
	windowMs: number;
	maxRepeats: number;
}

export interface LoopVerdict {
	looping: boolean;
	key: string;
	count: number;
}

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_REPEATS = 5;

export function createLoopState(opts?: { windowMs?: number; maxRepeats?: number }): LoopDetectorState {
	const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
	const maxRepeats = opts?.maxRepeats ?? DEFAULT_MAX_REPEATS;
	return { recent: [], windowMs, maxRepeats };
}

export function observe(state: LoopDetectorState, key: string, now: number): [LoopDetectorState, LoopVerdict] {
	const cutoff = now - state.windowMs;
	const trimmed = state.recent.filter((entry) => entry.at >= cutoff);
	const next = [...trimmed, { key, at: now }];
	let count = 0;
	for (const entry of next) {
		if (entry.key === key) count += 1;
	}
	const looping = count >= state.maxRepeats;
	const newState: LoopDetectorState = {
		recent: next,
		windowMs: state.windowMs,
		maxRepeats: state.maxRepeats,
	};
	return [newState, { looping, key, count }];
}
