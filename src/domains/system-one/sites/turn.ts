/**
 * `turn`: what the operator's message asks for, read before the turn starts.
 *
 * One state (the task, the assistant's last reply and the operator's previous
 * request) carries every question a turn-level reader wants answered: whether
 * the message needs the workspace at all, whether it holds independent work and
 * in what shape, whether it asks to synthesize how components relate, whether it
 * asks Clio to choose the next task, and whether its deliverable is a proposal.
 * `WORKER_PREPARE_SITE` asks which recipe a dispatch would name first, chained
 * after a reading that predicts a dispatch.
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
import type { CatalogCategory } from "../hierarchy.js";
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

export const TURN_SHAPES = {
	single: "One worker handles the whole request",
	parallel: "Several independent pieces that can run at the same time",
	sequence: "Ordered steps where each depends on the previous step's result",
	council: "Several independent opinions on the same question",
} as const;
export type TurnShape = keyof typeof TURN_SHAPES;

const SHAPE_PHRASES: Readonly<Record<TurnShape, string>> = {
	single: "one worker could carry it",
	parallel: "it splits into independent pieces that could run in parallel",
	sequence: "its steps depend on each other, so they would run in order",
	council: "it asks for independent opinions, which a council gives",
};

export const TURN_EXPLORE_HINT =
	"[Explore] This reads as asking how components relate. Map the responsibilities and flow with `code_nav` or a read-only scout before reading files one by one.";

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
}

/**
 * Each probability is null when the engine did not answer that question, which
 * a model profile without yes/no questions never does. Null is not a low
 * probability: no hint or act reads it.
 */
export interface TurnValue {
	/** Probability that the turn needs nothing from the workspace. */
	readonly direct: number | null;
	/** Probability that the turn holds independent work for workers. */
	readonly dispatch: number | null;
	/** The split the delegated work reads as, or null below its measured mass. */
	readonly shape: TurnShape | null;
	/** Probability that the turn asks to synthesize how components relate. */
	readonly architecture: number | null;
	/** Probability that the operator asks Clio to propose or choose the next task. */
	readonly direction: number | null;
	/** Probability that the deliverable is a proposal awaiting the operator's choice. */
	readonly proposal: number | null;
	/** One line each for the main agent's submitted message, or null when the policy stays silent. */
	readonly hints: { readonly scope: string | null; readonly plan: string | null; readonly explore: string | null };
	/** What the turn controller may start. Never a grant of authority. */
	readonly acts: {
		readonly direction: boolean;
		readonly prewarm: boolean;
		/** The dispatch cut fired: the model is about to dispatch. Unlike the plan hint it holds when the task names delegation. */
		readonly dispatch: boolean;
		/** The proposal cut fired: the plan-close may arm. */
		readonly proposal: boolean;
	};
}

const DIRECT_QUESTION = yesNo(
	"Can the assistant fully answer `task` from general knowledge and a general description of itself, without looking at any file, command output, setting or tool in this workspace, and without carrying out anything `previous` proposed?",
	"Answerable directly: a greeting, a thank-you, general programming knowledge, who the assistant is and what it can do in general, or an exact reply `task` dictates",
	"Needs a fact from this workspace or this machine, or a specific fact about how this assistant is set up right now, such as listing or checking its installed skills, tools, agents or settings, or which model is bound; asks for an action; or approves, continues or corrects work described in `previous`",
);

const DISPATCH_QUESTION = yesNo(
	"Does the work `task` asks for contain investigations or changes that separate workers could carry out on their own?",
	"The request names workers, agents, scouts or a council to carry it out, or it holds broad exploration or several separable pieces of work",
	"A conversational reply, one focused question or one contained change with no worker named; or it asks only for a plan or says not to start yet",
);

const SHAPE_QUESTION = pick(
	"Which execution shape matches how the pieces of work in `task` depend on each other? Ignore what the assistant itself does with the results afterwards.",
	TURN_SHAPES,
);

const ARCHITECTURE_QUESTION = yesNo(
	"Does `task` require synthesizing the responsibilities of components and how they relate, across a codebase or an area of it?",
	"Asks for a tour, how the parts fit together, how something flows across components, what depends on what, or how a subsystem is organized",
	"Asks for a listing, a tree, one symbol's location, one local fact or one contained change, or is conversational",
);

