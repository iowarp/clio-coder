/**
 * One call for any harness decision point that wants a System One answer.
 *
 * Every site used to repeat the same four steps: resolve the binding, ask,
 * drop answers below a confidence floor, and turn every failure into the
 * behavior the caller had before the site existed. `askSite` does all four,
 * so a new decision point is one call and a null check:
 *
 *   const reply = await askSite("toolRisk", input, state, { risk: rate(...) });
 *   if (reply === null) return previousBehavior();
 *
 * Null is the ordinary answer, not an error. It covers an unbound site, a
 * misconfigured one, a refused connection, a timeout, a malformed response,
 * and a reply in which every question abstained. A caller that gets null
 * must do exactly what it did before the site existed.
 */

import type { DecisionSite } from "../../core/defaults.js";
import { inspectDecisionSite, type ResolveDeciderInput } from "./decision-sites.js";
import { answerCertainty } from "./decisions.js";
import type { DecisionAnswer, DecisionQuestion } from "./types/inference.js";

/** The abstention band every site uses unless it asks for another. */
export const DEFAULT_SITE_MIN_CERTAINTY = 0.2;

export interface SiteAnswer {
	readonly answer: DecisionAnswer;
	/** How peaked the distribution is, on the 0..1 axis `answerCertainty` defines. */
	readonly certainty: number;
}

export interface SiteReply {
	/** Per question id: the answer, or null when it fell below the confidence floor. */
	readonly answers: Readonly<Record<string, SiteAnswer | null>>;
	/** The model build the provider reports, e.g. `jev-1.13.0` for `jev-latest`. */
	readonly model: string;
	/** Target and configured model, which is what an operator bound. */
	readonly source: string;
	readonly latencyMs: number;
}

export interface AskSiteOptions {
	/** Answers below this certainty read as abstentions. Defaults to 0.2. */
	readonly minConfidence?: number;
	readonly signal?: AbortSignal;
}

/** Ask a bound site, or return null for every reason the caller should behave as before. */
export async function askSite(
	site: DecisionSite,
	input: ResolveDeciderInput,
	state: string | object,
	questions: Readonly<Record<string, DecisionQuestion>>,
	options: AskSiteOptions = {},
): Promise<SiteReply | null> {
	try {
		const ids = Object.keys(questions);
		if (ids.length === 0) return null;
		const status = inspectDecisionSite(site, input);
		if (!status.bound) return null;
		const floor = options.minConfidence ?? DEFAULT_SITE_MIN_CERTAINTY;
		const startedAt = performance.now();
		const result = await status.decider.askDetailed(
			state,
			{ ...questions },
			{
				...(options.signal !== undefined ? { signal: options.signal } : {}),
			},
		);
		const latencyMs = Math.round(performance.now() - startedAt);
		const answers: Record<string, SiteAnswer | null> = {};
		let answered = 0;
		for (const id of ids) {
			const answer = result.answers[id];
			const certainty = answer === undefined ? 0 : answerCertainty(answer);
			if (answer === undefined || certainty < floor) {
				answers[id] = null;
				continue;
			}
			answers[id] = { answer, certainty };
			answered += 1;
		}
		if (answered === 0) return null;
		return {
			answers,
			model: result.model,
			source: `${status.targetId}/${status.model ?? "default"}`,
			latencyMs,
		};
	} catch {
		return null;
	}
}
