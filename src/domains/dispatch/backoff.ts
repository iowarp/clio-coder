import type { RunOutcomeCode } from "./types.js";

/**
 * Exponential backoff state, pure. `nextDelay` returns the delay that should
 * be used BEFORE the next attempt, along with the updated state. The returned
 * `delayMs` is always clamped to `maxMs`.
 */

export interface BackoffState {
	attempts: number;
	nextDelayMs: number;
}

export interface BackoffOptions {
	baseMs?: number;
	maxMs?: number;
	factor?: number;
}

const DEFAULTS = { baseMs: 500, maxMs: 60_000, factor: 2 } as const;

function resolve(opts?: BackoffOptions): { baseMs: number; maxMs: number; factor: number } {
	return {
		baseMs: opts?.baseMs ?? DEFAULTS.baseMs,
		maxMs: opts?.maxMs ?? DEFAULTS.maxMs,
		factor: opts?.factor ?? DEFAULTS.factor,
	};
}

export function createBackoff(opts?: BackoffOptions): BackoffState {
	const { baseMs } = resolve(opts);
	return { attempts: 0, nextDelayMs: baseMs };
}

export function nextDelay(state: BackoffState, opts?: BackoffOptions): { state: BackoffState; delayMs: number } {
	const { maxMs, factor } = resolve(opts);
	const delayMs = Math.min(state.nextDelayMs, maxMs);
	const next: BackoffState = {
		attempts: state.attempts + 1,
		nextDelayMs: Math.min(state.nextDelayMs * factor, maxMs),
	};
	return { state: next, delayMs };
}

export function reset(opts?: BackoffOptions): BackoffState {
	const { baseMs } = resolve(opts);
	return { attempts: 0, nextDelayMs: baseMs };
}

/** True only for typed terminal conditions that retrying unchanged cannot heal. */
export function isDeterministicOutcomeCode(code: RunOutcomeCode | null | undefined): boolean {
	return (
		code === "vram_capacity_fit_failure" ||
		code === "worker_tool_call_cap_exhausted" ||
		code === "loop_guard_tools_disabled_exhausted" ||
		code === "scout_synthesis_contract_exhausted" ||
		code === "worker_final_output_missing"
	);
}
