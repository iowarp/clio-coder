/**
 * Certainty and the readers a site's policy uses.
 *
 * Engines disagree on what their own `confidence` means, so certainty is
 * always recomputed here from the mass. A reader returns null for a wrong type
 * or an abstention, and null means the caller does what it would with no
 * answer at all.
 */

import type { Answer, QuestionType } from "./types.js";

function finiteMass(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Peakedness in [0, 1]. A noul is a two-outcome distribution, where
 * `(n·max - 1)/(n - 1)` reduces to `|2p - 1|`, so a noul of 0.65 reads 0.30
 * exactly as a two-option choice at that mass would. Missing or malformed mass
 * reads 0, the value that abstains under any floor.
 */
export function certaintyFromMass(type: QuestionType, answer: Pick<Answer, "noul" | "probabilities">): number {
	if (type === "noul") {
		return answer.noul !== undefined && finiteMass(answer.noul) ? Math.abs(answer.noul * 2 - 1) : 0;
	}
	const masses = Object.values(answer.probabilities ?? {});
	if (masses.length === 0 || !masses.every(finiteMass)) return 0;
	// A single option is decided by construction.
	if (masses.length === 1) return 1;
	const peak = Math.max(...masses);
	return Math.max(0, Math.min(1, (masses.length * peak - 1) / (masses.length - 1)));
}

/**
 * A noul as a boolean at `cut` (default 0.5), or null when the answer is not a
 * noul. Whether the cut was fitted for the answering build is the site's
 * question to ask through `SiteCuts`, not this reader's.
 */
export function isTrue(answer: Answer | undefined, cut = 0.5): boolean | null {
	if (answer === undefined || answer.type !== "noul" || answer.noul === undefined) return null;
	return answer.noul >= cut;
}

/** The winning option, or null when the answer is not a choice or is less certain than `minCertainty`. */
export function chosen(answer: Answer | undefined, minCertainty?: number): string | null {
	if (answer === undefined || answer.type !== "choice" || answer.choice === undefined) return null;
	if (minCertainty !== undefined && answer.certainty < minCertainty) return null;
	return answer.choice;
}

/** The 0-indexed expected level, or null when the answer is not a score or is less certain than `minCertainty`. */
export function rating(answer: Answer | undefined, minCertainty?: number): number | null {
	if (answer === undefined || answer.type !== "score" || answer.score === undefined) return null;
	if (minCertainty !== undefined && answer.certainty < minCertainty) return null;
	return answer.score;
}
