/**
 * `turn`: what the operator's message asks for, read before the turn starts.
 *
 * One state (the task, the assistant's last reply and the operator's previous
 * request) carries every question a turn-level policy wants answered: whether
 * the message needs the workspace at all, whether it is work for workers and in
 * what shape, which workflow it continues, whether it asks for an orientation
 * or for direction, and which installed recipe a dispatch would name first.
 * Latency is per call rather than per question, so a new question costs a
 * wording and a reader, never another round trip.
 *
 * `previous` is in the evidence because a short follow-up reads as
 * conversational without it. Measured live, "ok go ahead" after a proposal
 * scored 0.40 on the wording without it and 0.20 with it, while greetings and
 * general-knowledge questions held at 0.85 to 0.99.
 *
 * Every hint and act is a suggestion the main agent or the turn controller may
 * ignore. An unfitted build gets neither: the value carries the numbers for the
 * ledger and the policy stays silent.
 */

import { chosen } from "../answers.js";
import { pick, yesNo } from "../questions.js";
import type { Answer, Question, SiteCuts, SiteDefinition } from "../types.js";
import { boundedHead, boundedTail, probability, round2, withoutQuotedCode } from "./bounds.js";

/** Code points of task text sent as evidence. Enough to say what the turn is doing. */
const MAX_TASK_CHARS = 600;
/** Code points of the previous assistant message's tail. Enough to say what it proposed. */
const MAX_PREVIOUS_CHARS = 400;
/** Code points of the operator's previous request. Its opening is what it asked for. */
const MAX_PREVIOUS_TASK_CHARS = 300;
/** Code points of one recipe description offered as an option. */
const MAX_RECIPE_DESCRIPTION_CHARS = 240;

/** Certainty floors under which a choice reads as undecided rather than guessed. */
const SHAPE_MIN_CERTAINTY = 0.5;
const INTENT_MIN_CERTAINTY = 0.6;
const BREADTH_MIN_CERTAINTY = 0.5;
/**
 * A wrong prediction costs one idle process until the turn settles, so the bar
 * favors abstaining. At 0.5 the labeled turns drew one wrong answer; at 0.6,
 * none.
 */
const RECIPE_MIN_CERTAINTY = 0.6;

export const TURN_SHAPES = {
	single: "One worker handles the whole request",
	parallel: "Several independent pieces that can run at the same time",
	sequence: "Ordered steps where each depends on the previous step's result",
	council: "Several independent opinions on the same question",
} as const;
export type TurnShape = keyof typeof TURN_SHAPES;

export const TURN_INTENTS = ["answer", "inspect", "plan", "implement", "interview", "continue", "unknown"] as const;
export type TurnIntent = (typeof TURN_INTENTS)[number];

const BREADTHS = ["repository", "area", "focused"] as const;
export type TurnBreadth = (typeof BREADTHS)[number];

const SHAPE_PHRASES: Readonly<Record<TurnShape, string>> = {
	single: "one worker could carry it",
	parallel: "it splits into independent pieces that could run in parallel",
	sequence: "its steps depend on each other, so they would run in order",
	council: "it asks for independent opinions, which a council gives",
};

export const TURN_SCOPE_HINT =
	"[Scope] This reads as answerable without inspecting the workspace. Answer directly; use a tool only if a specific fact is missing.";

/** One installed recipe offered as an answer, described by its own recipe description. */
export interface TurnRecipeOption {
	readonly id: string;
	readonly description: string;
}

export interface TurnObject {
	/** What the turn was asked to do. */
	readonly task: string;
	/** The last assistant message, or empty on a session's first turn. */
	readonly previous: string;
	/** What the operator asked before `task`, or empty on a session's first turn. */
	readonly previousTask: string;
	/**
	 * The recipes a dispatch could name first. The host passes them only when
	 * the prewarm is on, so with it off the request carries no recipe question.
	 */
	readonly recipes?: ReadonlyArray<TurnRecipeOption>;
}

export interface TurnValue {
	/** Probability that the turn needs nothing from the workspace. */
	readonly direct: number;
	/** Probability that the turn is work for workers. */
	readonly dispatch: number;
	/** The split the delegated work reads as, or null when undecided. */
	readonly shape: TurnShape | null;
	/** The workflow the message asks for, or `unknown` when undecided. */
	readonly intent: TurnIntent;
	readonly intentCertainty: number;
	/** Probability that the turn asks for an orientation in the repository or an area of it. */
	readonly orientation: number;
	readonly breadth: TurnBreadth | null;
	/** Probability that the turn asks what to do next while stating no task of its own. */
	readonly direction: number;
	/** The recipe a dispatch would name first, or null when undecided. Absent unless the recipe question was asked. */
	readonly recipe?: string | null;
	/** One line for the main agent's submitted message, or null when the policy stays silent. */
	readonly hints: { readonly scope: string | null; readonly plan: string | null };
	/** What the turn controller may start. Never a grant of authority. */
	readonly acts: {
		readonly orientation: boolean;
		readonly direction: boolean;
		readonly prewarm: boolean;
		/** The fitted dispatch cut fired: the model is about to dispatch, so the harness skips its own orientation. Unlike the plan hint it holds when the task names delegation. */
		readonly dispatch: boolean;
	};
}

