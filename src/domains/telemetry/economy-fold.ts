import type { FundingDefinitions } from "../../core/funding-config.js";
import type {
	CallEconomics,
	EconomyFee,
	EconomyGroup,
	EconomyPoolRow,
	EconomyProjection,
	EconomyQuantities,
	EconomyReference,
	FundingEvidence,
	RunEconomics,
	UnitQuantity,
} from "../../core/telemetry/economy.js";
import { moneyQuantities, sumInUnit } from "../../core/telemetry/economy.js";
import type { Fact } from "../../core/telemetry/fact.js";
import {
	renderApiEquivalent,
	renderCash,
	renderEnergy,
	renderExtraCharge,
	renderPeriodFee,
	renderUnitTotal,
} from "../../core/telemetry/render.js";
import { foldFacts } from "./folds.js";

/**
 * Fold and explain once (token economy S10, R2): the one projection every economics surface reads. The read model
 * picks each counted contribution once (an attempt's settlement, or a run's settled aggregate standing in for
 * constituents it does not show); this module sums them in their units, cuts them by role, model, target and funding
 * pool and period, adds each declared fee once per pool and period, and renders them. Every cut partitions the same
 * contributions, so its rows reconcile to the total; fees enter pool rows and period cash only, never a role, model or
 * target row. Nothing here prices a route (R1) or reprices history: a quantity never captured stays unknown.
 */

/** Stamped on every projection; bump when a rule changes what a total means. */
export const ECONOMY_FOLD_VERSION = 1;

/** What a contribution stands for: one attempt, a run's aggregate, or an unreadable journal's unknown share. */
export type EconomyRef =
	| { kind: "attempt"; attemptId: string; callId: string }
	| { kind: "run"; runId: string }
	| { kind: "gap"; scope: string };

/** One counted contribution, as the read model selected it. */
export interface EconomyContribution {
	ref: EconomyRef;
	/** When it settled; places it in a calendar period when its funding snapshot names none. */
	at: string | null;
	economics: CallEconomics | RunEconomics;
	/** It carries a settlement; when two contributions name one ref, a settled one wins, then the later one. */
	settled: boolean;
	/** The seat's debit its runtime reported (`call.settled` `billing.nanoAiu`); a known one wins over the estimate. */
	reportedNanoAiu?: Fact<number>;
	cut: { role: string; model: string; target: string };
}

export interface EconomyFoldOptions {
	/** Declared funding pools; their fees enter once per period the window touches. */
	pools?: Readonly<FundingDefinitions>;
	/** The window fees are counted over, in epoch ms; defaults to the contributions' span. */
	window?: { from: number; to: number };
}

/** A pool key for no snapshot: unknown funding, or a contribution with nothing to fund (a call never sent). */
const UNKNOWN_POOL = "unknown";
const NO_POOL = "none";
const MIXED = "mixed";
/** Bounds the fee periods one window enumerates, so a daily fee over a long window stays finite. */
const MAX_FEE_PERIODS = 1000;

const refKey = (ref: EconomyRef) =>
	ref.kind === "attempt" ? `a:${ref.attemptId}` : ref.kind === "run" ? `r:${ref.runId}` : `g:${ref.scope}`;

function quantities(contributions: readonly EconomyContribution[]): EconomyQuantities {
	const additive = contributions.map(({ economics }) => economics.additive);
	const providerCharge = sumInUnit(moneyQuantities(additive.map((part) => part.providerCharge)));
	const marginalCharge = sumInUnit(moneyQuantities(additive.map((part) => part.marginalCharge)));
	const seatCredits = sumInUnit(
		contributions.map(({ economics, reportedNanoAiu }): UnitQuantity => {
			if (reportedNanoAiu?.kind === "measured" || reportedNanoAiu?.kind === "estimated")
				return { unit: "nano-aiu", fact: reportedNanoAiu };
			const seat = economics.additive.seatCredits;
			return "listingAsOf" in seat ? { unit: "nano-aiu", fact: seat.nanoAiu } : { fact: seat.nanoAiu };
		}),
	);
	const energyKwh = foldFacts(additive.map((part) => part.energy.kwh));
	const energyCost = sumInUnit(moneyQuantities(additive.map((part) => part.energy.cost)));
	const apiEquivalent = sumInUnit(
		contributions.map(({ economics }): UnitQuantity => {
			const equivalent = economics.comparison.apiEquivalent;
			return "currency" in equivalent
				? { unit: equivalent.currency, fact: equivalent.amount }
				: { fact: equivalent.amount };
		}),
	);
	return {
		contributions: contributions.length,
		providerCharge,
		marginalCharge,
		seatCredits,
		energyKwh,
		energyCost,
		apiEquivalent,
		display: {
			extra: renderExtraCharge(marginalCharge),
			providerCharge: renderUnitTotal(providerCharge),
			seatCredits: renderUnitTotal(seatCredits),
			energy: renderEnergy(energyKwh, energyCost),
			apiEquivalent: renderApiEquivalent(apiEquivalent),
		},
	};
}

