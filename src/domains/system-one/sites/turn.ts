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
import type { CategoryGroup, CatalogCategory } from "../hierarchy.js";
import { groupByCategory, representative } from "../hierarchy.js";
import { MAX_CHOICE_OPTIONS, pick, yesNo } from "../questions.js";
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
	/** The catalog's categories for this recipe, coarsest first, each with its stated purpose. */
	readonly categories?: ReadonlyArray<CatalogCategory>;
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
	/**
	 * Options the engine answering the recipe task reads in one question
	 * (`SystemOne.limits("turn", "recipe")`). A catalog past it is asked by
	 * category first; absent means the legacy wire's bound.
	 */
	readonly recipeOptionLimit?: number;
}

/**
 * Each probability is null when the engine did not answer that question, which
 * a model profile without yes/no questions never does. Null is not a low
 * probability: no hint or act reads it, and the advisory intent, shape and
 * breadth answers stand on their own.
 */
export interface TurnValue {
	/** Probability that the turn needs nothing from the workspace. */
	readonly direct: number | null;
	/** Probability that the turn is work for workers. */
	readonly dispatch: number | null;
	/** The split the delegated work reads as, or null when undecided. */
	readonly shape: TurnShape | null;
	/** The workflow the message asks for, or `unknown` when undecided. */
	readonly intent: TurnIntent;
	readonly intentCertainty: number;
	/** Probability that the turn asks for an orientation in the repository or an area of it. */
	readonly orientation: number | null;
	readonly breadth: TurnBreadth | null;
	/** Probability that the turn asks what to do next while stating no task of its own. */
	readonly direction: number | null;
	/** The recipe a dispatch would name first, or null when undecided. Absent unless the recipe question was asked. */
	readonly recipe?: string | null;
	/**
	 * The recipe category a dispatch would draw from, when the catalog was too
	 * large to offer flat; the host asks `TURN_RECIPE_SITE` within it. Null when
	 * undecided or "none". Absent unless the category question was asked.
	 */
	readonly recipeGroup?: string | null;
	/** Why no recipe question could be asked of an oversized catalog. */
	readonly recipeAbstained?: string;
	/** One line for the main agent's submitted message, or null when the policy stays silent. */
	readonly hints: { readonly scope: string | null; readonly plan: string | null };
	/** What the turn controller may start. Never a grant of authority. */
	readonly acts: {
		readonly orientation: boolean;
		readonly direction: boolean;
		readonly prewarm: boolean;
		/** The fitted dispatch cut fired: the model is about to dispatch, so the harness skips its own orientation. Unlike the plan hint it holds when the task names delegation. */
		readonly dispatch: boolean;
		/** The prewarm cut fired and a recipe category was chosen: the prewarm waits on `TURN_RECIPE_SITE`. */
		readonly prewarmPending: boolean;
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

const RECIPE_GROUP_INSTRUCTIONS =
	"Which category holds the one worker agent the assistant would dispatch first for `task`? Pick by the category's stated purpose. Pick none when no category fits.";

const RECIPE_INSTRUCTIONS =
	"Which one worker agent would the assistant dispatch first for `task`? Pick the agent whose description matches the work that agent would carry out. When the request names an agent, pick that agent. Ignore what the assistant does itself with the results afterwards.";

/**
 * Short criteria for renderers with a declared per-option bound (Julia-1 reads
 * 48 tokens per option, and most full criteria here are longer). They are the
 * site's own wording under `TURN_COMPACT_VERSION`, which joins the threshold
 * identity of any build read through them; no Jev cut was measured on them and
 * none applies. Each option fits 46 UTF-8 bytes, so it provably fits the bound.
 */
const TURN_COMPACT_VERSION = "turn-compact-v1";
const COMPACT: Readonly<Record<string, Question>> = {
	direct: yesNo(DIRECT_QUESTION.instructions, "Answerable without this workspace", "Needs this workspace or an action"),
	dispatch: yesNo(
		DISPATCH_QUESTION.instructions,
		"Names workers or broad separable work",
		"Direct reply, focused change, or plan only",
	),
	shape: pick(SHAPE_QUESTION.instructions, {
		single: "One worker carries it",
		parallel: "Independent pieces in parallel",
		sequence: "Ordered dependent steps",
		council: "Independent opinions on one question",
	}),
	intent: pick(INTENT_QUESTION.instructions, {
		answer: "Answer from context or general knowledge",
		inspect: "Needs evidence from files or tools",
		plan: "Wants a design or review first",
		implement: "Wants a change made in the workspace",
		interview: "Blocked on a missing user decision",
		continue: "Continues or corrects the previous work",
		unknown: "Not enough evidence to tell",
	}),
	orientation: yesNo(
		ORIENTATION_QUESTION.instructions,
		"Asks for a tour or overview of an area",
		"Asks one fact, a change, or chat",
	),
	breadth: pick(BREADTH_QUESTION.instructions, {
		repository: "The whole repository",
		area: "One subsystem or directory",
		focused: "One file, symbol, or fact",
	}),
	direction: yesNo(
		DIRECTION_QUESTION.instructions,
		"Asks what to do next or for options",
		"States, continues or approves a task",
	),
};

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

/** Code points of one recipe category's representative line. */
const MAX_RECIPE_GROUP_CHARS = 240;
/**
 * The exit option of a category pick: a catalog is open, so "none of these" must
 * be answerable. Group keys are category ids, which `groupByCategory` refuses
 * when they contain `/`, so a key starting with one can never name a category.
 */
const NO_GROUP = "/none";

type RecipePlan =
	| { readonly kind: "flat"; readonly options: Record<string, string> }
	| {
			readonly kind: "groups";
			readonly groups: ReadonlyArray<CategoryGroup<TurnRecipeOption>>;
			readonly options: Record<string, string>;
	  }
	| { readonly kind: "abstain"; readonly reason: string };

/**
 * How the recipe catalog is asked: flat when the answering engine reads every
 * option in one question, by the catalog's own categories when it does not,
 * and not at all when the catalog carries no categories to group by. The
 * shared `groupByCategory` bounds groups to one question's options with an
 * exit, and members to one follow-up question.
 */
function recipePlan(object: TurnObject): RecipePlan | null {
	const offered = askedRecipes(object.recipes);
	if (offered === null) return null;
	const limit = Math.max(2, Math.min(object.recipeOptionLimit ?? MAX_CHOICE_OPTIONS, MAX_CHOICE_OPTIONS));
	if (Object.keys(offered).length <= limit) return { kind: "flat", options: offered };
	const unique = (object.recipes ?? []).filter((recipe) => Object.hasOwn(offered, recipe.id.trim()));
	const grouping = groupByCategory(
		unique.map((recipe) => ({ ...recipe, id: recipe.id.trim() })),
		{ maxGroups: limit - 1, maxMembers: limit },
	);
	if ("abstain" in grouping) return { kind: "abstain", reason: grouping.abstain };
	const options: Record<string, string> = {};
	for (const group of grouping.groups) options[group.key] = representative(group, MAX_RECIPE_GROUP_CHARS);
	options[NO_GROUP] = "No listed category holds the worker this request needs first";
	return { kind: "groups", groups: grouping.groups, options };
}

/**
 * The recipes of the category a turn chose, for `TURN_RECIPE_SITE`. Empty when
 * the key names no group or the group is too large for one question, which the
 * host treats as no prewarm.
 */
export function recipesInGroup(object: TurnObject, key: string): ReadonlyArray<TurnRecipeOption> {
	const plan = recipePlan(object);
	if (plan === null || plan.kind !== "groups") return [];
	const group = plan.groups.find((entry) => entry.key === key);
	return group === undefined || group.oversized ? [] : group.members;
}

/**
 * The winning option when it holds at least `cut` of the mass and clears the
 * recipe certainty floor, else null. A cut on a choice is a probability of the
 * chosen option, never a certainty.
 */
function choiceAtCut(answer: Answer | undefined, cut: number, allowed: ReadonlyArray<string>): string | null {
	const winner = choiceIn(answer, RECIPE_MIN_CERTAINTY, allowed);
	if (winner === null || answer?.calibrated !== true) return null;
	const mass = answer.probabilities?.[winner];
	return mass !== undefined && Number.isFinite(mass) && mass >= cut ? winner : null;
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
		| "direct"
		| "dispatch"
		| "intent"
		| "orientation"
		| "breadth"
		| "direction"
		| "shape"
		| "recipe"
		| "recipeGroup"
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
	const crosses = (p: number | null, at: number | undefined): boolean => at !== undefined && p !== null && p >= at;
	const dispatchConfident = crosses(value.dispatch, dispatchCut);
	const prewarmReady = crosses(value.dispatch, prewarmCut);
	return {
		hints: {
			scope: crosses(value.direct, directCut) ? TURN_SCOPE_HINT : null,
			plan: dispatchConfident && !NAMES_DELEGATION.test(task) ? planHint(value.shape) : null,
		},
		acts: {
			// Intent is a veto for the three workflows that already have a task in hand.
			orientation:
				crosses(value.orientation, orientationCut) &&
				(value.breadth === "repository" || value.breadth === "area") &&
				value.intent !== "implement" &&
				value.intent !== "continue" &&
				value.intent !== "interview",
			direction: crosses(value.direction, directionCut),
			dispatch: dispatchConfident,
			prewarm: prewarmReady && typeof value.recipe === "string",
			prewarmPending: prewarmReady && typeof value.recipeGroup === "string",
		},
	};
}

export const TURN_SITE: SiteDefinition<TurnObject, TurnValue> = {
	id: "turn",
	version: "turn-v2",
	deadlineMs: 600,
	// The recipe pick is its own task so it can be routed apart from intent; every cut reads intent answers.
	// The recipe pick is its own task so it can be routed apart from intent, and
	// a category pick is cluster selection with its own cut; every other cut reads
	// intent answers.
	taskOf: (id) => (id === "recipe" ? "recipe" : id === "recipeGroup" ? "clusterSelect" : "intent"),
	cutTask: (key) => (key === "recipeGroup" ? "clusterSelect" : "intent"),
	compact: {
		version: TURN_COMPACT_VERSION,
		questions(object) {
			// A category pick's compact options are the categories' own labels.
			const plan = recipePlan(object);
			if (plan?.kind !== "groups") return COMPACT;
			const labels: Record<string, string> = {};
			for (const group of plan.groups) labels[group.key] = group.category.label;
			labels[NO_GROUP] = "None of these";
			return { ...COMPACT, recipeGroup: pick(RECIPE_GROUP_INSTRUCTIONS, labels) };
		},
	},
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
		const plan = recipePlan(object);
		const questions: Record<string, Question> = {
			direct: DIRECT_QUESTION,
			dispatch: DISPATCH_QUESTION,
			shape: SHAPE_QUESTION,
			intent: INTENT_QUESTION,
			orientation: ORIENTATION_QUESTION,
			breadth: BREADTH_QUESTION,
			direction: DIRECTION_QUESTION,
		};
		if (plan?.kind === "flat") questions.recipe = pick(RECIPE_INSTRUCTIONS, plan.options);
		if (plan?.kind === "groups") questions.recipeGroup = pick(RECIPE_GROUP_INSTRUCTIONS, plan.options);
		return questions;
	},
	read(answers, object, cuts) {
		const direct = probability(answers.direct);
		const dispatch = probability(answers.dispatch);
		const orientation = probability(answers.orientation);
		const direction = probability(answers.direction);
		// A profile may answer only part of the turn (a label model takes the
		// choices and not the yes/no questions). Any answered question is a value;
		// only a call that answered nothing is no value.
		if (!Object.values(answers).some((answer) => answer !== undefined)) return null;
		const shape = choiceIn(answers.shape, SHAPE_MIN_CERTAINTY, Object.keys(TURN_SHAPES)) as TurnShape | null;
		const intentAnswer = answers.intent;
		const intent = (choiceIn(intentAnswer, INTENT_MIN_CERTAINTY, TURN_INTENTS) ?? "unknown") as TurnIntent;
		const breadth = choiceIn(answers.breadth, BREADTH_MIN_CERTAINTY, BREADTHS) as TurnBreadth | null;
		const plan = recipePlan(object);
		const recipe =
			plan?.kind === "flat" ? choiceIn(answers.recipe, RECIPE_MIN_CERTAINTY, Object.keys(plan.options)) : undefined;
		// A category pick narrows what a prewarm may start, so it reads only under its own cut.
		const groupCut = cuts.fitted ? cuts.cut("recipeGroup") : undefined;
		const pickedGroup =
			plan?.kind === "groups" && groupCut !== undefined
				? choiceAtCut(answers.recipeGroup, groupCut, Object.keys(plan.options))
				: null;
		const recipeGroup = plan?.kind === "groups" ? (pickedGroup === NO_GROUP ? null : pickedGroup) : undefined;
		const value = {
			direct,
			dispatch,
			shape,
			intent,
			intentCertainty: intentAnswer?.type === "choice" ? intentAnswer.certainty : 0,
			orientation,
			breadth,
			direction,
			...(recipe !== undefined ? { recipe } : {}),
			...(recipeGroup !== undefined ? { recipeGroup } : {}),
			...(plan?.kind === "abstain" ? { recipeAbstained: plan.reason } : {}),
		};
		return { ...value, ...policy(value, object.task, cuts) };
	},
	summarize: (value) => ({
		direct: value.direct === null ? null : round2(value.direct),
		dispatch: value.dispatch === null ? null : round2(value.dispatch),
		shape: value.shape,
		intent: value.intent,
		intentCertainty: round2(value.intentCertainty),
		orientation: value.orientation === null ? null : round2(value.orientation),
		breadth: value.breadth,
		direction: value.direction === null ? null : round2(value.direction),
		...(value.recipe !== undefined ? { recipe: value.recipe } : {}),
		...(value.recipeGroup !== undefined ? { recipeGroup: value.recipeGroup } : {}),
		...(value.recipeAbstained !== undefined ? { recipeAbstained: value.recipeAbstained } : {}),
		scopeHint: value.hints.scope !== null,
		planHint: value.hints.plan !== null,
		actOrientation: value.acts.orientation,
		actDirection: value.acts.direction,
		actPrewarm: value.acts.prewarm,
		actDispatch: value.acts.dispatch,
		actPrewarmPending: value.acts.prewarmPending,
	}),
};

export interface TurnRecipeObject {
	readonly task: string;
	readonly previous: string;
	readonly previousTask: string;
	/** The members of the chosen category, from `recipesInGroup`. */
	readonly recipes: ReadonlyArray<TurnRecipeOption>;
}

/**
 * The second step of a category-first recipe pick: which recipe within the
 * category the turn chose. Its own version, moment and cut key
 * (`turn.recipeInGroup`), because a pick among a category's members is a
 * different question from the flat pick `turn-v2` was measured on. Bounded to
 * one request under its own deadline, after the turn call.
 */
export const TURN_RECIPE_SITE: SiteDefinition<TurnRecipeObject, { readonly recipe: string | null }> = {
	id: "turn",
	version: "turn-recipe-v1",
	moment: "recipe",
	deadlineMs: 600,
	taskOf: () => "recipe",
	cutTask: () => "recipe",
	state(object) {
		const task = boundedHead(object.task, MAX_TASK_CHARS);
		if (task.length === 0 || askedRecipes(object.recipes) === null) return null;
		return {
			task,
			previous: boundedTail(withoutQuotedCode(object.previous), MAX_PREVIOUS_CHARS),
			previousTask: boundedHead(object.previousTask, MAX_PREVIOUS_TASK_CHARS),
		};
	},
	questions(object) {
		const offered = askedRecipes(object.recipes);
		return offered === null ? {} : { recipe: pick(RECIPE_INSTRUCTIONS, offered) };
	},
	read(answers, object, cuts) {
		const offered = askedRecipes(object.recipes);
		const cut = cuts.fitted ? cuts.cut("recipeInGroup") : undefined;
		if (offered === null || cut === undefined) return null;
		const recipe = choiceAtCut(answers.recipe, cut, Object.keys(offered));
		return recipe === null ? null : { recipe };
	},
	summarize: (value) => ({ recipe: value.recipe }),
};