const DIRECTION_QUESTION = yesNo(
	"Is the operator asking the assistant to propose or choose the next task, rather than specifying, approving or continuing one? Use `previous` only to read a short follow-up.",
	"Asks what to do next, for suggestions, or for help choosing; says they are unsure what to work on",
	"States, approves, continues or corrects a task, asks a concrete question, or is a greeting or thanks",
);

const PROPOSAL_QUESTION = yesNo(
	"Is the deliverable of `task` a proposal or design that waits for the operator's choice, rather than carrying out a stated task?",
	"Asks for a plan, a design or options to review, or says not to start or change anything yet",
	"Asks to carry something out, including implementing an existing plan or writing a plan file as the work itself; or asks a question that needs only an answer",
);

const RECIPE_INSTRUCTIONS =
	"Which one worker agent would the assistant dispatch first for `task`? Pick the agent whose description matches the work that agent would carry out. When the request names an agent, pick that agent. Ignore what the assistant does itself with the results afterwards.";

/**
 * Short criteria for renderers with a declared per-option bound (Julia-1 reads
 * 48 tokens per option, and most full criteria here are longer). They are the
 * site's own wording under `TURN_COMPACT_VERSION`, which joins the threshold
 * identity of any build read through them; no Jev cut was measured on them and
 * none applies. Each option fits 46 UTF-8 bytes, so it provably fits the bound.
 */
const TURN_COMPACT_VERSION = "turn-compact-v2";
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
	architecture: yesNo(
		ARCHITECTURE_QUESTION.instructions,
		"Asks how components relate or flow",
		"Asks one fact, a listing, a change, or chat",
	),
	direction: yesNo(
		DIRECTION_QUESTION.instructions,
		"Asks what to do next or for options",
		"States, continues or approves a task",
	),
	proposal: yesNo(PROPOSAL_QUESTION.instructions, "A plan or design to review first", "Carry out work or answer"),
};

/** The task already says who should do the work, so a plan line would only repeat it. */
const NAMES_DELEGATION = /\b(?:dispatch\w*|agents?|workers?|scouts?|sub-?agents?|council)\b/i;

/** Recipes offered as options: unique, described, and never a key that rewrites a prototype. */
function offeredRecipes(recipes: ReadonlyArray<TurnRecipeOption> | undefined): Record<string, string> | null {
	const offered: Record<string, string> = {};
	for (const recipe of recipes ?? []) {
		const id = recipe.id.trim();
		if (id.length === 0 || id === "__proto__" || Object.hasOwn(offered, id)) continue;
		offered[id] = boundedHead(recipe.description, MAX_RECIPE_DESCRIPTION_CHARS) || id;
	}
	return Object.keys(offered).length >= 2 ? offered : null;
}

/**
 * The winning option when it holds at least `cut` of the mass, else null. A cut
 * on a choice is a probability of the chosen option, never a certainty, and one
 * nobody measured for this build reads as undecided.
 */
function choiceAtCut(
	answer: Answer | undefined,
	cut: number | undefined,
	allowed: ReadonlyArray<string>,
): string | null {
	if (cut === undefined || answer === undefined || answer.calibrated !== true) return null;
	const winner = chosen(answer, 0);
	if (winner === null || !allowed.includes(winner)) return null;
	const mass = answer.probabilities?.[winner];
	return mass !== undefined && Number.isFinite(mass) && mass >= cut ? winner : null;
}

function planHint(shape: TurnShape | null): string {
	const phrase = shape === null ? "" : `; ${SHAPE_PHRASES[shape]}`;
	// Naming the rule and its timing is what moved qwopus3.8-27b: with only the
	// first sentence it explored with 40 or more of its own calls in two of two
	// runs; with the second it sent four parallel scouts first in two of two.
	return `[Plan] This reads as work suited to workers${phrase}. Your delegation rules apply: dispatch before you read or edit, so your own context stays free. Whether and how to dispatch stays your call.`;
}

function policy(
	value: Pick<TurnValue, "direct" | "dispatch" | "architecture" | "direction" | "proposal" | "shape">,
	task: string,
	cuts: SiteCuts,
): Pick<TurnValue, "hints" | "acts"> {
	const cut = (key: string): number | undefined => (cuts.fitted ? cuts.cut(key) : undefined);
	const crosses = (p: number | null, at: number | undefined): boolean => at !== undefined && p !== null && p >= at;
	const dispatchConfident = crosses(value.dispatch, cut("dispatch"));
	return {
		hints: {
			scope: crosses(value.direct, cut("direct")) ? TURN_SCOPE_HINT : null,
			plan: dispatchConfident && !NAMES_DELEGATION.test(task) ? planHint(value.shape) : null,
			explore: crosses(value.architecture, cut("architecture")) ? TURN_EXPLORE_HINT : null,
		},
		acts: {
			direction: crosses(value.direction, cut("direction")),
			dispatch: dispatchConfident,
			prewarm: crosses(value.dispatch, cut("prewarm")),
			proposal: crosses(value.proposal, cut("proposal")),
		},
	};
}

