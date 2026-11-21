import { renderUsdEstimate } from "../../core/telemetry/render.js";
import { budgetLimitWords, type RunToolBudgetEnvelope } from "./budget-envelope.js";
import { HANDBACK_CONTEXT_SHARE, HANDBACK_NOTE_SHARE, WALL_HANDBACK_SHARE } from "./handback.js";
import type { RunRole } from "./obligation.js";

/**
 * What stops one dispatched run, in the units that bind, sealed on its worker spec (DESIGN 4.5, fleet M8). The worker
 * enters its handback round at the first of `context.workShare` of the usable window, `time.handbackAt`, the tool
 * ceiling and the refusal limit; the host stops it at `time.deadlineAt` and seals it `timed_out`.
 */
export interface RunLimits {
	version: 1;
	/** Shares of the usable window: the handback round, and the one "write now or report" note to a builder. */
	context: { workShare: number; noteShare: number };
	/**
	 * `wallMs` runs from the dispatch call, so time queued for a slot counts; `deadlineAt` and `handbackAt` are epoch
	 * ms; `responseMs` bounds one model response.
	 */
	time: { wallMs: number; deadlineAt: number; handbackAt: number; responseMs: number };
	/** Tool calls the run may make: the budget's ceiling, never above `fleet.limits.toolCallsPerRun`. */
	tools: { ceiling: number };
	retries: { max: number };
	/** Execute refusals the run absorbs before it reports and ends. */
	refusals: number;
	/** Workers never dispatch. */
	depth: 1;
}

/**
 * One run's wall clock: the operator's cap (`fleet.limits.runTimeoutMs`, or `internalRunTimeoutMs` for an internal
 * generator), lowered by the recipe's `budget.timeoutMs` and by an earlier deadline the call already carries (its
 * `timeout_ms`, or a retry's root assignment deadline). Nothing raises it.
 */
export function resolveRunWall(input: { capMs: number; recipeMs?: number; startedAt: number; deadlineAt?: number }): {
	wallMs: number;
	deadlineAt: number;
} {
	const ownMs = Math.max(1, Math.min(input.capMs, input.recipeMs ?? Number.POSITIVE_INFINITY));
	const deadlineAt = Math.min(input.startedAt + ownMs, input.deadlineAt ?? Number.POSITIVE_INFINITY);
	return { wallMs: Math.max(1, Math.min(ownMs, deadlineAt - input.startedAt)), deadlineAt };
}

/** The operator's wall-clock cap for a run of this origin: internal generators keep their own, longer ceiling. */
export function runWallCapMs(
	limits: { runTimeoutMs: number; internalRunTimeoutMs: number },
	requestOrigin: string | undefined,
): number {
	return requestOrigin === "internal" ? limits.internalRunTimeoutMs : limits.runTimeoutMs;
}

export function resolveRunLimits(input: {
	role: RunRole;
	wallMs: number;
	deadlineAt: number;
	responseSeconds: number;
	toolCeiling: number;
	maxRetries: number;
	refusals: number;
}): RunLimits {
	return {
		version: 1,
		context: { workShare: HANDBACK_CONTEXT_SHARE[input.role], noteShare: HANDBACK_NOTE_SHARE },
		time: {
			wallMs: input.wallMs,
			deadlineAt: input.deadlineAt,
			handbackAt: input.deadlineAt - Math.round(input.wallMs * (1 - WALL_HANDBACK_SHARE)),
			responseMs: input.responseSeconds * 1000,
		},
		tools: { ceiling: input.toolCeiling },
		retries: { max: input.maxRetries },
		refusals: input.refusals,
		depth: 1,
	};
}

/**
 * The one line that tells a worker its wall clock, in its dynamic prompt. It states the handback, never a cue to stop:
 * told it would "stop as timed out", luna and haiku coders quit 13 to 21 s into a 2 min run (fleet M8).
 */
export function wallClockMessage(wallMs: number): string {
	const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;
	return `Wall clock: this run has ${minutes(wallMs)} from dispatch, and the host keeps that time for you. Keep working on the task at your normal pace; do not stop early, skip steps or cut the work short because of the clock. At ${Math.round(WALL_HANDBACK_SHARE * 100)}% the host withdraws your tools and asks for your report; that round is when you say what you finished and what is left.`;
}

export interface PlanCardLimitsInput {
	/** False when the route has no rates and the estimate is only the unknown-pricing sentinel. */
	priced: boolean;
	costUpperBoundUsd: number;
	/** Output tokens the estimate priced: the route's output bound. */
	outputBoundTokens: number;
	budget: RunToolBudgetEnvelope;
	/** Only a native worker's own loop applies the per-response limit. */
	nativeWorker: boolean;
	/** `safety.limits.workerResponseSeconds`. */
	responseSeconds: number;
	/** The run's wall clock before the call's `timeout_ms` is known (`resolveRunWall`). */
	wallMs: number;
}

const WALL_CLAUSE = /the run stops at its (\d+) ms wall clock/;

/**
 * The bounds one dispatched run has, as its plan card states them (ruling 13). A priced route names its estimate and
 * the output bound it was priced at; an unpriced route has no cost bound, so the card names what does stop it: the
 * per-response limit of a native worker, the run's wall clock (lowered by the call's timeout_ms,
 * `planCardLimitsUnderTimeout`), and the tool ceiling. An external one-shot worker's tool calls are not counted, so
 * it is promised no tool ceiling.
 */
export function planCardLimits(input: PlanCardLimitsInput): string {
	const tools =
		input.budget.enforcement.classification === "external-one-shot"
			? "one launch whose tool calls Clio cannot count, so no tool ceiling applies"
			: budgetLimitWords(input.budget);
	const wall = `the run stops at its ${input.wallMs} ms wall clock`;
	if (input.priced) {
		return `cost ${renderUsdEstimate(input.costUpperBoundUsd)} per model call at a ${input.outputBoundTokens}-token output bound; ${wall}; ${tools}`;
	}
	const response = input.nativeWorker ? `each response stops at ${input.responseSeconds} s, and ` : "";
	return `unpriced route: ${response}${wall}; ${tools}`;
}

/** The card's limits once the dispatch call sets `timeout_ms`, which lowers every run's wall clock to it. */
export function planCardLimitsUnderTimeout(limits: string, timeoutMs: number): string {
	return limits.replace(WALL_CLAUSE, (clause, ms: string) =>
		Number(ms) <= timeoutMs ? clause : `the call's timeout_ms stops the run within ${timeoutMs} ms`,
	);
}
