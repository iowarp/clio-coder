/**
 * `capabilities`: which gateway capabilities fit what the model is looking for?
 *
 * MCP servers and extensions sit behind the gateway rather than in the
 * attached tool schemas, and `gateway(op="find")` filters them with one
 * substring over name and description. A paraphrase misses: "create pull
 * request" is not a substring of "Create a pull request". This site ranks the
 * catalog by meaning instead, and the gateway uses the scores only to reorder
 * a long listing or to add a few related entries beside a query's own hits. It
 * never removes an entry and never reorders the entries a query matched.
 *
 * A mid-turn site: the gateway's find handler is async, so it asks here when
 * it needs to rather than paying on every turn for a find that may never run.
 * Questions are independent, and a batch of 256 answered in 356 to 367ms
 * against jev-latest, so the catalog is scored in one call.
 */

import type { ResolveDeciderInput } from "../decision-sites.js";
import { inspectDecisionSite } from "../decision-sites.js";
import { isTrue, yesNo } from "../decisions.js";
import type { DecisionQuestion } from "../types/inference.js";

/** Entries scored in one call. Latency held flat to this size; beyond it the tail keeps its place. */
const MAX_ENTRIES = 256;
/** Code points of one description; the gateway already cuts to the first sentence. */
const MAX_DESCRIPTION_CHARS = 240;
/** Code points of the query and of the turn's task. */
const MAX_NEED_CHARS = 600;
/** The same abstention band the relevance pass uses. */
const MIN_CERTAINTY = 0.2;

export interface CapabilityEntry {
	readonly name: string;
	readonly description: string;
}

export interface CapabilityNeed {
	/** What the model asked find for, or empty for an unfiltered listing. */
	readonly query: string;
	/** What the turn was asked to do, or empty when unknown. */
	readonly task: string;
}

export interface CapabilityRanking {
	/** Capability name to probability of fitting. Absent means undecided. */
	readonly scores: Readonly<Record<string, number>>;
	/** Target and model, so the listing can say who ranked it. */
	readonly source: string;
}

function bounded(value: string, maxCodePoints: number): string {
	const points = [...value.replace(/\s+/g, " ").trim()];
	return points.length <= maxCodePoints ? points.join("") : `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

/**
 * Score entries against a need, or null when the site is unbound, there is
 * nothing to rank, or the model gave no usable answer. Never throws.
 */
export async function rankCapabilities(
	input: ResolveDeciderInput,
	need: CapabilityNeed,
	entries: ReadonlyArray<CapabilityEntry>,
	signal?: AbortSignal,
): Promise<CapabilityRanking | null> {
	try {
		const status = inspectDecisionSite("capabilities", input);
		if (!status.bound) return null;
		const subjects = entries.slice(0, MAX_ENTRIES);
		const query = bounded(need.query, MAX_NEED_CHARS);
		const task = bounded(need.task, MAX_NEED_CHARS);
		if (subjects.length === 0 || (query.length === 0 && task.length === 0)) return null;
		const capabilities: Record<string, string> = {};
		const questions: Record<string, DecisionQuestion> = {};
		for (const entry of subjects) {
			capabilities[entry.name] = bounded(entry.description, MAX_DESCRIPTION_CHARS);
			questions[entry.name] = yesNo(
				`Does capability ${entry.name} serve the need described in state.need?`,
				"Directly serves that need",
				"Unrelated to that need, or useful only by coincidence",
			);
		}
		// The query is what the model is looking for right now; the task is why.
		// With no query the task is the need, which is what an unfiltered listing
		// is for.
		const state = query.length > 0 ? { need: query, task, capabilities } : { need: task, capabilities };
		const answers = await status.decider.ask(state, questions, signal === undefined ? {} : { signal });
		const scores: Record<string, number> = {};
		for (const entry of subjects) {
			const answer = answers[entry.name];
			if (answer?.noul === undefined || isTrue(answer, { minConfidence: MIN_CERTAINTY }) === null) continue;
			scores[entry.name] = answer.noul;
		}
		if (Object.keys(scores).length === 0) return null;
		return { scores, source: `${status.targetId}/${status.model ?? "default"}` };
	} catch {
		// Unbound, refused, malformed or slow all mean the listing the gateway
		// already had.
		return null;
	}
}
