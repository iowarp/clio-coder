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
	/**
	 * The recipe the main agent would dispatch first, or null when undecided.
	 * Absent unless the recipe question was asked, which happens only with
	 * `fleet.speculativeDispatch` on. It feeds the harness prewarm alone and
	 * never reaches the main agent: the hint does not name it.
	 */
	readonly recipe?: string | null;
}

/** One installed recipe offered as an answer, described by its own recipe description. */
export interface DispatchRecipeOption {
	readonly id: string;
	readonly description: string;
}

/** Bumped when the recipe question's wording changes. */
export const DISPATCH_RECIPE_VERSION = "dispatchrecipe-v2";

/**
 * Wording v2 of the recipe question. Over the 24 labeled turns in
 * `tests/fixtures/decision-cases/dispatch-recipe.json`, four live runs against
 * jev-latest agreed 91 of 96 times at this confidence floor, abstained 5 times
 * and were never wrong. v1 asked for a "kind of worker" and read a request
 * naming claude-code as work for coder at 0.73 and 0.78.
 */
const RECIPE_INSTRUCTIONS =
	"Which one worker agent would the assistant dispatch first for `task`? Pick the agent whose description matches the work that agent would carry out. When the request names an agent, pick that agent. Ignore what the assistant does itself with the results afterwards.";

/**
 * A wrong prediction costs one idle process until the turn settles, so the bar
 * favors abstaining. At 0.5 the fixture drew one wrong answer; at 0.6, none.
 */
const RECIPE_MIN_CONFIDENCE = 0.6;
/** Code points of one recipe description offered as an option. */
const MAX_RECIPE_DESCRIPTION_CHARS = 240;

function boundedDescription(value: string): string {
	const points = [...value.replace(/\s+/g, " ").trim()];
	return points.length <= MAX_RECIPE_DESCRIPTION_CHARS
		? points.join("")
		: `${points.slice(0, MAX_RECIPE_DESCRIPTION_CHARS - 1).join("")}…`;
}

export function dispatchForecastHint(value: DispatchForecast): string | null {
	if (value.dispatch < HINT_THRESHOLD) return null;
	const shape = value.shape === null ? "" : `; ${SHAPE_PHRASES[value.shape]}`;
	// Naming the rule and its timing is what moved qwopus3.8-27b: with only the
	// first sentence it explored with 40 or more of its own calls in two of two
	// runs; with the second it sent four parallel scouts first in two of two.
	return `[Plan] This reads as work suited to workers${shape}. Your delegation rules apply: dispatch before you read or edit, so your own context stays free. Whether and how to dispatch stays your call.`;
}

/** True when a forecast is confident enough to hint, the same bar a prewarm uses. */
export function dispatchForecastConfident(value: DispatchForecast): boolean {
	return value.dispatch >= HINT_THRESHOLD;
}

export interface DispatchForecastSiteOptions {
	/**
	 * The recipes to predict among, or null to leave the question out. The host
	 * returns null unless `fleet.speculativeDispatch` is on, so with the leaf off
	 * the request is byte-identical to one from before the question existed.
	 */
	readonly recipes?: () => ReadonlyArray<DispatchRecipeOption> | null;
}

export function createDispatchForecastSite(options: DispatchForecastSiteOptions = {}): PreTurnSite<DispatchForecast> {
	return {
		site: "dispatchForecast",
		version: DISPATCH_FORECAST_VERSION,
		prepare: () => {
			const recipes = options.recipes?.() ?? null;
			const offered: Record<string, string> = {};
			for (const recipe of recipes ?? []) offered[recipe.id] = boundedDescription(recipe.description || recipe.id);
			return {
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
					...(Object.keys(offered).length >= 2 ? { recipe: pick(RECIPE_INSTRUCTIONS, offered) } : {}),
				},
			};
		},
		read(answers, ask) {
			const dispatch = answers.dispatch;
			if (dispatch?.type !== "noul" || dispatch.noul === undefined || !Number.isFinite(dispatch.noul)) return null;
			const picked = chosen(answers.shape, { minConfidence: SHAPE_MIN_CONFIDENCE });
			const recipeQuestion = ask.questions.recipe;
			let recipe: string | null | undefined;
			if (recipeQuestion !== undefined) {
				const predicted = chosen(answers.recipe, { minConfidence: RECIPE_MIN_CONFIDENCE });
				const criteria = recipeQuestion.criteria as Record<string, string>;
				recipe = predicted !== null && Object.hasOwn(criteria, predicted) ? predicted : null;
			}
			return {
				dispatch: dispatch.noul,
				// Constrained to the keys it was given; anything else is a malformed
				// answer and reads as undecided rather than widening the set.
				shape: picked !== null && picked in SHAPES ? (picked as DispatchShape) : null,
				...(recipe !== undefined ? { recipe } : {}),
			};
		},
		hint: dispatchForecastHint,
		summarize: (value) => ({
			dispatch: Math.round(value.dispatch * 100) / 100,
			shape: value.shape,
			...(value.recipe !== undefined ? { recipe: value.recipe, recipeVersion: DISPATCH_RECIPE_VERSION } : {}),
		}),
	};
}

/** The site without the recipe question, which is what every host asks unless the prewarm is on. */
export const dispatchForecastSite: PreTurnSite<DispatchForecast> = createDispatchForecastSite();