function snapshots(funding: CallEconomics["funding"] | RunEconomics["funding"]): FundingEvidence[] | Fact<number> {
	if (Array.isArray(funding)) return funding;
	return funding.kind === "snapshot" ? [funding] : funding;
}

/** The UTC calendar period holding `at`; null for a period kind with no calendar. */
function calendarPeriod(kind: string, at: number): { start: number; end: number } | null {
	const date = new Date(at);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth();
	const day = date.getUTCDate();
	switch (kind) {
		case "day":
			return { start: Date.UTC(year, month, day), end: Date.UTC(year, month, day + 1) };
		case "week": {
			const monday = day - ((date.getUTCDay() + 6) % 7);
			return { start: Date.UTC(year, month, monday), end: Date.UTC(year, month, monday + 7) };
		}
		case "month":
			return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) };
		case "year":
			return { start: Date.UTC(year, 0, 1), end: Date.UTC(year + 1, 0, 1) };
		default:
			return null;
	}
}

const periodKey = (kind: string, start: number | string | null) =>
	start === null ? kind : `${kind}:${typeof start === "number" ? new Date(start).toISOString() : start}`;

/** The pool and period a contribution is counted under: its primary snapshot's, or mixed, unknown or none. */
function fundingKeys(contribution: EconomyContribution): { pool: string; period: string } {
	const found = snapshots(contribution.economics.funding);
	if (!Array.isArray(found)) return found.kind === "absent" ? { pool: NO_POOL, period: NO_POOL } : unknownKeys;
	const pools = new Set(found.map((snapshot) => snapshot.poolId));
	if (pools.size !== 1) return { pool: MIXED, period: MIXED };
	const at = contribution.at === null ? Number.NaN : Date.parse(contribution.at);
	const periods = new Set(
		found.map(({ period }) => {
			if (period.start !== undefined) return periodKey(period.kind, period.start);
			const calendar = Number.isFinite(at) ? calendarPeriod(period.kind, at) : null;
			return periodKey(period.kind, calendar?.start ?? null);
		}),
	);
	const [pool] = pools;
	const [period] = periods;
	return { pool: pool ?? UNKNOWN_POOL, period: periods.size === 1 && period !== undefined ? period : MIXED };
}
const unknownKeys = { pool: UNKNOWN_POOL, period: UNKNOWN_POOL };

/** Each declared periodic fee once for every billing period the window (inclusive ms) touches. */
function declaredFees(pools: Readonly<FundingDefinitions>, window: { from: number; to: number } | null): EconomyFee[] {
	const fees: EconomyFee[] = [];
	if (window === null || window.to < window.from) return fees;
	for (const [poolId, pool] of Object.entries(pools).sort(([a], [b]) => a.localeCompare(b))) {
		const fee = pool.fee;
		if (!fee || fee.period === "one-time") continue;
		let cursor = window.from;
		for (let count = 0; cursor <= window.to && count < MAX_FEE_PERIODS; count += 1) {
			const period = calendarPeriod(fee.period, cursor);
			if (period === null) break;
			const partial = window.from > period.start || window.to < period.end - 1;
			fees.push({
				poolId,
				payer: pool.payer ?? "unknown",
				period: {
					kind: fee.period,
					start: new Date(period.start).toISOString(),
					end: new Date(period.end).toISOString(),
				},
				amount: { kind: "estimated", value: fee.amount, method: "declared-tariff" },
				currency: fee.currency,
				evidence: "declared",
				partial,
				display: renderPeriodFee({ ...fee, evidence: "declared", partial }),
			});
			cursor = period.end;
		}
	}
	return fees;
}

const feeKey = (fee: EconomyFee) => periodKey(fee.period.kind, fee.period.start);

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const name = key(item);
		const group = groups.get(name) ?? [];
		group.push(item);
		groups.set(name, group);
	}
	return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

const settledAt = (contribution: EconomyContribution): number => {
	const at = contribution.at === null ? Number.NaN : Date.parse(contribution.at);
	return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
};

/** Whether `next` supersedes `prior` for the same ref: a settlement over none, then the later settlement. */
function latestSettlement(next: EconomyContribution, prior: EconomyContribution): boolean {
	if (next.settled !== prior.settled) return next.settled;
	return settledAt(next) > settledAt(prior);
}