export const TURN_SITE: SiteDefinition<TurnObject, TurnValue> = {
	id: "turn",
	version: "turn-v3",
	deadlineMs: 600,
	taskOf: () => "intent",
	cutTask: () => "intent",
	compact: { version: TURN_COMPACT_VERSION, questions: () => COMPACT },
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
	questions: () => ({
		direct: DIRECT_QUESTION,
		dispatch: DISPATCH_QUESTION,
		shape: SHAPE_QUESTION,
		architecture: ARCHITECTURE_QUESTION,
		direction: DIRECTION_QUESTION,
		proposal: PROPOSAL_QUESTION,
	}),
	read(answers, object, cuts) {
		// A profile may answer only part of the turn (a label model takes the
		// choices and not the yes/no questions). Any answered question is a value;
		// only a call that answered nothing is no value.
		if (!Object.values(answers).some((answer) => answer !== undefined)) return null;
		const value = {
			direct: probability(answers.direct),
			dispatch: probability(answers.dispatch),
			shape: choiceAtCut(
				answers.shape,
				cuts.fitted ? cuts.cut("shape") : undefined,
				Object.keys(TURN_SHAPES),
			) as TurnShape | null,
			architecture: probability(answers.architecture),
			direction: probability(answers.direction),
			proposal: probability(answers.proposal),
		};
		return { ...value, ...policy(value, object.task, cuts) };
	},
	summarize: (value) => ({
		direct: value.direct === null ? null : round2(value.direct),
		dispatch: value.dispatch === null ? null : round2(value.dispatch),
		shape: value.shape,
		architecture: value.architecture === null ? null : round2(value.architecture),
		direction: value.direction === null ? null : round2(value.direction),
		proposal: value.proposal === null ? null : round2(value.proposal),
		scopeHint: value.hints.scope !== null,
		planHint: value.hints.plan !== null,
		exploreHint: value.hints.explore !== null,
		actDirection: value.acts.direction,
		actPrewarm: value.acts.prewarm,
		actDispatch: value.acts.dispatch,
		actProposal: value.acts.proposal,
	}),
};

export interface WorkerPrepareObject {
	readonly task: string;
	readonly previous: string;
	readonly previousTask: string;
	readonly recipes: ReadonlyArray<TurnRecipeOption>;
}

/**
 * Which installed recipe a dispatch would name first, asked only after a turn
 * reading crosses `turn.prewarm`, so most turns spend no request here. Nothing
 * waits on it: the host holds a process when it lands, usually while the main
 * model is still generating. A wrong pick costs one idle process until settle.
 */
export const WORKER_PREPARE_SITE: SiteDefinition<WorkerPrepareObject, { readonly recipe: string | null }> = {
	id: "workerPrepare",
	version: "worker-prepare-v1",
	deadlineMs: 600,
	taskOf: () => "recipe",
	cutTask: () => "recipe",
	// No request is spent on a pick a build has no mass to act on.
	requiredCut: "recipe",
	state(object) {
		const task = boundedHead(object.task, MAX_TASK_CHARS);
		if (task.length === 0 || offeredRecipes(object.recipes) === null) return null;
		return {
			task,
			previous: boundedTail(withoutQuotedCode(object.previous), MAX_PREVIOUS_CHARS),
			previousTask: boundedHead(object.previousTask, MAX_PREVIOUS_TASK_CHARS),
		};
	},
	questions(object) {
		const offered = offeredRecipes(object.recipes);
		return offered === null ? {} : { recipe: pick(RECIPE_INSTRUCTIONS, offered) };
	},
	read(answers, object, cuts) {
		const offered = offeredRecipes(object.recipes);
		if (offered === null) return null;
		const recipe = choiceAtCut(answers.recipe, cuts.cut("recipe"), Object.keys(offered));
		return recipe === null ? null : { recipe };
	},
	summarize: (value) => ({ recipe: value.recipe }),
};
