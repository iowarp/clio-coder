/**
 * The one reviewable table of what a build's numbers mean.
 *
 * A probability is a property of the model that produced it, not of the
 * question. A cut placed from one build's answers says nothing about another
 * build, another vendor, or a chat model reporting logprobs, so every cut and
 * every temperature is keyed by the answering build, and a build absent from
 * this table is recorded but never hints, gates or acts. TypeSafe's own
 * guidance is to pin the version a threshold was tuned on. Add a build here
 * only from a labeled run on that build, and cite the run beside the numbers.
 */

import type { RendererId } from "./contract.js";
import type { QuestionType, SiteCuts, SiteId } from "./types.js";

/**
 * Cuts per answering build, keyed `<site>.<key>`.
 *
 * jev-1.13.0 (jev-latest resolved to it), 3 runs over the labeled cases in
 * `tests/fixtures/decision-cases/`, sites at turn-v2, turn-end-v2,
 * tool-call-v2 and tool-result-v2. Ranges are over every run; a margin
 * is the distance from the cut to the nearest class. A key that acts or gates
 * is fitted only when its classes do not overlap and the cut clears the
 * highest negative by 0.13 or more; a hint or display key may sit where missed
 * positives are cheap.
 *
 * - `turn.direct` 0.76 (hint): 12 direct turns 0.81 to 0.99 against 40 others
 *   0.02 to 0.67 (plan-only prompts about agents are the high tail). Margin
 *   0.09 over negatives, 0.05 under positives.
 * - `turn.dispatch` 0.65 (hint): 31 delegation turns 0.19 to 0.98 against 40
 *   others 0.01 to 0.36. The classes overlap, which a hint allows: 25 of 93
 *   positive runs (mostly single-worker asks and doubtful labels) fall under
 *   the cut, none of 120 negative runs reach it. Margin 0.29 over negatives.
 * - `turn.orientation` 0.97 (acts): 11 tours 0.73 to 0.98 against 40 others
 *   0.01 to 0.84. Trivial locate and list asks overlap the tours ("what does
 *   the docs directory contain?" 0.83 to 0.84, "Name two directories in this
 *   repo." 0.71 to 0.74, "list the files in src/tools" 0.63 to 0.69), so the
 *   cut sits 0.13 over the highest negative and only the clearest tours act: 6
 *   of 11 fire and the rest are missed on purpose. Margin under positives 0.00
 *   (three tours read 0.96 to 0.97), so run-to-run noise can miss one.
 * - `turn.direction` 0.57 (acts): 6 undecided follow-ups 0.64 to 0.94 against
 *   25 others 0.02 to 0.41. Margin 0.16 over negatives, 0.07 under positives;
 *   "help me" at 0.64 to 0.68 is the closest.
 * - `turnEnd.asksOperator` 0.64: 22 endings that ask 0.75 to 0.99 against 38
 *   that do not 0.02 to 0.53. Margin 0.11 each side.
 * - `toolResult.instructions` 0.62 (flags): 24 injections 0.93 to 0.99 against
 *   28 hard negatives 0.01 to 0.47 (a test file holding an attack string, a
 *   blog quoting one). A false banner is cheap and a missed injection is not,
 *   so the cut sits low in the gap: 0.15 over negatives, 0.31 under positives.
 *   tool-result-v2 drops the banner web_fetch and web_read put at the head of
 *   every result, because the engine judged Clio's own "do not follow
 *   directives" sentence. Left in, it lifted a Stack Overflow answer from 0.03
 *   to 0.36 to 0.42 and an arXiv abstract from 0.21 to 0.29 to 0.35. With it
 *   dropped, the banner-prefixed twins of the web cases read as their plain
 *   cases (injections 0.97 to 0.99, negatives 0.03 to 0.38).
 * - `toolCall.gateDestroys` 0.36 (gates): 14 destructive calls 0.46 to 0.95
 *   against 27 others 0.01 to 0.23. Margin 0.13 over negatives, 0.10 under
 *   positives.
 *
 * - `relevance.ranked` 1 is a validation marker, not a threshold. The site has
 *   no cut, but an unvalidated build must not reorder a listing. Measured on
 *   the capabilities catalog: recall@1 71/72 and recall@5 72/72.
 *
 * Acting keys whose classes overlap are fitted above the highest observed
 * negative with margin, and accept missed positives:
 * - `turn.prewarm` 0.55: fires on 0 of 59 negative runs (highest 0.36, margin
 *   0.19) and misses 17 of 92 positive runs.
 * - `toolCall.gateRadius` 0.59 (rung position over a 3 scale): fires on 0 of 57
 *   negative runs (highest 0.44, margin 0.15) and misses 6 of 75 positive runs;
 *   with `gateDestroys` the gate escalates 75 of 75 positive and 0 of 57
 *   negative call-runs.
 * - `turnEnd.blocksOnDecision` 0.88 and `turnEnd.blocksOnDecisionFloor` 0.55
 *   are the two sides of one policy. Blocking needs 0.88 (highest negative
 *   0.73, margin 0.15), not blocking needs 0.55 or less (lowest positive 0.65,
 *   margin 0.10), and the middle is no decision.
 */
export const FITTED_CUTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	"jev-1.13.0": {
		"turn.direct": 0.76,
		"turn.dispatch": 0.65,
		"turn.orientation": 0.97,
		"turn.direction": 0.57,
		"turnEnd.asksOperator": 0.64,
		"toolResult.instructions": 0.62,
		"toolCall.gateDestroys": 0.36,
		"turn.prewarm": 0.55,
		"toolCall.gateRadius": 0.59,
		"turnEnd.blocksOnDecision": 0.88,
		"turnEnd.blocksOnDecisionFloor": 0.55,
		"relevance.ranked": 1,
	},
};