/**
 * The one economics projection over the read model's selected contributions. A contribution counted twice (the same
 * attempt reached through two parts) is counted once, as its latest settlement, in a stable order, so every reader
 * sums identically.
 */
export function foldEconomy(
	selected: readonly EconomyContribution[],
	options: EconomyFoldOptions = {},
): EconomyProjection {
	const unique = new Map<string, EconomyContribution>();
	for (const contribution of selected) {
		const key = refKey(contribution.ref);
		const prior = unique.get(key);
		if (!prior || latestSettlement(contribution, prior)) unique.set(key, contribution);
	}
	const contributions = [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, contribution]) => contribution);
	const times = contributions.flatMap(({ at }) =>
		at === null || !Number.isFinite(Date.parse(at)) ? [] : [Date.parse(at)],
	);
	const window = options.window ?? (times.length > 0 ? { from: Math.min(...times), to: Math.max(...times) } : null);
	const fees = declaredFees(options.pools ?? {}, window);
	const cut = (dimension: keyof EconomyContribution["cut"]): EconomyGroup[] =>
		[...groupBy(contributions, (contribution) => contribution.cut[dimension])].map(([key, members]) => ({
			key,
			...quantities(members),
		}));
	const keyed = contributions.map((contribution) => ({ contribution, ...fundingKeys(contribution) }));
	const poolKeys = [...new Set([...keyed.map(({ pool }) => pool), ...fees.map(({ poolId }) => poolId)])].sort();
	const pool: EconomyPoolRow[] = poolKeys.map((key) => {
		const members = keyed.filter((entry) => entry.pool === key);
		const poolFees = fees.filter((fee) => fee.poolId === key);
		const periods = [...new Set([...members.map(({ period }) => period), ...poolFees.map(feeKey)])].sort();
		return {
			key,
			...quantities(members.map(({ contribution }) => contribution)),
			periods: periods.map((period) => ({
				key: period,
				...quantities(members.filter((entry) => entry.period === period).map(({ contribution }) => contribution)),
				fees: poolFees.filter((fee) => feeKey(fee) === period),
			})),
		};
	});
	const total = quantities(contributions);
	const cashParts: UnitQuantity[] = [
		...fees.filter((fee) => fee.payer === "personal").map((fee) => ({ unit: fee.currency, fact: fee.amount })),
		...moneyQuantities(contributions.map(({ economics }) => economics.additive.marginalCharge)),
		...moneyQuantities(contributions.map(({ economics }) => economics.additive.energy.cost)),
	];
	// A fee whose payer was never declared may be the user's own, so it is an unknown share of cash, never $0.
	const unknownPayerFees = fees.filter((fee) => fee.payer === "unknown").length;
	let unknownCount = unknownPayerFees + cashParts.filter(({ fact }) => fact.kind === "unknown").length;
	const byCurrency = groupBy(
		cashParts.filter((part): part is Extract<UnitQuantity, { unit: string }> => "unit" in part),
		({ unit }) => unit,
	);
	// An unknown part has no currency to land in, so it stays a count beside every currency's known total.
	const currencies = [...byCurrency.values()].flatMap((parts) => {
		const sum = sumInUnit(parts);
		if (!("refused" in sum)) return [sum];
		unknownCount += parts.length;
		return [];
	});
	const references = new Map<string, EconomyReference>();
	for (const { economics } of contributions) {
		const equivalent = economics.comparison.apiEquivalent;
		if (!("referenceRowId" in equivalent)) continue;
		const key = `${equivalent.referenceRowId}\u0000${equivalent.asOf}\u0000${equivalent.basis}`;
		const prior = references.get(key);
		if (prior) prior.contributions += 1;
		else
			references.set(key, {
				referenceRowId: equivalent.referenceRowId,
				asOf: equivalent.asOf,
				basis: equivalent.basis,
				contributions: 1,
			});
	}
	return {
		version: ECONOMY_FOLD_VERSION,
		total,
		fees,
		cash: { currencies, unknownCount, display: renderCash(currencies, unknownCount) },
		groups: { role: cut("role"), model: cut("model"), target: cut("target"), pool },
		references: [...references.values()].sort((a, b) => a.referenceRowId.localeCompare(b.referenceRowId)),
		sources: {
			attempts: contributions.filter(({ ref }) => ref.kind === "attempt").length,
			runs: contributions.filter(({ ref }) => ref.kind === "run").length,
			gaps: contributions.filter(({ ref }) => ref.kind === "gap").length,
		},
	};
}
