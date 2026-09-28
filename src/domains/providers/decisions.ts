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

import type { DecisionSite } from "../../core/defaults.js";
import {
	type DecisionCallOutcome,
	decisionCallsRecorded,
	recordDecisionCall,
	recordedAnswers,
	stateDigest,
} from "./decision-calls.js";
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
 * primitive. Providers disagree on the `confidence` scale for `choice` and
 * `score`, so use their probability distribution when it is available. Jev
 * reports peakedness directly; Laya reports normalized entropy. A live `noul`
 * carries no confidence field, so its probability supplies the measure.
 *
 * A noul is a two-outcome distribution, and the provider's own peakedness
 * formula `(n * max - 1) / (n - 1)` reduces at n=2 to `|2p - 1|`, which is the
 * probability's distance from the coin-flip scaled to that axis. So a noul of
 * 0.65 reports 0.30, exactly as a two-option `choice` at the same mass would.
 */
export function answerCertainty(answer: DecisionAnswer): number {
	if (answer.type === "noul" && answer.noul !== undefined) return Math.abs(answer.noul * 2 - 1);
	const masses = Object.values(answer.probabilities ?? {});
	if (masses.length >= 2 && masses.every((mass) => Number.isFinite(mass) && mass >= 0 && mass <= 1)) {
		return Math.max(0, Math.min(1, (masses.length * Math.max(...masses) - 1) / (masses.length - 1)));
	}
	return answer.confidence ?? 0;
}

function confident(answer: DecisionAnswer, minConfidence: number | undefined): boolean {
	if (minConfidence === undefined) return true;
	return answerCertainty(answer) >= minConfidence;
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

export interface AskOptions {
	model?: string;
	signal?: AbortSignal;
	/** Sites whose questions this call carries, when a batch speaks for several. */
	sites?: ReadonlyArray<DecisionSite>;
	/** The caller's handle on what is being decided, carried into the call record. */
	ref?: string;
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
		options?: AskOptions,
	): Promise<Record<string, DecisionAnswer>>;
	/** Same call, keeping the resolved model id and token usage for receipts. */
	askDetailed(
		state: string | object | ReadonlyArray<unknown>,
		questions: Record<string, DecisionQuestion>,
		options?: AskOptions,
	): Promise<DecideResult>;
}

/** Thrown before any request when the state cannot fit the target's decision window. */
class DecisionStateOverflowError extends Error {}

/** Thrown before any request while a failing target cools down. */
class DecisionTargetCoolingError extends Error {}

/**
 * Tokens a piece of decision evidence costs, by the chars/4 estimate the
 * harness uses everywhere else. It errs short on dense code, so a target whose
 * window is tight declares a `contextWindow` a little under the real one.
 */
function estimateDecisionTokens(value: unknown): number {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	return Math.ceil(text.length / 4);
}

/**
 * The window one decision call must fit: the target's declared
 * `capabilities.contextWindow`, else the runtime's. Every System One server
 * answers the state plus one question at a time, so that pair is what is
 * measured. Null means neither declares one and the server is trusted.
 */
function decisionStateBudget(runtime: RuntimeDescriptor, target: TargetDescriptor): number | null {
	const window = target.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow;
	return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null;
}

/** Consecutive timed-out calls that stop a target being asked. */
const DECISION_BREAKER_THRESHOLD = 3;
/** How long a tripped target is left alone before one call probes it again. */
const DECISION_BREAKER_COOLDOWN_MS = 5 * 60_000;

interface BreakerState {
	failures: number;
	openUntil: number;
}

// A pre-turn site costs every turn its full timeout when its server hangs.
// Only timeouts trip it: a refused connection or an unusable answer comes back
// in milliseconds and costs the turn nothing. Keyed by target and model, and
// module-wide because a decider is rebuilt for every call from the live binding.
const breakers = new Map<string, BreakerState>();

/**
 * Bind a decision-capable runtime to a target. Throws when the runtime has no
 * `decide()`, so a misconfigured target fails at the binding rather than
 * halfway through whatever the caller was gating.
 *
 * Every call is checked against the target's decision window before it is
 * sent, skipped while the target is cooling down after repeated timeouts, and
 * reported to the decision-call sink whether or not it answered.
 */
