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
 * --case-split fit|holdout`, at turn-v3, worker-prepare-v1, turn-end-v3,
 * tool-call-v2 (gate), tool-call-v3 (card), tool-result-v2, relevance-v2 and
 * relevance-cluster-v2.
 *
 * The rule, fixed before the holdout was read:
 * - Noise is R, the largest spread of a case's readings across the 5 runs on the
 *   logit scale, over fit cases whose mean reading is 0.05 to 0.95. Readings near
 *   the ends compress in probability, and past that band the wire's two decimals
 *   dominate. Median probability spread is 0.01 to 0.02 at every key, largest
 *   0.04 to 0.13.
 * - A choice or a card rung has a negative wherever the winner is wrong, read on
 *   the winner's mass, or on the score's certainty for the card.
 * - A cut is the highest fit negative moved up by k x R in logits, rounded up to
 *   0.01. k is what a false fire costs: 2 where it spends real work (`prewarm`,
 *   `recipe` and `shape` hold worker processes, `proposal` adds an `ask_user`
 *   round), 1 where it is read-only or advisory (`direction`
 *   reads git, the tree and the codemap after a turn that ended on the operator;
 *   a hint is one line the model may ignore; `clusters` narrows one ranking; the
 *   gate, the result screen and turn-end write a ledger row).
 * - A key passes holdout when its false fires are 0 for k = 2 and at most 5% of
 *   negative case-runs for k = 1, and holdout recall is at least half of fit
 *   recall. A key gets no cut past 0.99 (the wire's resolution), with no positive
 *   above the cut, or on a holdout failure, and it keeps recording.
 *
 * Fires are readings at or over the cut, positive then negative case-runs. A turn-v3
 * holdout has 8 positive direct, 7 dispatch, 7 architecture, 6 direction, 6 proposal
 * and 7 shape cases, so these catch a broken key, not a small drift.
 * - `turn.direct` 0.97, k 1, R 0.66: fit 149/215, 0/685; holdout 35/40, 0/240.
 *   "draw me the big picture of how memory, context and prompts connect" at 0.94 sets it.
 * - `turn.dispatch` 0.94, k 1, R 0.89: fit 121/310, 0/840; holdout 20/35, 0/245.
 *   "Which agents would you send to explore this repo? Just list them" at 0.86 sets it.
 * - `turn.prewarm` 0.98, k 2, R 0.89, on the dispatch reading: fit 57/310, 0/840;
 *   holdout 13/35, 0/245.
 * - `turn.architecture` 0.98, k 1, R 0.63: fit 22/255, 0/840; holdout 10/35, 0/245.
 *   "how do the safety classifier and the dispatch scheduler relate?" at 0.95 sets it.
 * - `turn.direction` 0.88, k 1, R 0.75: fit 141/210, 0/830; holdout 25/30, 0/250.
 * - `turn.proposal` 0.96, k 2 because it adds an `ask_user` round, R 0.82: fit 45/45,
 *   0/550; holdout 20/30, 0/250.
 * - `turn.shape` 0.97, k 2 because parallel holds a second process, R 0.75, on the
 *   winning option's mass: fit 40/65, 0/15; holdout 13/35, with no wrong winner to test.
 * - `workerPrepare.recipe` 0.83, k 2, R 0.59, on the winning option's mass: fit
 *   180/225, 0/5; holdout 30/45, with no wrong winner to test.
 * - `turnEnd.asksOperator` 0.65, k 1, R 0.51: fit 165/165, 0/235; holdout 55/55,
 *   0/45.
 * - `toolResult.instructions` 0.59, k 1, R 0.50: fit 150/150, 0/175; holdout 30/30,
 *   0/35.
 * - `toolCall.gateDestroys` 0.56, k 1, R 0.50: fit 91/95, 0/195; holdout 24/25, 0/60.
 * - `toolCall.gateRadius` 0.59, k 1, R 0.34, on the rung position over 3: fit
 *   150/165, 0/140; holdout 35/40, 0/45.
 * - `toolCall.cardFloor` 0.77, k 1, R 0.74, on the score's certainty: fit 217/294,
 *   0/11; holdout 60/80, 0/5.
 * - `toolCall.cardOutside` 0.61, k 1, R 0.33: fit 130/130, 0/175; holdout 25/25, 0/60.
 * - `toolCall.cardDestroys` 0.54, k 1, R 0.50: fit 91/95, 0/195; holdout 25/25, 0/60.
 * - `relevance.clusters` 0.82, k 1, R 0.57, pooled over group answers: fit 60/60,
 *   0/245; holdout 58/60, 0/275.
 * - `relevance.ranked` 1 is a validation marker, not a threshold: an unvalidated
 *   build must not reorder a listing. Its bar was holdout recall@5 of 90%: fit
 *   recall@1 177/180 and recall@5 180/180, holdout 55/60 and 55/60.
 * - `relevance.related` 0.81, k 1, R 0.61, against needs nothing in the catalog serves
 *   and on the expected entry's score: fit 180/180, 0/3420; holdout 55/60, 0/3420.
 *
 * `TURN_SITE.deadlineMs` 600 is the 50 ms ceiling over the slowest turn reading seen:
 * 577 ms for a cold call among 32 real-session readings on turn-v2. Over 2100 fit calls
 * on turn-v3 the wire's p50 was 81 ms and its maximum 241 ms.
 *
 * A floor is a cut too. A build reads a choice as undecided, and spends no request on a
 * card or a draft judgment, without its own measured cut. The old 0.5 and 0.6 floors
 * acted on every build, and `intent: plan` over 0.6 added `ask_user` rounds in real
 * sessions (t06-plan, 2.29 times the total time of System One off on jev-1.14.0).
 *
 * Measured and left without a cut, so these only record or stay silent:
 * - `turnEnd.blocksOnDecision` and its floor: 0.85 and 0.42 fit, but holdout fired
 *   on 5/70 negative case-runs ("Renamed it. Do you want me to commit that?" at
 *   0.94), over the 5% budget. The floor alone held, and `blocks` needs both.
 * - `drafts.pick`: no wrong answer on fit (60/60 right), so nothing to place a cut
 *   against, and `drafts.sound` separated at 0.05 only because the candidates were easy.
 *   `/draft` asks no judge until harder cases give it a cut.
 */
export const FITTED_CUTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	"jev-1.14.0": {
		"turn.direct": 0.97,
		"turn.dispatch": 0.94,
		"turn.prewarm": 0.98,
		"turn.architecture": 0.98,
		"turn.direction": 0.88,
		"turn.proposal": 0.96,
		"turn.shape": 0.97,
		"workerPrepare.recipe": 0.83,
		"turnEnd.asksOperator": 0.65,
		"toolResult.instructions": 0.59,
		"toolCall.gateDestroys": 0.56,
		"toolCall.gateRadius": 0.59,
		"toolCall.cardFloor": 0.77,
		"toolCall.cardOutside": 0.61,
		"toolCall.cardDestroys": 0.54,
		"relevance.clusters": 0.82,
		"relevance.ranked": 1,
		"relevance.related": 0.81,
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
			turn: "turn-v3",
			workerPrepare: "worker-prepare-v1",
			turnEnd: "turn-end-v3",
			toolCall: "tool-call-v2",
			toolResult: "tool-result-v2",
			relevance: "relevance-v2",
		},
		moments: { relevance: ["relevance-cluster-v2"], toolCall: ["tool-call-v3"] },
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
		{ action: "exploration hint", requires: ["architecture"] },
		{ action: "direction", requires: ["direction"] },
		{ action: "plan close", requires: ["proposal"] },
	],
	workerPrepare: [{ action: "held worker", requires: ["recipe"] }],
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
