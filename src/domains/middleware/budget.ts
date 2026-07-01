/**
 * Phase-aware soft budgets for middleware hook evaluation, plus the rolling
 * warmup/steady-state tracker that decides when an overrun is worth surfacing.
 *
 * The flat 10ms-per-call budget was wrong on two counts: it fired on one-time
 * JIT/module warmup (the first turn_end reading the session ledger), and it
 * treated every hook phase the same. `before_tool`/`after_tool` sit on the tool
 * hot path and must stay tight; `turn_start`/`turn_end`/`on_compaction` run once
 * per turn off the token stream and may do bounded I/O, so they are forgiving.
 *
 * The tracker is pure over its inputs: elapsed time is passed in (never read
 * from a clock here) and all state lives in the tracker instance, so tests drive
 * warmup and rolling-window behaviour deterministically by constructing a
 * tracker and calling `record` with fixed elapsed values.
 */

import { MIDDLEWARE_HOOKS, type MiddlewareHook } from "./types.js";

/**
 * Legacy flat budget. Retained as an exported constant for back-compat with
 * importers and as the ultimate fallback; the phase-aware map below supersedes
 * it for every live hook.
 */
export const MIDDLEWARE_HOOK_BUDGET_MS = 10;

/**
 * Forgiving, phase-aware defaults (ms). Tuned against the measured cost of the
 * once-per-turn assessors: the finish-contract's first turn_end warms the
 * session reader (~23ms observed), well under the 75ms turn_end budget, so it is
 * no longer flagged, while the hot-path hooks keep a tight 25ms.
 */
export const DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS: Readonly<Record<MiddlewareHook, number>> = {
	before_tool: 25,
	after_tool: 25,
	turn_start: 50,
	turn_end: 75,
	on_compaction: 150,
};

/** First N invocations per (registrationId, hook) never warn: one-time warmup. */
export const DEFAULT_HOOK_BUDGET_WARMUP_CALLS = 1;
/** Rolling window size M of post-warmup calls examined for steady-state slowness. */
export const DEFAULT_HOOK_BUDGET_WINDOW = 5;
/** Warn only when ≥N of the last M post-warmup calls exceeded budget. */
export const DEFAULT_HOOK_BUDGET_THRESHOLD = 3;

export type HookBudgetMap = Record<MiddlewareHook, number>;

/** Rolling-window statistics attached to a budget outcome for observability. */
export interface HookBudgetStats {
	/** Total post-warmup calls seen for the key. */
	sampleCount: number;
	/** Samples currently held in the rolling window (≤ window size). */
	window: number;
	/** How many of the windowed samples exceeded budget. */
	overCount: number;
	p50Ms: number;
	p95Ms: number;
}

export interface HookBudgetOutcome {
	budgetMs: number;
	/** This call's elapsed exceeded the phase budget. */
	exceeded: boolean;
	/** This call fell within the warmup grace and is never a warning. */
	warmup: boolean;
	/**
	 * Steady-state signal: post-warmup, this call is over budget, AND at least
	 * `threshold` of the last `window` post-warmup calls were over budget. A lone
	 * spike never sets this; consistent slowness does.
	 */
	warn: boolean;
	stats: HookBudgetStats;
}

export interface HookBudgetTracker {
	budgetFor(hook: MiddlewareHook): number;
	record(registrationId: string, hook: MiddlewareHook, elapsedMs: number): HookBudgetOutcome;
}

export interface HookBudgetTrackerOptions {
	/** Per-phase budget overrides merged onto the defaults. */
	budgets?: Partial<HookBudgetMap>;
	/** Invocations per key that never warn (default 1). 0 disables the grace. */
	warmupCalls?: number;
	/** Rolling window size M (default 5). */
	windowSize?: number;
	/** Over-budget count N within the window that triggers a warning (default 3). */
	threshold?: number;
}

function parsePositiveMs(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : null;
}

function parsePositiveInt(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : null;
}

