/**
 * `turnScope`: can this turn be answered without touching the workspace?
 *
 * The main model tends to explore on conversational turns. Session ledgers
 * show "how are you? who are you? what can you do?" spending 40 tool calls and
 * a dispatch, and "list all skills" spending 21. A confident "answerable
 * directly" becomes one line in the submitted user message telling the model
 * so. Every tool stays attached and nothing is gated: narrowing the tool
 * surface instead would change the cached prefix on every tier, and the model
 * decides what to do with the line.
 *
 * `previous` is in the evidence because a short follow-up reads as
 * conversational without it. Measured live, "ok go ahead" after a proposal
 * scored 0.40 on the wording without it and 0.20 with it, while greetings and
 * general-knowledge questions held at 0.85 to 0.99.
 */

import { yesNo } from "../decisions.js";
import type { PreTurnSite } from "../pre-turn-brief.js";

/** Bumped when the wording changes. */
export const TURN_SCOPE_VERSION = "turnscope-v1";

/**
 * Probability at or above which the hint is given. Correct "direct" answers
 * measured 0.80 to 0.99, and the highest needs-the-workspace answer outside a
 * genuinely ambiguous prompt was 0.22. Missing a direct turn costs nothing; a
 * confident wrong hint is the expensive side, so the bar sits high.
 */
const HINT_THRESHOLD = 0.8;

export interface TurnScope {
	/** Probability that the turn needs nothing from the workspace. */
	readonly direct: number;
}

export const TURN_SCOPE_HINT =
	"[Scope] This reads as answerable without inspecting the workspace. Answer directly; use a tool only if a specific fact is missing.";

export const turnScopeSite: PreTurnSite<TurnScope> = {
	site: "turnScope",
	version: TURN_SCOPE_VERSION,
	prepare: () => ({
		uses: ["previous"],
		questions: {
			direct: yesNo(
				"Can the assistant fully answer `task` from general knowledge alone, without looking at any file, command output, setting or tool in this workspace, and without carrying out anything `previous` proposed?",
				"Answerable directly: a greeting, a thank-you, general programming knowledge, or an exact reply `task` dictates",
				"Needs a fact from this workspace, this machine, or this assistant's own configuration; asks for an action; or approves, continues or corrects work described in `previous`",
			),
		},
	}),
	read(answers) {
		const answer = answers.direct;
		// Recorded as the probability, including a confident "no": the ledger is
		// where the hint's precision gets measured, and a "no" is half of that.
		if (answer?.type !== "noul" || answer.noul === undefined || !Number.isFinite(answer.noul)) return null;
		return { direct: answer.noul };
	},
	hint: (value) => (value.direct >= HINT_THRESHOLD ? TURN_SCOPE_HINT : null),
	summarize: (value) => ({ direct: Math.round(value.direct * 100) / 100 }),
};
