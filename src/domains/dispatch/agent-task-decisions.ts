/**
 * Calibrated task features for the `routing` decision site.
 *
 * `classifyAgentTask` reads the task with an ordered regex list and reports a
 * confidence of 0.3 or 0.7 depending only on whether its first rule matched.
 * That number is a placeholder, not a measurement, and the rules miss whenever
 * the task's wording differs from the pattern: "Review the auth middleware for
 * timing attacks, then fix anything you find and add regression tests" is
 * sixteen words with no enumerated list, so the word-count ladder calls it
 * `simple` and the conjunction rule calls it indivisible. It is neither.
 *
 * A System One model answers the same four questions against the task text and
 * returns a distribution over each, so the confidence that reaches routing is
 * the model's own rather than a constant. Every field falls back to the regex
 * value independently: an abstention on complexity must not discard a
 * confident answer on domain, and a provider outage must leave routing exactly
 * as it was before the site existed.
 *
 * The task text is the evidence, so it goes in the state. It does not enter the
 * recorded decision: what comes back is the same bounded `AgentTaskFeatures`
 * the regex produces, which is what route history keeps.
 */

import type { Decider } from "../providers/decisions.js";
import { chosen, isTrue, pick, rate, rating, yesNo } from "../providers/decisions.js";

import {
	type AgentTaskComplexity,
	type AgentTaskDomain,
	type AgentTaskFeatures,
	type AgentTaskType,
	classifyAgentTask,
} from "./agent-candidates.js";

/**
 * Rungs in the order the ladder reports them, so index 0 is the lightest. The
 * model answers a position between rungs, which is more information than the
 * enum can hold; rounding to the nearest is the lossy step and it happens here
 * rather than being hidden inside the question.
 */
const COMPLEXITY_LADDER: ReadonlyArray<AgentTaskComplexity> = ["trivial", "simple", "moderate", "complex"];

const COMPLEXITY_CRITERIA: ReadonlyArray<string> = [
	"A single obvious edit",
	"A contained change in one place",
	"A change spanning several places",
	"A large change needing its own plan",
];

const TASK_TYPE_CRITERIA: Readonly<Record<Exclude<AgentTaskType, "unknown">, string>> = {
	code_write: "Write new code",
	code_read: "Read or explain code",
	code_review: "Review or audit existing code",
	debug: "Diagnose or fix a defect",
	refactor: "Restructure code without changing behavior",
	test: "Write or fix tests",
	docs: "Write documentation",
	config: "Change configuration or setup",
	research: "Investigate something outside the codebase",
	world_knowledge: "Answer from general knowledge",
};

const DOMAIN_CRITERIA: Readonly<Record<AgentTaskDomain, string>> = {
	frontend: "UI and client code",
	backend: "Server and application logic",
	infra: "Build, deploy, and operations",
	data: "Storage, schemas, and pipelines",
	security: "Auth, secrets, and vulnerabilities",
	general: "Not specific to one area",
};

/**
 * Minimum certainty before an answer displaces the regex value. Routing picks
 * which worker runs, and a worker that is wrong costs a whole run, so an
 * uncertain answer is worth less than the deterministic rule it would replace.
 * Below this the field abstains and the regex value stands.
 */
const ROUTING_MIN_CONFIDENCE = 0.5;

export interface ClassifyWithDeciderOptions {
	minConfidence?: number;
	signal?: AbortSignal;
	/** Reports a provider failure without deciding what to do about it. */
	onError?: (error: unknown) => void;
}

/** Bound the evidence so an oversized task cannot inflate the decision call. */
const MAX_TASK_CHARS = 4000;

/**
 * Task features with every field the model answered confidently, and the regex
 * value everywhere else.
 *
 * A null decider means the site is unbound, which is the ordinary case until an
 * operator binds it. Then this is exactly `classifyAgentTask`.
 */
export async function classifyAgentTaskWithDecider(
	task: string,
	decider: Decider | null,
	options: ClassifyWithDeciderOptions = {},
): Promise<AgentTaskFeatures> {
	const fallback = classifyAgentTask(task);
	if (!decider) return fallback;

	const minConfidence = options.minConfidence ?? ROUTING_MIN_CONFIDENCE;
	let answers: Awaited<ReturnType<Decider["ask"]>>;
	try {
		answers = await decider.ask(
			{ task: task.trim().slice(0, MAX_TASK_CHARS) },
			{
				taskType: pick("What kind of work does `task` primarily ask for?", TASK_TYPE_CRITERIA),
				domain: pick("Which area of the system does `task` touch?", DOMAIN_CRITERIA),
				complexity: rate("How much work does `task` require?", COMPLEXITY_CRITERIA),
				decomposable: yesNo(
					"Does `task` contain more than one independently completable piece of work?",
					"It names several separable pieces",
					"It is one piece of work",
				),
			},
			options.signal === undefined ? {} : { signal: options.signal },
		);
	} catch (error) {
		// Routing already had an answer before this site existed. A provider
		// outage returns it rather than failing the dispatch.
		options.onError?.(error);
		return fallback;
	}

	const taskType = chosen(answers.taskType, { minConfidence });
	const domain = chosen(answers.domain, { minConfidence });
	const complexity = rating(answers.complexity, { minConfidence });
	const decomposable = isTrue(answers.decomposable, { minConfidence });

	// The model is constrained to the option keys it was given, so an unknown
	// value here means the answer was not the shape it claimed. Treat it as an
	// abstention rather than widening the enum.
	const resolvedType = taskType !== null && taskType in TASK_TYPE_CRITERIA ? (taskType as AgentTaskType) : null;
	const resolvedDomain = domain !== null && domain in DOMAIN_CRITERIA ? (domain as AgentTaskDomain) : null;
	const resolvedComplexity = complexity === null ? null : (COMPLEXITY_LADDER[clampLadderIndex(complexity)] ?? null);

	return {
		taskType: resolvedType ?? fallback.taskType,
		complexity: resolvedComplexity ?? fallback.complexity,
		domain: resolvedDomain ?? fallback.domain,
		decomposable: decomposable ?? fallback.decomposable,
		// Subtasks are a count, and none of the three primitives returns one. It
		// stays with the regex, which at least derives it from enumeration in the
		// text, except that a confident "one piece of work" collapses it to 1.
		estimatedSubtasks: decomposable === false ? 1 : fallback.estimatedSubtasks,
		// The measured certainty on the field routing keys off, replacing the
		// constant the regex reports.
		confidence: resolvedType === null ? fallback.confidence : certaintyOf(answers.taskType?.confidence, fallback),
	};
}

function clampLadderIndex(score: number): number {
	if (!Number.isFinite(score)) return 0;
	return Math.min(COMPLEXITY_LADDER.length - 1, Math.max(0, Math.round(score)));
}

function certaintyOf(confidence: number | undefined, fallback: AgentTaskFeatures): number {
	return confidence === undefined ? fallback.confidence : confidence;
}