const DIRECT_QUESTION = yesNo(
	"Can the assistant fully answer `task` from general knowledge and a general description of itself, without looking at any file, command output, setting or tool in this workspace, and without carrying out anything `previous` proposed?",
	"Answerable directly: a greeting, a thank-you, general programming knowledge, who the assistant is and what it can do in general, or an exact reply `task` dictates",
	"Needs a fact from this workspace or this machine, or a specific fact about how this assistant is set up right now, such as listing or checking its installed skills, tools, agents or settings, or which model is bound; asks for an action; or approves, continues or corrects work described in `previous`",
);

const DISPATCH_QUESTION = yesNo(
	"Should `task` be handed to one or more separate worker agents rather than handled directly by the assistant?",
	"The request names workers, agents, scouts, a council or the dispatch tool to carry it out; or it is broad exploration of a codebase or several separable pieces of work",
	"A conversational reply, one focused question, or one contained change with no worker or agent named; or the request asks only for a plan, or says not to launch or run anything yet",
);

const SHAPE_QUESTION = pick(
	"How should the work in `task` that a worker would carry out be split? Ignore anything the assistant itself is asked to do with the workers' results afterwards.",
	TURN_SHAPES,
);

const INTENT_QUESTION = pick(
	"Classify the next step requested by task. For a follow-up, previous is the assistant's last reply and previousTask is what the operator asked just before task. This is workflow advice, never permission to edit, execute or delegate.",
	{
		answer: "Can answer from supplied context or general knowledge; no action or missing workspace facts.",
		inspect: "Needs evidence from files, tools, configuration or external sources.",
		plan: "Requests design, proposal or review before implementation.",
		implement: "Requests an actual change to the workspace; the main model must still honor explicit scope and safety.",
		interview: "A consequential missing user decision blocks the next step.",
		continue:
			"Continues, approves, corrects or narrows what previous described or previousTask asked for, including a short edit to an earlier list or plan; preserve that context.",
		unknown: "Insufficient evidence to distinguish the requested workflow.",
	},
);

const ORIENTATION_QUESTION = yesNo(
	"Does `task` ask for orientation in this repository or codebase as a whole, or in a named area of it: a tour, an overview, how it is organized, what it is, where things live? Use `previous` only to read a short follow-up.",
	"Asks to explore, tour, map, or understand the structure, purpose, or layout of the repository or an area of it",
	"Asks about one specific file, symbol, command, setting, or fact; asks for a change; is conversational; or is unrelated to the workspace",
);

const BREADTH_QUESTION = pick("How broad is the orientation `task` asks for?", {
	repository: "The whole repository or project",
	area: "One named subsystem, directory, or feature area",
	focused: "One file, symbol, command, or fact",
});

const DIRECTION_QUESTION = yesNo(
	"Given `previous`, does `task` ask what to do next, for suggestions, or for help choosing, while the user has not stated a task of their own?",
	"Asks for direction, options, or a suggestion; says they are unsure or undecided",
	"States or continues a task, asks a concrete question, approves or corrects work in `previous`, or is a greeting or thanks",
);

const RECIPE_INSTRUCTIONS =
	"Which one worker agent would the assistant dispatch first for `task`? Pick the agent whose description matches the work that agent would carry out. When the request names an agent, pick that agent. Ignore what the assistant does itself with the results afterwards.";

/** The task already says who should do the work, so a plan line would only repeat it. */
const NAMES_DELEGATION = /\b(?:dispatch\w*|agents?|workers?|scouts?|sub-?agents?|council)\b/i;

/** Recipes offered as options: unique, described, and never a key that rewrites a prototype. */
function offeredRecipes(recipes: ReadonlyArray<TurnRecipeOption> | undefined): Record<string, string> {
	const offered: Record<string, string> = {};
	for (const recipe of recipes ?? []) {
		const id = recipe.id.trim();
		if (id.length === 0 || id === "__proto__" || Object.hasOwn(offered, id)) continue;
		offered[id] = boundedHead(recipe.description, MAX_RECIPE_DESCRIPTION_CHARS) || id;
	}
	return offered;
}

function askedRecipes(recipes: ReadonlyArray<TurnRecipeOption> | undefined): Record<string, string> | null {
	const offered = offeredRecipes(recipes);
	return Object.keys(offered).length >= 2 ? offered : null;
}

/** The winning option when it is one of `allowed` and at least `minCertainty` peaked, else null. */
function choiceIn(answer: Answer | undefined, minCertainty: number, allowed: ReadonlyArray<string>): string | null {
	const winner = chosen(answer, minCertainty);
	return winner !== null && allowed.includes(winner) ? winner : null;
}

