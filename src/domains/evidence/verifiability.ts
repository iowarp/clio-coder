/**
 * Verifiability: whether a machine check can settle a step, or whether it is a
 * judgment call. A step a deterministic check settles (tests, compile, lint,
 * typecheck, a schema, a measured number, a rerun) runs closed-loop: do it,
 * run the check, act on the result. A judgment call has no such check, so it
 * goes to the operator, or under `yolo` (no operator in the loop) to a second
 * opinion from another model family (`/oracle`, see model-lineage.ts).
 *
 * Read from the step's text alone, by cue words. Judgment cues win over check
 * cues: "should we keep the parser, given its tests pass?" is a judgment the
 * tests inform but do not settle. Text with no cue at all is a judgment,
 * because nothing names a check that would settle it.
 *
 * Pure: no I/O.
 */

import type { AutonomyLevel } from "../safety/autonomy.js";

export type VerifiabilityKind = "executable" | "numeric" | "reproducible" | "judgment";

export interface Verifiability {
	kind: VerifiabilityKind;
	/** Check families the text names (`test`, `typecheck`, ...), in a stable order; on a judgment, the checks that inform it. */
	checks: string[];
	reason: string;
}

const CHECK_CUES: ReadonlyArray<readonly [string, RegExp]> = [
	["test", /\b(?:tests?|specs?|test suite|unit tests?|regression tests?|ci)\b|\b(?:passe?s?|fail(?:s|ing|ed)?)\b/iu],
	["typecheck", /\b(?:type ?checks?|typecheck(?:ing|s)?|type errors?|tsc|mypy|pyright)\b/iu],
	["build", /\b(?:compiles?|compil(?:ing|ation)|builds?)\b/iu],
	["lint", /\b(?:lint(?:s|er|ing)?|biome|eslint|ruff|clippy|formatt(?:ed|ing)|formatter)\b/iu],
	["schema", /\b(?:schemas?|validates?|validation|json ?schema|well[- ]formed)\b/iu],
];

const NUMERIC_CUE =
	/\b(?:benchmarks?|throughput|latency|speedup|faster|slower|within|tolerance|accuracy|error rate|regress(?:ion|es)? by|p\d{2}|bandwidth|iops|flops)\b|\d\s*(?:%|ms|s|x|gb\/s|mb\/s)\b/iu;
const REPRODUCIBLE_CUE = /\b(?:reproduc(?:e|es|ible|ibility)|re-?run|same (?:result|output|numbers)|deterministic)\b/iu;
const JUDGMENT_CUE =
	/\b(?:should (?:we|i|it)|better|worse|prefer(?:able|red)?|worth|trade-?offs?|design|architect(?:ure|ural)?|naming|readab(?:le|ility)|clean(?:er)?|elegant|idiomatic|ux|user experience|priorit(?:y|ize|ise)|which (?:one|option|approach)|makes? sense|reasonable|appropriate)\b/iu;

/** Whether a machine check can settle `text`, and which. */
export function classifyVerifiability(text: string): Verifiability {
	const checks = CHECK_CUES.filter(([, cue]) => cue.test(text)).map(([check]) => check);
	if (JUDGMENT_CUE.test(text)) {
		return {
			kind: "judgment",
			checks,
			reason:
				checks.length > 0
					? `a judgment call; ${checks.join(", ")} inform it but do not settle it`
					: "a judgment call; no check settles it",
		};
	}
	if (checks.length > 0) return { kind: "executable", checks, reason: `settled by ${checks.join(", ")}` };
	if (NUMERIC_CUE.test(text)) return { kind: "numeric", checks: ["measure"], reason: "settled by a measured number" };
	if (REPRODUCIBLE_CUE.test(text)) return { kind: "reproducible", checks: ["rerun"], reason: "settled by a rerun" };
	return { kind: "judgment", checks: [], reason: "names no check that would settle it" };
}

export type VerifiabilityRoute = "closed-loop" | "second-opinion" | "ask-operator";

/**
 * Where a step goes. Anything a check settles runs closed-loop at every
 * autonomy level. A judgment call goes to the operator by default; under
 * `yolo` the operator stepped out of the loop, so a second opinion from
 * another model family stands in.
 */
export function verifiabilityRoute(kind: VerifiabilityKind, autonomy: AutonomyLevel): VerifiabilityRoute {
	if (kind !== "judgment") return "closed-loop";
	return autonomy === "yolo" ? "second-opinion" : "ask-operator";
}
