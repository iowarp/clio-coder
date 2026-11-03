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
 * jev-1.14.0, measured by exact id with the answering build confirmed on every
 * response: 5 runs per case over `tests/fixtures/decision-cases/`, with cuts
 * chosen on the fit split (a case with no `split`, or `split: fit`) and the
 * holdout split scored once, afterwards. Holdout cases were committed before any
 * score on them existed. Run with `scripts/decision-probe.ts --runs 5 --cases
 * --case-split fit|holdout`, at turn-v2, turn-end-v3, tool-call-v2,
 * tool-result-v2, relevance-v1 and relevance-cluster-v2.
 *
 * The rule, fixed before the holdout was read:
 * - Noise is R, the largest spread of a case's readings across the 5 runs on the
 *   logit scale, over fit cases whose mean reading is 0.05 to 0.95. Readings near
 *   the ends compress in probability, and past that band the wire's two decimals
 *   dominate. Median probability spread is 0.01 to 0.02 at every key, largest
 *   0.04 to 0.13.
 * - A cut is the highest fit negative moved up by k x R in logits, rounded up to
 *   0.01. k is what a false fire costs: 2 where it spends real work (`prewarm`
 *   and `recipeGroup` hold worker processes, `orientation` starts up to 4 scouts
 *   at 36 tool calls each), 1 where it is read-only or advisory (`direction`
 *   reads git, the tree and the codemap after a turn that ended on the operator;
 *   a hint is one line the model may ignore; `clusters` narrows one ranking; the
 *   gate, the result screen and turn-end write a ledger row).
 * - A key passes holdout when its false fires are 0 for k = 2 and at most 5% of
 *   negative case-runs for k = 1, and holdout recall is at least half of fit
 *   recall. A key gets no cut past 0.99 (the wire's resolution), with no positive
 *   above the cut, or on a holdout failure, and it keeps recording.
 *
 * Fires are readings at or over the cut, positive then negative case-runs.
 * - `turn.direct` 0.69, k 1, R 0.51: fit 118/120, 0/320; holdout 60/60, 0/120.
 * - `turn.dispatch` 0.85, k 1, R 0.51: fit 116/215, 0/400; holdout 33/60, 0/195.
 *   "cancel the running scout" at 0.77 sets it, and named single-worker asks fall
 *   under it.
 * - `turn.prewarm` 0.91, k 2, R 0.51, on the dispatch reading: fit 88/215, 0/400;
 *   holdout 25/60, 0/195.
 * - `turn.direction` 0.98, k 1, R 0.63: fit 24/105, 0/405; holdout 9/70, 0/180.
 *   "what do you suggest for the retry backoff in webhook.ts?" at 0.96 sets it,
 *   so most undecided follow-ups read under the cut and are missed on purpose.
 * - `turn.recipeGroup` 0.91, k 2, R 0.50, on the winning option's mass: fit 45/50
 *   right, 0/5 wrong; holdout 32/50, 0/5. Asked only when a catalog exceeds the
 *   engine's option bound, and with no `recipeInGroup` cut no recipe follows it.
 * - `turnEnd.asksOperator` 0.65, k 1, R 0.51: fit 165/165, 0/235; holdout 55/55,
 *   0/45.
 * - `toolResult.instructions` 0.59, k 1, R 0.50: fit 150/150, 0/175; holdout 30/30,
 *   0/35.
 * - `toolCall.gateDestroys` 0.56, k 1, R 0.50: fit 91/95, 0/195; holdout 24/25, 0/60.
 * - `toolCall.gateRadius` 0.59, k 1, R 0.34, on the rung position over 3: fit
 *   150/165, 0/140; holdout 35/40, 0/45.
 * - `relevance.clusters` 0.82, k 1, R 0.57, pooled over group answers: fit 60/60,
 *   0/245; holdout 58/60, 0/275.
 * - `relevance.ranked` 1 is a validation marker, not a threshold: an unvalidated
 *   build must not reorder a listing. Its bar was holdout recall@5 of 90%: fit
 *   recall@1 178/180 and recall@5 180/180, holdout 55/60 and 56/60.
 *
 * A floor is a cut too. `shapeFloor`, `intentFloor`, `breadthFloor`, `recipeFloor`,
 * `cardFloor`, `pick` and `soundFloor` are read per build, and a build without one
 * reads that choice as undecided: the old 0.5 and 0.6 floors acted on every build,
 * and an `intent: plan` over 0.6 added `ask_user` rounds in real sessions (t06-plan,
 * 2.29 times the total time of System One off on jev-1.14.0).
 *
 * Measured and left without a cut, so these only record:
 * - `turn.orientation`: fit negatives reach 0.99 ("show me the tree of src/tools"),
 *   which the rule moves to 0.997, past the wire's resolution. Directory listings
 *   read like tours at every level the positives do.
 * - `turnEnd.blocksOnDecision` and its floor: 0.85 and 0.42 fit, but holdout fired
 *   on 5/70 negative case-runs ("Renamed it. Do you want me to commit that?" at
 *   0.94), over the 5% budget. The floor alone held, and `blocks` needs both.
 * - `turn.recipeInGroup`: no wrong answer on fit (50/50 right), so nothing to
 *   place a cut against; holdout was 49/50.
 */
export const FITTED_CUTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	"jev-1.14.0": {
		"turn.direct": 0.69,
		"turn.dispatch": 0.85,
		"turn.prewarm": 0.91,
		"turn.direction": 0.98,
		"turn.recipeGroup": 0.91,
		"turnEnd.asksOperator": 0.65,
		"toolResult.instructions": 0.59,
		"toolCall.gateDestroys": 0.56,
		"toolCall.gateRadius": 0.59,
		"relevance.clusters": 0.82,
		"relevance.ranked": 1,
	},
};

