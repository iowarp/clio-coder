/**
 * An advisory reading of how far a parked call reaches, for the approval card.
 *
 * This is operator signal and nothing else. It does not gate admission, does
 * not change what is permitted, and does not participate in the safety
 * decision that parked the call in the first place: by the time it is asked,
 * the classifier has already decided that this call needs a human. All it adds
 * is a sentence about blast radius next to the one the operator is about to
 * answer, so "allow" is a better informed keystroke.
 *
 * It is also strictly optional in time. The dialog opens the moment the call
 * parks, before this has been asked, and the line appears if and when an answer
 * arrives. An operator who decides in under a second simply never sees it, and
 * an outage means nobody ever waits on anything.
 */

import { type Decider, isTrue, rate, rating, yesNo } from "../providers/decisions.js";

/** Bumped when the ladder or the wording changes. */
export const TOOL_RISK_VERSION = "toolrisk-v2";

/**
 * The blast-radius ladder, lowest rung first.
 *
 * Rungs are written as what the call does to the world rather than as severity
 * words, because "medium risk" means nothing to an operator deciding about one
 * specific command and "changes state version control cannot restore" does.
 *
 * The top rung names changing remote state, not reaching a remote host. The v1
 * wording said "reaches another machine", and jev-latest followed it exactly:
 * a plain `curl` GET read as irreversible, so the card cried wolf on every
 * download. Against twelve commands spanning the four rungs, v1 agreed with the
 * intended rung on nine and abstained on `npm install`; v2 agreed on all twelve
 * in two consecutive live runs.
 */
const TOOL_RISK_RUNGS = [
	{
		label: "contained",
		criteria:
			"Only reads: lists, inspects, searches, or downloads for display, and changes nothing on this machine or any other.",
	},
	{
		label: "local",
		criteria:
			"Creates or changes files inside the workspace, including downloads and installed dependencies, in a way version control or a reinstall can restore.",
	},
	{
		label: "broad",
		criteria:
			"Changes state outside the workspace on this machine, or discards workspace history or uncommitted work that version control cannot bring back.",
	},
	{
		label: "irreversible",
		criteria:
			"Deletes data for good, or changes state on another machine or a published service: pushes, publishes, deploys, uploads, or remote writes and deletes.",
	},
] as const;

export const TOOL_RISK_LADDER = TOOL_RISK_RUNGS.map((rung) => rung.criteria);

/** How certain the model must be before the card says anything at all. */
const MIN_CERTAINTY = 0.25;

export interface ToolRiskSubject {
	readonly tool: string;
	readonly actionClass: string;
	/**
	 * The call's allowlisted, secret-redacted, sanitized one-line target, exactly
	 * as the card shows it. It is the only description of the call that gets
	 * sent, so the pass never sees raw arguments, mutation text or a transcript.
	 */
	readonly target: string;
}

export interface ToolRiskAdvisory {
	/** Position on the ladder, interpolated between rungs. */
	readonly score: number;
	/** The nearest rung's short name. */
	readonly label: string;
	/** Null when the model was undecided about reach, which is not a "no". */
	readonly reachesOutsideWorkspace: boolean | null;
	/** Target and model, so the operator knows who said it. */
	readonly source: string;
}

function questions() {
	return {
		radius: rate("How far does this call reach?", TOOL_RISK_LADDER),
		outside: yesNo(
			"Does this call change anything outside the workspace directory?",
			"Touches state outside the workspace",
			"Stays inside the workspace",
		),
	};
}

function rungLabel(score: number): string {
	const index = Math.min(TOOL_RISK_RUNGS.length - 1, Math.max(0, Math.round(score)));
	return (TOOL_RISK_RUNGS[index] as (typeof TOOL_RISK_RUNGS)[number]).label;
}

/**
 * The advisory sentence, or the empty string when there is nothing to say.
 *
 * The wording leads with what it is not, because an operator who reads a risk
 * rating on an approval card will otherwise reasonably assume the harness acted
 * on it. Nothing here changes what allow and deny do.
 */
export function toolRiskAdvisoryLine(advisory: ToolRiskAdvisory | null): string {
	if (advisory === null) return "";
	const reach =
		advisory.reachesOutsideWorkspace === true
			? " It reaches outside the workspace."
			: advisory.reachesOutsideWorkspace === false
				? " It stays inside the workspace."
				: "";
	return `Advisory only, nothing below is gated on it: blast radius reads as ${advisory.label}.${reach} Judged by ${advisory.source}.`;
}

/**
 * Ask the bound decider to rate one parked call.
 *
 * Returns null for every way this can fail to produce an opinion, because a
 * card with no advisory line is the card this surface has always shown. The
 * caller fires this without awaiting it and renders whatever comes back.
 */
export async function describeToolRisk(
	decider: Decider,
	subject: ToolRiskSubject,
	source: string,
	signal?: AbortSignal,
): Promise<ToolRiskAdvisory | null> {
	try {
		const answers = await decider.ask(
			{ tool: subject.tool, action: subject.actionClass, target: subject.target },
			questions(),
			{ ...(signal !== undefined ? { signal } : {}) },
		);
		const score = rating(answers.radius, { minConfidence: MIN_CERTAINTY });
		// An undecided rating has no rung to name, so the card stays as it was.
		// Reach is reported alongside it and may abstain on its own.
		if (score === null) return null;
		return {
			score,
			label: rungLabel(score),
			reachesOutsideWorkspace: isTrue(answers.outside, { minConfidence: MIN_CERTAINTY }),
			source,
		};
	} catch {
		return null;
	}
}