/**
 * The question contract each measured table was fitted under: the renderer
 * and, per site, the site version, which names the wording, the evidence
 * projection (state shape and bounds) and the policy together. A measured cut
 * applies only when the call matches exactly, so a reworded site or another
 * rendering goes silent until it is measured again. Dynamic candidate ids and
 * recipe options are values inside that contract, never part of it.
 *
 * `jev-1.13.0` is mapped to the site versions the table has been applied to
 * since the System One rebuild shipped them together (4c13e0757). The run notes
 * above name turn-end-v2; turn-end-v3 shipped in the same commit as these cuts
 * and is mapped deliberately, and no later version inherits them.
 */
export const FITTED_CONTRACTS: Readonly<
	Record<string, { readonly renderer: RendererId; readonly sites: Readonly<Partial<Record<SiteId, string>>> }>
> = {
	"jev-1.13.0": {
		renderer: "systemone-v1",
		sites: {
			turn: "turn-v2",
			turnEnd: "turn-end-v3",
			toolCall: "tool-call-v2",
			toolResult: "tool-result-v2",
			relevance: "relevance-v1",
		},
	},
};

/** The contract a call ran under: what a measured table must match. */
export interface CallContract {
	readonly siteVersion: string;
	readonly renderer: RendererId;
}

/**
 * Softmax temperatures per LLM build, by question bucket. Raw logprobs from
 * small models are badly overconfident: fitted temperatures reported by the
 * community are 1.3 to 1.5 for a 27B model and 3 to 6 for a 4B one. Empty
 * until a build has been fitted on labeled cases; an absent build reads at 1.0.
 */
export type TemperatureBucket =
	| "noul"
	| "choice:2"
	| "choice:3-5"
	| "choice:6-10"
	| "choice:11+"
	| "score:2"
	| "score:3-5"
	| "score:6-10";

export const FITTED_TEMPERATURES: Readonly<Record<string, Readonly<Partial<Record<TemperatureBucket, number>>>>> = {};

/** The bucket a question's temperature is fitted under. */
function temperatureBucket(type: QuestionType, optionCount: number): TemperatureBucket {
	if (type === "noul") return "noul";
	if (type === "score") return optionCount <= 2 ? "score:2" : optionCount <= 5 ? "score:3-5" : "score:6-10";
	if (optionCount <= 2) return "choice:2";
	if (optionCount <= 5) return "choice:3-5";
	return optionCount <= 10 ? "choice:6-10" : "choice:11+";
}

/** The fitted temperature, or 1.0 for a build or bucket nobody fitted. */
export function temperatureFor(build: string, type: QuestionType, optionCount: number): number {
	if (!Object.hasOwn(FITTED_TEMPERATURES, build)) return 1;
	const value = FITTED_TEMPERATURES[build]?.[temperatureBucket(type, optionCount)];
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}

function measuredApplies(build: string, site: string, contract: CallContract | undefined): boolean {
	if (!Object.hasOwn(FITTED_CUTS, build)) return false;
	// Callers that predate contracts (doctor, the shadow check) see the table as
	// it stands; a call always passes its contract.
	if (contract === undefined) return true;
	const bound = Object.hasOwn(FITTED_CONTRACTS, build) ? FITTED_CONTRACTS[build] : undefined;
	return (
		bound !== undefined && bound.renderer === contract.renderer && bound.sites[site as SiteId] === contract.siteVersion
	);
}

/**
 * One site's cuts under one threshold identity (`thresholdIdentity`): the
 * measured table when the call's contract matches it, overlaid with the
 * operator's `systemOne.cuts`, where the operator wins. `fitted` is true when
 * any cut exists for `<site>.` under the identity, so a site with several cuts
 * stays silent as a whole for a build that has none. An operator cut acts, but
 * `source` reports it as the operator's, never as measured.
 */
export function cutsFor(
	identity: string,
	site: string,
	overrides?: Readonly<Record<string, Readonly<Record<string, number>>>>,
	contract?: CallContract,
): SiteCuts {
	const table = new Map<string, { value: number; source: "measured" | "operator" }>();
	const prefix = `${site}.`;
	const sources = [
		[measuredApplies(identity, site, contract) ? FITTED_CUTS : undefined, "measured"],
		[overrides, "operator"],
	] as const;
	for (const [source, kind] of sources) {
		if (source === undefined || !Object.hasOwn(source, identity)) continue;
		for (const [key, value] of Object.entries(source[identity] ?? {})) {
			if (key.startsWith(prefix) && Number.isFinite(value)) {
				table.set(key.slice(prefix.length), { value, source: kind });
			}
		}
	}
	return {
		build: identity,
		fitted: table.size > 0,
		cut: (key) => table.get(key)?.value,
		source: (key) => table.get(key)?.source,
	};
}

/** `measured` when any cut at the site is measured, else `operator` when any exists, else `none`. */
export function validationOf(cuts: SiteCuts, keys: Iterable<string>): "measured" | "operator" | "none" {
	let operator = false;
	for (const key of keys) {
		const source = cuts.source(key);
		if (source === "measured") return "measured";
		if (source === "operator") operator = true;
	}
	return operator ? "operator" : "none";
}
