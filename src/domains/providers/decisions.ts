/**
 * Call-site layer over `RuntimeDescriptor.decide()`.
 *
 * A System One model is only worth having if asking it something costs one
 * line. The raw wire shape is a nested question map; these builders and readers
 * keep that out of the dozens of places that want a single typed judgment —
 * intent classification, dispatch routing, evidence provenance, memory-layer
 * admission — and keep the threshold policy in one place instead of re-derived
 * at each call.
 *
 *   const decider = createDecider(runtime, target, ctx);
 *   const { route } = await decider.ask(state, {
 *     route: pick("Which worker takes this?", {
 *       scout: "Read-only triage",
 *       coder: "Needs edits",
 *     }),
 *   });
 *   if (chosen(route) === "scout") ...
 */

import type { DecideResult, DecisionAnswer, DecisionQuestion } from "./types/inference.js";
import type { ProbeContext, RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

/** A yes/no judgment. Both branches are described so the model is not guessing the scale. */
export function yesNo(instructions: string, whenTrue: string, whenFalse: string): DecisionQuestion {
	return { type: "noul", instructions, criteria: { true: whenTrue, false: whenFalse } };
}

/** A pick from named options, each with the description that defines it. */
export function pick(instructions: string, options: Record<string, string>): DecisionQuestion {
	return { type: "choice", instructions, criteria: options };
}

/** A rating on an ordered ladder, lowest rung first. */
export function rate(instructions: string, ladder: ReadonlyArray<string>): DecisionQuestion {
	return { type: "score", instructions, criteria: ladder };
}

export interface ReadThresholds {
	/** Probability at or above which a `noul` reads as true. Defaults to 0.5. */
	threshold?: number;
	/**
	 * Minimum model confidence for the answer to count. Below it the reader
	 * returns null — an abstention, which is not the same as a negative.
	 */
	minConfidence?: number;
}

/**
 * How peaked the answer's distribution is, on the same 0..1 axis for every
 * primitive. `choice` and `score` carry the figure directly. A live `noul` does
 * not: the wire response omits `confidence` entirely, so reading it as zero
 * made every `minConfidence` check abstain unconditionally.
 *
 * A noul is a two-outcome distribution, and the provider's own peakedness
 * formula `(n * max - 1) / (n - 1)` reduces at n=2 to `|2p - 1|`, which is the
 * probability's distance from the coin-flip scaled to that axis. So a noul of
 * 0.65 reports 0.30, exactly as a two-option `choice` at the same mass would.
 */
function certainty(answer: DecisionAnswer): number {
	if (answer.confidence !== undefined) return answer.confidence;
	if (answer.type === "noul" && answer.noul !== undefined) return Math.abs(answer.noul * 2 - 1);
	return 0;
}

function confident(answer: DecisionAnswer, minConfidence: number | undefined): boolean {
	if (minConfidence === undefined) return true;
	return certainty(answer) >= minConfidence;
}

/**
 * Read a `noul` as a boolean. Null means the model abstained or the answer was
 * the wrong type; a caller gating on this must treat null as "do not know"
 * rather than folding it into false.
 */
export function isTrue(answer: DecisionAnswer | undefined, opts: ReadThresholds = {}): boolean | null {
	if (!answer || answer.type !== "noul" || answer.noul === undefined) return null;
	if (!confident(answer, opts.minConfidence)) return null;
	return answer.noul >= (opts.threshold ?? 0.5);
}

/** Read the winning option of a `choice`, or null when it abstained. */
export function chosen(answer: DecisionAnswer | undefined, opts: ReadThresholds = {}): string | null {
	if (!answer || answer.type !== "choice" || answer.choice === undefined) return null;
	if (!confident(answer, opts.minConfidence)) return null;
	if (opts.threshold !== undefined) {
		const mass = answer.probabilities?.[answer.choice] ?? 0;
		if (mass < opts.threshold) return null;
	}
	return answer.choice;
}

/** Read a `score` as its position on the ladder, or null when it abstained. */
export function rating(answer: DecisionAnswer | undefined, opts: ReadThresholds = {}): number | null {
	if (!answer || answer.type !== "score" || answer.score === undefined) return null;
	if (!confident(answer, opts.minConfidence)) return null;
	return answer.score;
}

export interface Decider {
	/**
	 * Evaluate every question against one body of state in a single round trip.
	 * Questions are independent, so batching is free: ask for everything the
	 * call site needs at once rather than chaining.
	 */
	ask(
		state: string | object | ReadonlyArray<unknown>,
		questions: Record<string, DecisionQuestion>,
		options?: { model?: string; signal?: AbortSignal },
	): Promise<Record<string, DecisionAnswer>>;
	/** Same call, keeping the resolved model id and token usage for receipts. */
	askDetailed(
		state: string | object | ReadonlyArray<unknown>,
		questions: Record<string, DecisionQuestion>,
		options?: { model?: string; signal?: AbortSignal },
	): Promise<DecideResult>;
}

/**
 * Bind a decision-capable runtime to a target. Throws when the runtime has no
 * `decide()`, so a misconfigured target fails at the binding rather than
 * halfway through whatever the caller was gating.
 */
export function createDecider(
	runtime: RuntimeDescriptor,
	target: TargetDescriptor,
	ctx: ProbeContext,
	resolveAuthToken?: (signal?: AbortSignal) => Promise<string | undefined>,
): Decider {
	const decide = runtime.decide;
	if (!decide) {
		throw new Error(`runtime '${runtime.id}' does not support decide()`);
	}
	const askDetailed: Decider["askDetailed"] = async (state, questions, options = {}) => {
		// Resolved per call rather than at binding: a decider outlives a key
		// rotation, and an operator who stores a key mid-session is answered on
		// the next question rather than at the next restart.
		const authToken = ctx.authToken ?? (await resolveAuthToken?.(options.signal));
		return decide.call(
			runtime,
			target,
			{
				state,
				questions,
				...(options.model !== undefined ? { model: options.model } : {}),
				...(options.signal !== undefined ? { signal: options.signal } : {}),
			},
			authToken ? { ...ctx, authToken } : ctx,
		);
	};
	return {
		askDetailed,
		async ask(state, questions, options) {
			const result = await askDetailed(state, questions, options);
			return result.answers;
		},
	};
}
