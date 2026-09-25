/**
 * `/draft [N] <request>`: several candidate answers side by side, one judgment.
 *
 * A diffusion model answers a request in about a second, which makes asking it
 * several times cheaper than asking a frontier model once. That only helps if
 * something can say which answer to read first. A System One model does exactly
 * that: one `choice` over the candidates returns a calibrated distribution, so
 * the overlay can show how decisive the pick was rather than only which one won.
 *
 * Nothing here enters the session. The rounds read the compiled history the
 * next turn would send, like `/btw`, and the judge reads only the request and
 * the candidate texts. Closing the overlay ends the exchange.
 */

import { type Decider, isTrue, pick, yesNo } from "../domains/providers/decisions.js";
import type { DecisionAnswer, DecisionQuestion } from "../domains/providers/types/inference.js";

export const DRAFT_MIN = 2;
export const DRAFT_MAX = 4;
export const DRAFT_DEFAULT = 3;

/** Candidate names, in the order the rounds were started. */
export const DRAFT_LABELS = ["A", "B", "C", "D"] as const;
export type DraftLabel = (typeof DRAFT_LABELS)[number];

/**
 * One temperature per candidate. The same request at the same temperature
 * gives a diffusion model little reason to answer differently, and a judge
 * picking between near-copies is a judgment about nothing. The first draft
 * stays close to the model's default answer; the rest move away from it.
 */
export const DRAFT_TEMPERATURES = [0.3, 0.7, 1.0, 1.2] as const;

/** Sonnet 5 rejects explicit sampling temperature with HTTP 400. */
export function draftTemperature(modelId: string, temperature: number): number | undefined {
	return modelId === "claude-sonnet-5" ? undefined : temperature;
}

export const DRAFT_SYSTEM_PROMPT = [
	"You are drafting one candidate answer to the operator's request in a coding session.",
	"The conversation above is read-only context. Write one complete answer to the request and nothing else.",
	"Do not call tools, do not propose edits to the session, and do not describe alternatives you did not write.",
].join(" ");

/** Output budget per candidate. A draft is an answer to compare, not a document. */
export const DRAFT_MAX_TOKENS = 4096;

/** Bumped when the judge's wording changes. */
export const DRAFT_JUDGE_VERSION = "drafts-v1";

/** Code points of the request and of one candidate sent to the judge. */
const MAX_REQUEST_CHARS = 1500;
const MAX_CANDIDATE_CHARS = 6000;

/**
 * Soundness is advisory beside the pick, and an undecided reading has no
 * business being shown as one. The same floor the relevance pass uses.
 */
const MIN_CERTAINTY = 0.2;

export interface DraftRequest {
	count: number;
	request: string;
}

/**
 * Read `/draft` arguments. A leading integer is the candidate count; anything
 * else is the request. Out-of-range counts are refused rather than clamped, so
 * `/draft 9 ...` does not silently spend four rounds on a request that asked
 * for nine.
 */
export function parseDraftArgs(rest: string): DraftRequest | { error: string } {
	const trimmed = rest.trim();
	const match = /^(\d+)\s+([\s\S]+)$/u.exec(trimmed);
	if (match) {
		const count = Number(match[1]);
		const request = (match[2] ?? "").trim();
		if (count < DRAFT_MIN || count > DRAFT_MAX) {
			return { error: `draft count must be ${DRAFT_MIN} to ${DRAFT_MAX}, got ${count}` };
		}
		if (request.length === 0) return { error: "a draft needs a request" };
		return { count, request };
	}
	if (trimmed.length === 0) return { error: "a draft needs a request" };
	return { count: DRAFT_DEFAULT, request: trimmed };
}

function bounded(value: string, maxCodePoints: number): string {
	const points = [...value.trim()];
	return points.length <= maxCodePoints ? points.join("") : `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

/**
 * The judge's state and questions. Each candidate's text is carried once in
 * state and named by label from the questions, so the request grows with the
 * candidates rather than with candidates times questions.
 */
export function draftJudgeRequest(
	request: string,
	candidates: ReadonlyArray<string>,
): { state: object; questions: Record<string, DecisionQuestion> } {
	const labels = DRAFT_LABELS.slice(0, candidates.length);
	const texts: Record<string, string> = {};
	const options: Record<string, string> = {};
	const questions: Record<string, DecisionQuestion> = {};
	labels.forEach((label, index) => {
		texts[label] = bounded(candidates[index] ?? "", MAX_CANDIDATE_CHARS);
		options[label] = `Candidate ${label} in state.candidates`;
		questions[`sound.${label}`] = yesNo(
			`Is candidate ${label} a correct and complete answer to state.request?`,
			"Correct, complete, and directly answers the request",
			"Wrong, incomplete, or answers something else",
		);
	});
	questions.best = pick("Which candidate best answers state.request?", options);
	return { state: { request: bounded(request, MAX_REQUEST_CHARS), candidates: texts }, questions };
}

export interface DraftVerdict {
	/** The winning label, or null when the judge's pick was not one of the candidates. */
	picked: DraftLabel | null;
	/** Probability mass per candidate from the `choice`; sums to about 1. */
	probabilities: Partial<Record<DraftLabel, number>>;
	/** Whether each candidate reads as correct and complete; null where the judge was undecided. */
	sound: Partial<Record<DraftLabel, boolean | null>>;
	/** Target and model, so the operator knows who judged. */
	source: string;
	elapsedMs: number;
}

/** Read the judge's answers. Pure so the reading is testable against recorded answers. */
export function readDraftVerdict(
	answers: Record<string, DecisionAnswer>,
	count: number,
	source: string,
	elapsedMs: number,
): DraftVerdict {
	const labels = DRAFT_LABELS.slice(0, count);
	const best = answers.best;
	const probabilities: Partial<Record<DraftLabel, number>> = {};
	const sound: Partial<Record<DraftLabel, boolean | null>> = {};
	for (const label of labels) {
		const mass = best?.probabilities?.[label];
		probabilities[label] = typeof mass === "number" && Number.isFinite(mass) ? mass : 0;
		sound[label] = isTrue(answers[`sound.${label}`], { minConfidence: MIN_CERTAINTY });
	}
	const choice = best?.type === "choice" ? best.choice : undefined;
	const picked = labels.find((label) => label === choice) ?? null;
	return { picked, probabilities, sound, source, elapsedMs };
}

/**
 * Ask the judge. Null for every way this can fail to produce an opinion: the
 * candidates are still worth reading without one, and the overlay says why the
 * bars are missing rather than failing the whole draft.
 */
export async function judgeDrafts(
	decider: Decider,
	request: string,
	candidates: ReadonlyArray<string>,
	source: string,
	signal?: AbortSignal,
	now: () => number = () => performance.now(),
): Promise<DraftVerdict | null> {
	if (candidates.length < DRAFT_MIN) return null;
	const started = now();
	try {
		const { state, questions } = draftJudgeRequest(request, candidates);
		const answers = await decider.ask(state, questions, signal ? { signal } : {});
		return readDraftVerdict(answers, candidates.length, source, Math.round(now() - started));
	} catch {
		return null;
	}
}