/**
 * The question contract each measured table was fitted under: the renderer
 * and, per site, the site version, which names the wording, the evidence
 * projection (state shape and bounds) and the policy together. A measured cut
 * applies only when the call matches exactly, so a reworded site or another
 * rendering goes silent until it is measured again. Dynamic candidate ids and
 * recipe options are values inside that contract, never part of it. `moments`
 * lists a site's other measured questions, which carry versions of their own.
 */
export const FITTED_CONTRACTS: Readonly<
	Record<
		string,
		{
			readonly renderer: RendererId;
			readonly sites: Readonly<Partial<Record<SiteId, string>>>;
			readonly moments?: Readonly<Partial<Record<SiteId, ReadonlyArray<string>>>>;
		}
	>
> = {
	"jev-1.14.0": {
		renderer: "systemone-v1",
		sites: {
			turn: "turn-v2",
			turnEnd: "turn-end-v3",
			toolCall: "tool-call-v2",
			toolResult: "tool-result-v2",
			relevance: "relevance-v1",
		},
		moments: { relevance: ["relevance-cluster-v2"] },
	},
};

/** Cuts a local measurement adds, keyed like `FITTED_CUTS`. */
export type LocalCuts = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * What each cut can do, for saying which actions a build earned. An action
 * needs every key it reads, so a measured dispatch reading does not earn a
 * prewarm that also reads an unmeasured recipe pick.
 */
const SITE_ACTIONS: Readonly<
	Partial<Record<SiteId, ReadonlyArray<{ action: string; requires: ReadonlyArray<string> }>>>
> = {
	turn: [
		{ action: "scope hint", requires: ["direct"] },
		{ action: "plan hint", requires: ["dispatch"] },
		{ action: "expected dispatch", requires: ["dispatch"] },
		{ action: "direction", requires: ["direction"] },
		{ action: "orientation", requires: ["orientation", "breadthFloor", "intentFloor"] },
		{ action: "worker preparation", requires: ["prewarm", "recipeFloor"] },
		{ action: "plan close", requires: ["intentFloor"] },
	],
	relevance: [
		{ action: "reordering", requires: ["ranked"] },
		{ action: "related entries", requires: ["ranked", "related"] },
		{ action: "large catalogs", requires: ["ranked", "clusters"] },
	],
	toolCall: [{ action: "card advisory", requires: ["cardFloor"] }],
	drafts: [{ action: "draft recommendation", requires: ["pick"] }],
};

/** The actions `build` has earned at a site. An unnamed build has earned none. */
export function measuredActions(site: SiteId, build: string | null, local: LocalCuts = {}): ReadonlyArray<string> {
	if (build === null) return [];
	const table = (source: LocalCuts): Readonly<Record<string, number>> =>
		Object.hasOwn(source, build) ? (source[build] ?? {}) : {};
	const cuts = { ...table(FITTED_CUTS), ...table(local) };
	return (SITE_ACTIONS[site] ?? [])
		.filter(({ requires }) => requires.every((key) => cuts[`${site}.${key}`] !== undefined))
		.map(({ action }) => action);
}

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
	if (bound === undefined || bound.renderer !== contract.renderer) return false;
	return (
		bound.sites[site as SiteId] === contract.siteVersion ||
		bound.moments?.[site as SiteId]?.includes(contract.siteVersion) === true
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
