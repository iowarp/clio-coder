/**
 * Per-run circuit breaker. Pure; caller threads `now` so the module never
 * reaches for Date.now itself and the diag can drive time deterministically.
 *
 * State machine:
 *   closed    + failure  (failuresInWindow >= threshold)  → open (openedAt=now)
 *   closed    + failure  (under threshold)                → closed (counter++)
 *   open      + allowCall (now - openedAt >= cooldownMs)  → half-open (returned status)
 *   half-open + success                                   → closed (counter cleared)
 *   half-open + failure                                   → open (openedAt=now)
 *   *         + success                                   → closed (counter cleared)
 *
 * `windowMs` is kept on the options surface so callers can feed future
 * sliding-window variants; Slice 4 treats failuresInWindow as a cumulative
 * counter that only resets on a success event.
 */

export type CircuitStatus = "closed" | "open" | "half-open";

export interface CircuitState {
	status: CircuitStatus;
	failuresInWindow: number;
	openedAt: number | null;
}

export interface CircuitOptions {
	failureThreshold?: number;
	windowMs?: number;
	cooldownMs?: number;
}

const DEFAULTS = { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 } as const;

function resolve(opts?: CircuitOptions): { failureThreshold: number; windowMs: number; cooldownMs: number } {
	return {
		failureThreshold: opts?.failureThreshold ?? DEFAULTS.failureThreshold,
		windowMs: opts?.windowMs ?? DEFAULTS.windowMs,
		cooldownMs: opts?.cooldownMs ?? DEFAULTS.cooldownMs,
	};
}

export function initialCircuit(): CircuitState {
	return { status: "closed", failuresInWindow: 0, openedAt: null };
}

export function recordFailure(state: CircuitState, now: number, opts?: CircuitOptions): CircuitState {
	const { failureThreshold } = resolve(opts);

	if (state.status === "half-open") {
		return { status: "open", failuresInWindow: state.failuresInWindow + 1, openedAt: now };
	}

	const failuresInWindow = state.failuresInWindow + 1;
	if (failuresInWindow >= failureThreshold) {
		return { status: "open", failuresInWindow, openedAt: now };
	}
	return { status: "closed", failuresInWindow, openedAt: null };
}

export function recordSuccess(state: CircuitState): CircuitState {
	void state;
	return { status: "closed", failuresInWindow: 0, openedAt: null };
}

export function allowCall(
	state: CircuitState,
	now: number,
	opts?: CircuitOptions,
): { allow: boolean; status: CircuitStatus } {
	if (state.status === "closed") return { allow: true, status: "closed" };
	if (state.status === "half-open") return { allow: true, status: "half-open" };
	const { cooldownMs } = resolve(opts);
	if (state.openedAt !== null && now - state.openedAt >= cooldownMs) {
		return { allow: true, status: "half-open" };
	}
	return { allow: false, status: "open" };
}
