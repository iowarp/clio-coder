/**
 * `drafts`: which of several candidate answers to read first.
 *
 * A diffusion model answers a request in about a second, which makes asking it
 * several times cheaper than asking a frontier model once. That only helps if
 * something can say which answer to read first. One `choice` over the
 * candidates returns a calibrated distribution, so the overlay can show how
 * decisive the pick was rather than only which one won.
 *
 * Nothing here enters the session. The judge reads only the request and the
 * candidate texts. It has no cut: soundness is advisory beside the pick, and an
 * undecided reading is shown as undecided.
 */

import { isTrue } from "../answers.js";
import { pick, yesNo } from "../questions.js";
import type { Question, SiteDefinition } from "../types.js";
import { boundedHead } from "./bounds.js";

export const DRAFT_MIN = 2;
/** Candidate names, in the order the rounds were started. */
export const DRAFT_LABELS = ["A", "B", "C", "D"] as const;
export type DraftLabel = (typeof DRAFT_LABELS)[number];

/** Code points of the request and of one candidate sent to the judge. */
const MAX_REQUEST_CHARS = 1500;
const MAX_CANDIDATE_CHARS = 6000;
/** Soundness is advisory, and an undecided reading has no business being shown as one. */
const MIN_CERTAINTY = 0.2;

export interface DraftsObject {
	readonly request: string;
	/** Candidate texts in label order. */
	readonly candidates: ReadonlyArray<string>;
}

export interface DraftsValue {
	/** The winning label, or null when the judge's pick was not one of the candidates. */
	readonly picked: DraftLabel | null;
	/** Probability mass per candidate from the `choice`; sums to about 1. */
	readonly probabilities: Readonly<Partial<Record<DraftLabel, number>>>;
	/** Whether each candidate reads as correct and complete; null where the judge was undecided. */
	readonly sound: Readonly<Partial<Record<DraftLabel, boolean | null>>>;
}

function labelsFor(object: DraftsObject): ReadonlyArray<DraftLabel> {
	return DRAFT_LABELS.slice(0, object.candidates.length);
}

export const DRAFTS_SITE: SiteDefinition<DraftsObject, DraftsValue> = {
	id: "drafts",
	version: "drafts-v1",
	deadlineMs: 5000,
	// Each candidate's text is carried once in state and named by label from the
	// questions, so the request grows with the candidates rather than with
	// candidates times questions.
	state(object) {
		if (object.candidates.length < DRAFT_MIN) return null;
		const candidates: Record<string, string> = {};
		for (const [index, label] of labelsFor(object).entries()) {
			candidates[label] = boundedHead(object.candidates[index] ?? "", MAX_CANDIDATE_CHARS);
		}
		return { request: boundedHead(object.request, MAX_REQUEST_CHARS), candidates };
	},
	questions(object) {
		const options: Record<string, string> = {};
		const questions: Record<string, Question> = {};
		for (const label of labelsFor(object)) {
			options[label] = `Candidate ${label} in state.candidates`;
			questions[`sound.${label}`] = yesNo(
				`Is candidate ${label} a correct and complete answer to state.request?`,
				"Correct, complete, and directly answers the request",
				"Wrong, incomplete, or answers something else",
			);
		}
		questions.best = pick("Which candidate best answers state.request?", options);
		return questions;
	},
	read(answers, object) {
		const best = answers.best;
		// The soundness answers alone would draw a judged row of empty bars.
		if (best === undefined || best.type !== "choice") return null;
		const probabilities: Partial<Record<DraftLabel, number>> = {};
		const sound: Partial<Record<DraftLabel, boolean | null>> = {};
		for (const label of labelsFor(object)) {
			const mass = best.probabilities?.[label];
			probabilities[label] = typeof mass === "number" && Number.isFinite(mass) ? mass : 0;
			const verdict = answers[`sound.${label}`];
			sound[label] = verdict !== undefined && verdict.certainty >= MIN_CERTAINTY ? isTrue(verdict) : null;
		}
		const picked = labelsFor(object).find((label) => label === best.choice) ?? null;
		return { picked, probabilities, sound };
	},
	summarize: (value) => ({
		picked: value.picked,
		soundCount: Object.values(value.sound).filter((verdict) => verdict === true).length,
	}),
};
