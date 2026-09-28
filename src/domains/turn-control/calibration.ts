import { DIRECTION_REQUESTED_THRESHOLD, ORIENTATION_WANTED_THRESHOLD } from "./decide.js";
import type { TurnInterpretation } from "./interpretation.js";

/** The probabilities above which a producer's `wanted` and `requested` mean yes. */
export interface TurnControlCuts {
	readonly orientation: number;
	readonly direction: number;
}

/**
 * Cuts fitted per answering build. A threshold is a property of the model that
 * produced the probabilities, not of the question: the 0.7 in `decide()` was
 * placed from one build's answers on `turn-control.json` and means nothing for
 * another build, another vendor, or a chat model reporting its own numbers.
 * TypeSafe's own guidance is to pin the version a threshold was tuned on.
 */
const TURN_CONTROL_CALIBRATION: Readonly<Record<string, TurnControlCuts>> = {
	// S5 follow-up: 29 labeled cases on jev-latest, which resolved to
	// jev-1.13.0. Orientation positives 0.77 to 0.98, negatives at most 0.26;
	// direction positives 0.74 to 0.95, negatives at most 0.43.
	"jev-1.13.0": { orientation: ORIENTATION_WANTED_THRESHOLD, direction: DIRECTION_REQUESTED_THRESHOLD },
};

export type TurnControlCutOverrides = Readonly<Record<string, Partial<TurnControlCuts>>>;

interface BuildCuts {
	readonly orientation: number | null;
	readonly direction: number | null;
}

/**
 * The build's cut per workflow, or null for a workflow nobody fitted. A fitted
 * build has both; an override may cover one workflow of an unfitted build, and
 * the other then stays inactive rather than borrowing the controller's 0.7.
 */
function cutsFor(build: string | null, overrides: TurnControlCutOverrides | undefined): BuildCuts | null {
	if (build === null) return null;
	const override = Object.hasOwn(overrides ?? {}, build) ? overrides?.[build] : undefined;
	const fitted = Object.hasOwn(TURN_CONTROL_CALIBRATION, build) ? TURN_CONTROL_CALIBRATION[build] : undefined;
	const cuts = {
		orientation: override?.orientation ?? fitted?.orientation ?? null,
		direction: override?.direction ?? fitted?.direction ?? null,
	};
	return cuts.orientation === null && cuts.direction === null ? null : cuts;
}

/**
 * Move `p` so that the producer's cut lands on the controller's. Monotone and
 * fixed at 0 and 1, so order and extremes survive; only which side of the
 * controller's threshold a value falls on is the producer's own.
 */
function rescale(p: number, cut: number, canonical: number): number {
	if (cut === canonical) return p;
	return p < cut ? (canonical * p) / cut : canonical + ((1 - canonical) * (p - cut)) / (1 - cut);
}

/**
 * The interpretation on the controller's scale, or null when its build has no
 * fitted cuts. Null is shadow mode: the answer is still on the ledger (the
 * brief summary and the raw decision call), and the controller does what it
 * does with no interpretation, which is nothing. Applied at the producer
 * boundary so the controller never learns which producer answered (D-004).
 */
export function calibrateInterpretation(
	interpretation: TurnInterpretation,
	build: string | null,
	overrides?: TurnControlCutOverrides,
): TurnInterpretation | null {
	const cuts = cutsFor(build, overrides);
	if (cuts === null) return null;
	return {
		...interpretation,
		orientation: {
			...interpretation.orientation,
			wanted:
				cuts.orientation === null
					? 0
					: rescale(interpretation.orientation.wanted, cuts.orientation, ORIENTATION_WANTED_THRESHOLD),
		},
		direction: {
			requested:
				cuts.direction === null
					? 0
					: rescale(interpretation.direction.requested, cuts.direction, DIRECTION_REQUESTED_THRESHOLD),
		},
	};
}