function parseNonNegativeInt(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const value = Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Uppercase env suffix for a hook, e.g. `turn_end` -> `TURN_END`. */
function hookEnvSuffix(hook: MiddlewareHook): string {
	return hook.toUpperCase();
}

/**
 * Resolve per-phase budgets from the environment. Precedence per phase:
 * `CLIO_HOOK_BUDGET_<PHASE>_MS` > `CLIO_HOOK_BUDGET_MS` (global) > built-in
 * default. Invalid or non-positive values are ignored so a typo never zeroes a
 * budget. Lets an operator on a slow disk loosen budgets without a rebuild.
 */
export function resolveHookBudgetsFromEnv(env: NodeJS.ProcessEnv = process.env): HookBudgetMap {
	const global = parsePositiveMs(env.CLIO_HOOK_BUDGET_MS);
	const map = {} as HookBudgetMap;
	for (const hook of MIDDLEWARE_HOOKS) {
		const perPhase = parsePositiveMs(env[`CLIO_HOOK_BUDGET_${hookEnvSuffix(hook)}_MS`]);
		map[hook] = perPhase ?? global ?? DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS[hook];
	}
	return map;
}

/** Resolve warmup/window/threshold tunables from the environment. */
export function resolveHookBudgetTunablesFromEnv(env: NodeJS.ProcessEnv = process.env): {
	warmupCalls: number;
	windowSize: number;
	threshold: number;
} {
	return {
		warmupCalls: parseNonNegativeInt(env.CLIO_HOOK_BUDGET_WARMUP_CALLS) ?? DEFAULT_HOOK_BUDGET_WARMUP_CALLS,
		windowSize: parsePositiveInt(env.CLIO_HOOK_BUDGET_WINDOW) ?? DEFAULT_HOOK_BUDGET_WINDOW,
		threshold: parsePositiveInt(env.CLIO_HOOK_BUDGET_THRESHOLD) ?? DEFAULT_HOOK_BUDGET_THRESHOLD,
	};
}

/** Nearest-rank percentile over a small sample; 0 for an empty window. */
function percentile(sortedAscending: ReadonlyArray<number>, p: number): number {
	if (sortedAscending.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sortedAscending.length);
	const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
	return sortedAscending[index] ?? 0;
}

interface KeyState {
	calls: number;
	postWarmupCalls: number;
	window: number[];
}

/**
 * Build a session-scoped tracker. One instance persists across the whole run so
 * warmup and the rolling window accumulate; a fresh instance (as tests and the
 * per-call fallback create) starts every key in warmup, so the first call never
 * warns.
 */
export function createHookBudgetTracker(options: HookBudgetTrackerOptions = {}): HookBudgetTracker {
	const budgets: HookBudgetMap = { ...DEFAULT_MIDDLEWARE_HOOK_BUDGETS_MS, ...(options.budgets ?? {}) };
	const warmupCalls = Math.max(0, options.warmupCalls ?? DEFAULT_HOOK_BUDGET_WARMUP_CALLS);
	const windowSize = Math.max(1, options.windowSize ?? DEFAULT_HOOK_BUDGET_WINDOW);
	const threshold = Math.max(1, options.threshold ?? DEFAULT_HOOK_BUDGET_THRESHOLD);
	const states = new Map<string, KeyState>();

	function statsFor(state: KeyState, budgetMs: number): HookBudgetStats {
		const sorted = [...state.window].sort((a, b) => a - b);
		const overCount = state.window.reduce((count, ms) => (ms > budgetMs ? count + 1 : count), 0);
		return {
			sampleCount: state.postWarmupCalls,
			window: state.window.length,
			overCount,
			p50Ms: percentile(sorted, 50),
			p95Ms: percentile(sorted, 95),
		};
	}

	return {
		budgetFor(hook: MiddlewareHook): number {
			return budgets[hook];
		},
		record(registrationId: string, hook: MiddlewareHook, elapsedMs: number): HookBudgetOutcome {
			const budgetMs = budgets[hook];
			const exceeded = elapsedMs > budgetMs;
			const key = `${registrationId}\u0000${hook}`;
			let state = states.get(key);
			if (state === undefined) {
				state = { calls: 0, postWarmupCalls: 0, window: [] };
				states.set(key, state);
			}
			state.calls += 1;
			if (state.calls <= warmupCalls) {
				return {
					budgetMs,
					exceeded,
					warmup: true,
					warn: false,
					stats: { sampleCount: 0, window: 0, overCount: 0, p50Ms: 0, p95Ms: 0 },
				};
			}
			state.postWarmupCalls += 1;
			state.window.push(elapsedMs);
			if (state.window.length > windowSize) state.window.shift();
			const stats = statsFor(state, budgetMs);
			return {
				budgetMs,
				exceeded,
				warmup: false,
				warn: exceeded && stats.overCount >= threshold,
				stats,
			};
		},
	};
}