function planHint(shape: TurnShape | null): string {
	const phrase = shape === null ? "" : `; ${SHAPE_PHRASES[shape]}`;
	// Naming the rule and its timing is what moved qwopus3.8-27b: with only the
	// first sentence it explored with 40 or more of its own calls in two of two
	// runs; with the second it sent four parallel scouts first in two of two.
	return `[Plan] This reads as work suited to workers${phrase}. Your delegation rules apply: dispatch before you read or edit, so your own context stays free. Whether and how to dispatch stays your call.`;
}

function policy(
	value: Pick<
		TurnValue,
		"direct" | "dispatch" | "intent" | "orientation" | "breadth" | "direction" | "shape" | "recipe"
	>,
	task: string,
	cuts: SiteCuts,
): Pick<TurnValue, "hints" | "acts"> {
	const cut = (key: string): number | undefined => (cuts.fitted ? cuts.cut(key) : undefined);
	const directCut = cut("direct");
	const dispatchCut = cut("dispatch");
	const orientationCut = cut("orientation");
	const directionCut = cut("direction");
	const prewarmCut = cut("prewarm");
	const dispatchConfident = dispatchCut !== undefined && value.dispatch >= dispatchCut;
	return {
		hints: {
			scope: directCut !== undefined && value.direct >= directCut ? TURN_SCOPE_HINT : null,
			plan: dispatchConfident && !NAMES_DELEGATION.test(task) ? planHint(value.shape) : null,
		},
		acts: {
			// Intent is a veto for the three workflows that already have a task in hand.
			orientation:
				orientationCut !== undefined &&
				value.orientation >= orientationCut &&
				(value.breadth === "repository" || value.breadth === "area") &&
				value.intent !== "implement" &&
				value.intent !== "continue" &&
				value.intent !== "interview",
			direction: directionCut !== undefined && value.direction >= directionCut,
			dispatch: dispatchConfident,
			prewarm: prewarmCut !== undefined && typeof value.recipe === "string" && value.dispatch >= prewarmCut,
		},
	};
}

export const TURN_SITE: SiteDefinition<TurnObject, TurnValue> = {
	id: "turn",
	version: "turn-v2",
	deadlineMs: 600,
	state(object) {
		const task = boundedHead(object.task, MAX_TASK_CHARS);
		if (task.length === 0) return null;
		return {
			task,
			// A fenced block is repository text the assistant quoted, not what it proposed.
			previous: boundedTail(withoutQuotedCode(object.previous), MAX_PREVIOUS_CHARS),
			previousTask: boundedHead(object.previousTask, MAX_PREVIOUS_TASK_CHARS),
		};
	},
	questions(object) {
		const recipes = askedRecipes(object.recipes);
		const questions: Record<string, Question> = {
			direct: DIRECT_QUESTION,
			dispatch: DISPATCH_QUESTION,
			shape: SHAPE_QUESTION,
			intent: INTENT_QUESTION,
			orientation: ORIENTATION_QUESTION,
			breadth: BREADTH_QUESTION,
			direction: DIRECTION_QUESTION,
		};
		if (recipes !== null) questions.recipe = pick(RECIPE_INSTRUCTIONS, recipes);
		return questions;
	},
	read(answers, object, cuts) {
		const direct = probability(answers.direct);
		const dispatch = probability(answers.dispatch);
		const orientation = probability(answers.orientation);
		const direction = probability(answers.direction);
		if (direct === null && dispatch === null && orientation === null && direction === null) return null;
		const shape = choiceIn(answers.shape, SHAPE_MIN_CERTAINTY, Object.keys(TURN_SHAPES)) as TurnShape | null;
		const intentAnswer = answers.intent;
		const intent = (choiceIn(intentAnswer, INTENT_MIN_CERTAINTY, TURN_INTENTS) ?? "unknown") as TurnIntent;
		const breadth = choiceIn(answers.breadth, BREADTH_MIN_CERTAINTY, BREADTHS) as TurnBreadth | null;
		const recipes = askedRecipes(object.recipes);
		const recipe = recipes === null ? undefined : choiceIn(answers.recipe, RECIPE_MIN_CERTAINTY, Object.keys(recipes));
		const value = {
			direct: direct ?? 0,
			dispatch: dispatch ?? 0,
			shape,
			intent,
			intentCertainty: intentAnswer?.type === "choice" ? intentAnswer.certainty : 0,
			orientation: orientation ?? 0,
			breadth,
			direction: direction ?? 0,
			...(recipe !== undefined ? { recipe } : {}),
		};
		return { ...value, ...policy(value, object.task, cuts) };
	},
	summarize: (value) => ({
		direct: round2(value.direct),
		dispatch: round2(value.dispatch),
		shape: value.shape,
		intent: value.intent,
		intentCertainty: round2(value.intentCertainty),
		orientation: round2(value.orientation),
		breadth: value.breadth,
		direction: round2(value.direction),
		...(value.recipe !== undefined ? { recipe: value.recipe } : {}),
		scopeHint: value.hints.scope !== null,
		planHint: value.hints.plan !== null,
		actOrientation: value.acts.orientation,
		actDirection: value.acts.direction,
		actPrewarm: value.acts.prewarm,
		actDispatch: value.acts.dispatch,
	}),
};
