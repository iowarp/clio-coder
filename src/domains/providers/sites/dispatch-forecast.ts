/**
 * `dispatchForecast`: does this turn read as work for workers, and in what shape?
 *
 * A hint for the main agent's plan, never a decision: Jev does not dispatch,
 * does not pick a recipe, and does not choose a dispatch mode. The main agent
 * reads one line in the submitted user message and stays responsible for
 * whether and how it delegates.
 *
 * The shape question is scoped to the work a worker would carry out. Asked
 * about the whole request, jev-latest read "dispatch the scout ... then
 * summarize its report for me" as a sequence at 0.80, because the summary is a
 * later step; scoped this way it answered `single` at 0.63 to 0.65 while
 * review-then-fix-then-test held at `sequence` and a one-worker-per-file
 * comparison at `parallel`.
 */

import { chosen, pick, yesNo } from "../decisions.js";
import type { PreTurnSite } from "../pre-turn-brief.js";

/** Bumped when the wording changes. */
export const DISPATCH_FORECAST_VERSION = "dispatchforecast-v1";

/**
 * Probability at or above which the hint is given. Over the labeled fixture,
 * requests that warranted workers measured 0.81 to 0.95 apart from two
 * borderline prompts near 0.5, and the rest at most 0.25; the highest live
 * negative in the scenario runs was 0.54. "explore this repo fully" measured
 * 0.74 to 0.82, so a bar at 0.85 never hinted the case the site exists for.
 * An unwarranted dispatch is still a cost, so the bar sits above 0.54.
 */
const HINT_THRESHOLD = 0.7;

/** Below this certainty the shape is left out of the hint rather than guessed. */
const SHAPE_MIN_CONFIDENCE = 0.5;

const SHAPES = {
	single: "One worker handles the whole request",
	parallel: "Several independent pieces that can run at the same time",
	sequence: "Ordered steps where each depends on the previous step's result",
	council: "Several independent opinions on the same question",
} as const;

export type DispatchShape = keyof typeof SHAPES;

const SHAPE_PHRASES: Readonly<Record<DispatchShape, string>> = {
	single: "one worker could carry it",
	parallel: "it splits into independent pieces that could run in parallel",
	sequence: "its steps depend on each other, so they would run in order",
	council: "it asks for independent opinions, which a council gives",
};

export interface DispatchForecast {
	/** Probability that the turn is work for workers. */
	readonly dispatch: number;
	/** The split the work reads as, or null when undecided. */
	readonly shape: DispatchShape | null;
}

export function dispatchForecastHint(value: DispatchForecast): string | null {
	if (value.dispatch < HINT_THRESHOLD) return null;
	const shape = value.shape === null ? "" : `; ${SHAPE_PHRASES[value.shape]}`;
	// Naming the rule and its timing is what moved qwopus3.8-27b: with only the
	// first sentence it explored with 40 or more of its own calls in two of two
	// runs; with the second it sent four parallel scouts first in two of two.
	return `[Plan] This reads as work suited to workers${shape}. Your delegation rules apply: dispatch before you read or edit, so your own context stays free. Whether and how to dispatch stays your call.`;
}

export const dispatchForecastSite: PreTurnSite<DispatchForecast> = {
	site: "dispatchForecast",
	version: DISPATCH_FORECAST_VERSION,
	prepare: () => ({
		questions: {
			dispatch: yesNo(
				"Should `task` be handed to one or more separate worker agents rather than handled directly by the assistant?",
				"Broad exploration of a codebase, several separable pieces of work, or the request explicitly asks for agents, workers, scouts or a council",
				"A conversational reply, one focused question, or one contained change the assistant can handle itself in a few steps",
			),
			shape: pick(
				"How should the work in `task` that a worker would carry out be split? Ignore anything the assistant itself is asked to do with the workers' results afterwards.",
				SHAPES,
			),
		},
	}),
	read(answers) {
		const dispatch = answers.dispatch;
		if (dispatch?.type !== "noul" || dispatch.noul === undefined || !Number.isFinite(dispatch.noul)) return null;
		const picked = chosen(answers.shape, { minConfidence: SHAPE_MIN_CONFIDENCE });
		return {
			dispatch: dispatch.noul,
			// Constrained to the keys it was given; anything else is a malformed
			// answer and reads as undecided rather than widening the set.
			shape: picked !== null && picked in SHAPES ? (picked as DispatchShape) : null,
		};
	},
	hint: dispatchForecastHint,
	summarize: (value) => ({ dispatch: Math.round(value.dispatch * 100) / 100, shape: value.shape }),
};