export function createDecider(
	runtime: RuntimeDescriptor,
	target: TargetDescriptor,
	ctx: ProbeContext,
	resolveAuthToken?: (signal?: AbortSignal) => Promise<string | undefined>,
	boundModel?: string,
	site?: DecisionSite,
): Decider {
	const decide = runtime.decide;
	if (!decide) {
		throw new Error(`runtime '${runtime.id}' does not support decide()`);
	}
	const askDetailed: Decider["askDetailed"] = async (state, questions, options = {}) => {
		const model = options.model ?? boundModel;
		const serializedState = typeof state === "string" ? state : (JSON.stringify(state) ?? "");
		const stateTokens = estimateDecisionTokens(serializedState);
		const budget = decisionStateBudget(runtime, target);
		const breakerKey = `${target.id}/${model ?? target.defaultModel ?? "default"}`;
		const startedAt = performance.now();
		const at = new Date().toISOString();
		const sites = options.sites ?? (site === undefined ? [] : [site]);
		const report = (outcome: DecisionCallOutcome, detail: { result?: DecideResult; error?: unknown } = {}): void => {
			if (!decisionCallsRecorded()) return;
			recordDecisionCall({
				version: 1,
				at,
				sites,
				...(options.ref !== undefined ? { ref: options.ref } : {}),
				target: target.id,
				model: model ?? null,
				build: detail.result?.model ?? null,
				outcome,
				...(detail.error !== undefined
					? { error: detail.error instanceof Error ? detail.error.message : String(detail.error) }
					: {}),
				latencyMs: Math.round(performance.now() - startedAt),
				questions: Object.keys(questions).length,
				stateChars: serializedState.length,
				stateTokens,
				budgetTokens: budget,
				stateDigest: stateDigest(serializedState),
				...(detail.result !== undefined ? { answers: recordedAnswers(detail.result.answers) } : {}),
				...(detail.result?.tokensUsed !== undefined ? { usage: detail.result.tokensUsed } : {}),
			});
		};

		// Laya keeps the head of an oversized state and CLM the tail, both
		// silently, so a command at the far end of the evidence is simply not
		// read. Asking nothing is the only answer that cannot mislead.
		if (budget !== null) {
			const longestQuestion = Math.max(0, ...Object.values(questions).map((q) => estimateDecisionTokens(q)));
			if (stateTokens + longestQuestion > budget) {
				const error = new DecisionStateOverflowError(
					`decision state needs about ${stateTokens + longestQuestion} tokens; target '${target.id}' allows ${budget}`,
				);
				report("overflow", { error });
				throw error;
			}
		}

		const breaker = breakers.get(breakerKey);
		if (
			breaker !== undefined &&
			breaker.failures >= DECISION_BREAKER_THRESHOLD &&
			performance.now() < breaker.openUntil
		) {
			const error = new DecisionTargetCoolingError(
				`decision target '${breakerKey}' is cooling down after ${breaker.failures} consecutive timeouts`,
			);
			report("breaker-open", { error });
			throw error;
		}

		// The HTTP timeout starts only after credentials resolve. Own a deadline
		// around both steps so a slow credential refresh cannot stall the turn.
		const controller = new AbortController();
		const signal = controller.signal;
		let timedOut = false;
		const upstream = [options.signal, ctx.signal].filter((entry): entry is AbortSignal => entry !== undefined);
		const onUpstreamAbort = () => controller.abort(upstream.find((entry) => entry.aborted)?.reason);
		for (const entry of upstream) entry.addEventListener("abort", onUpstreamAbort, { once: true });
		if (upstream.some((entry) => entry.aborted)) onUpstreamAbort();
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(`decision timed out after ${ctx.httpTimeoutMs}ms`));
		}, ctx.httpTimeoutMs);
		const aborted = new Promise<never>((_resolve, reject) => {
			if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		try {
			const result = await Promise.race([
				(async () => {
					signal.throwIfAborted();
					// Resolved per call rather than at binding, so a rotated key is
					// available to the next question without restarting the session.
					const authToken = ctx.authToken ?? (await resolveAuthToken?.(signal));
					signal.throwIfAborted();
					return decide.call(
						runtime,
						target,
						{ state, questions, ...(model !== undefined ? { model } : {}), signal },
						authToken ? { ...ctx, authToken } : ctx,
					);
				})(),
				aborted,
			]);
			breakers.delete(breakerKey);
			report("answered", { result });
			return result;
		} catch (error) {
			const canceled = !timedOut && upstream.some((entry) => entry.aborted);
			if (timedOut) {
				const failures = (breakers.get(breakerKey)?.failures ?? 0) + 1;
				breakers.set(breakerKey, { failures, openUntil: performance.now() + DECISION_BREAKER_COOLDOWN_MS });
			} else if (!canceled) {
				// The server answered, however badly, so it is not hanging.
				breakers.delete(breakerKey);
			}
			report(canceled ? "canceled" : timedOut ? "timeout" : "failed", { error });
			throw error;
		} finally {
			clearTimeout(timer);
			for (const entry of upstream) entry.removeEventListener("abort", onUpstreamAbort);
		}
	};
	return {
		askDetailed,
		async ask(state, questions, options) {
			const result = await askDetailed(state, questions, options);
			return result.answers;
		},
	};
}
