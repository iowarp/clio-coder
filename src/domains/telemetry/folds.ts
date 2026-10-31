import { isDeepStrictEqual } from "node:util";
import type { TelemetryAgent } from "../../core/telemetry/context.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import type { CallSettled, CallStarted, CallUsage } from "../../core/telemetry/schemas.js";

/** Stamped on every read-model DTO; bump when a fold rule changes what a sum means (#434, R4). */
export const TELEMETRY_FOLD_VERSION = 1;

const fields = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning"] as const;
const unknown: Fact<number> = { kind: "unknown", reason: "not-observed" };
const absent: Fact<number> = { kind: "absent", reason: "not-applicable" };
export const emptyFactSum = (): FactSum => ({
	measured: 0,
	estimated: 0,
	unknownCount: 0,
	absentCount: 0,
	coverage: { measured: 0, estimated: 0, unknown: 0 },
});

/** One group is one call's contribution. Partial groups retain known subtotals and count missing coverage once (#434). */
export function addGroup(sum: FactSum, facts: readonly Fact<number>[]): void {
	const kinds = new Set<Fact<number>["kind"]>();
	for (const fact of facts) {
		kinds.add(fact.kind);
		if (fact.kind === "measured") sum.measured += fact.value;
		else if (fact.kind === "estimated") sum.estimated += fact.value;
	}
	if (kinds.has("measured")) sum.coverage.measured += 1;
	if (kinds.has("estimated")) sum.coverage.estimated += 1;
	if (kinds.has("unknown")) {
		sum.unknownCount += 1;
		sum.coverage.unknown += 1;
	}
	if (kinds.has("absent")) sum.absentCount += 1;
}

export function foldFacts(facts: Iterable<Fact<number>>): FactSum {
	const sum = emptyFactSum();
	for (const fact of facts) addGroup(sum, [fact]);
	return sum;
}

export interface FoldedAttempt {
	/** The agent that made the call, from its records' context (#434). */
	agent: TelemetryAgent;
	started: CallStarted;
	/** Null means no trustworthy settlement; it does not assert that a request was sent (#434). */
	settled: CallSettled | null;
}
export interface CallTotals {
	logicalCalls: number;
	attempts: number;
	neverSent: number;
	sentUnsettled: number;
	settledNoUsage: number;
	settled: number;
	incomplete: number;
	usage: Record<(typeof fields)[number], FactSum>;
	promptTokens: FactSum;
	totalTokens: FactSum;
	usd: FactSum;
}

export function emptyCallTotals(): CallTotals {
	return {
		logicalCalls: 0,
		attempts: 0,
		neverSent: 0,
		sentUnsettled: 0,
		settledNoUsage: 0,
		settled: 0,
		incomplete: 0,
		usage: {
			input: emptyFactSum(),
			output: emptyFactSum(),
			cacheRead: emptyFactSum(),
			cacheWrite: emptyFactSum(),
			cacheWrite1h: emptyFactSum(),
			reasoning: emptyFactSum(),
		},
		promptTokens: emptyFactSum(),
		totalTokens: emptyFactSum(),
		usd: emptyFactSum(),
	};
}

/**
 * Fold one more attempt into `totals` in place; {@link foldCalls} is this over attempts in attemptId order. Distinct
 * calls are a property of the whole set, so `logicalCalls` is the caller's.
 */
export function addCallTotals(totals: CallTotals, settled: CallSettled | null): void {
	totals.attempts += 1;
	if (!settled) totals.incomplete += 1;
	else if (settled.disposition === "never_sent") totals.neverSent += 1;
	else if (settled.disposition === "sent_unsettled") totals.sentUnsettled += 1;
	else if (settled.disposition === "settled_no_usage") totals.settledNoUsage += 1;
	else totals.settled += 1;
	const fact = (field: keyof CallUsage) =>
		settled?.disposition === "never_sent" ? absent : (settled?.usage?.[field] ?? unknown);
	// An unsettled call's counts are a lower bound, so every sum it enters stays partial (#434).
	const bound = settled?.disposition === "sent_unsettled" ? [unknown] : [];
	for (const field of fields) addGroup(totals.usage[field], [fact(field), ...bound]);
	const prompt = [fact("input"), fact("cacheRead"), fact("cacheWrite")];
	addGroup(totals.promptTokens, [...prompt, ...bound]);
	const total = settled?.usage?.total;
	addGroup(totals.totalTokens, [...(total ? [total] : [...prompt, fact("output")]), ...bound]);
	addGroup(totals.usd, [settled?.pricing.usd ?? unknown, ...bound]);
}

/** All projections use these definitions: reasoning is included in output; cacheWrite1h is a cacheWrite subfield (#434). */
export function foldCalls(attempts: readonly Pick<FoldedAttempt, "started" | "settled">[]): CallTotals {
	const totals = emptyCallTotals();
	totals.logicalCalls = new Set(attempts.map(({ started }) => started.callId)).size;
	// Stable order makes independent consumers sum floating-point costs identically (#434).
	for (const { settled } of [...attempts].sort((a, b) => a.started.attemptId.localeCompare(b.started.attemptId)))
		addCallTotals(totals, settled);
	return totals;
}

export interface JournalFold {
	attempts: FoldedAttempt[];
	totals: CallTotals;
	/** References with no supplied call facts cannot reveal how many attempts or dollars they represent (#434). */
	unresolvedCallIds: string[];
	coverage: {
		duplicateRecords: number;
		duplicateAttempts: number;
		conflictingAttempts: number;
		gapRecords: number;
		droppedRecords: number;
	};
}

/** The state {@link foldCallJournal} folds records into, kept by the live read model so each batch folds once (#434). */
export interface CallJournalFolder {
	/** Fold one record; returns the attempts whose folded start or settlement it may have changed. */
	add(record: TelemetryRecord): readonly string[];
	/** One attempt as the fold would emit it; undefined until its call.started arrives. */
	attempt(attemptId: string): FoldedAttempt | undefined;
	/** Every attempt as the fold emits them, in attemptId order. */
	attempts(): FoldedAttempt[];
	/** Current counters, kept up to date by `add`. */
	readonly coverage: JournalFold["coverage"];
	fold(): JournalFold;
}

/**
 * How a fold reads an interrupted call the provider never reported on. Its settlement carries Clio's estimate of the
 * call's input and output beside the usage. The read model reads that estimate in place of the unknown counts, so a
 * transcript, footer or report shows `~` where it would show `?`, and the call's sent_unsettled bound keeps every sum
 * it enters a lower bound. Accounting folds (ledger rows, receipts, caps) leave it out (#430, #434).
 */
export interface FoldOptions {
	interruptedEstimates?: boolean;
}

const estimatedSettlements = new WeakMap<CallSettled, CallSettled>();
function withInterruptedEstimate(settled: CallSettled): CallSettled {
	const estimate = settled.interruptedEstimate;
	if (!estimate || settled.disposition !== "sent_unsettled" || !settled.usage) return settled;
	let shown = estimatedSettlements.get(settled);
	if (!shown) {
		const { input, output } = settled.usage;
		shown = {
			...settled,
			usage: {
				...settled.usage,
				input: input.kind === "unknown" ? estimate.input : input,
				output: output.kind === "unknown" ? estimate.output : output,
			},
		};
		estimatedSettlements.set(settled, shown);
	}
	return shown;
}

export function callJournalFolder(callIds?: ReadonlySet<string>, options: FoldOptions = {}): CallJournalFolder {
	const seen = new Map<string, TelemetryRecord>();
	const starts = new Map<string, { agent: TelemetryAgent; started: CallStarted }>();
	const settlements = new Map<string, CallSettled>();
	const conflicts = new Set<string>();
	const references = new Set<string>();
	const coverage = {
		duplicateRecords: 0,
		duplicateAttempts: 0,
		conflictingAttempts: 0,
		gapRecords: 0,
		droppedRecords: 0,
	};
	const attempt = ({ agent, started }: { agent: TelemetryAgent; started: CallStarted }): FoldedAttempt => {
		const settled = conflicts.has(started.attemptId) ? null : (settlements.get(started.attemptId) ?? null);
		return {
			agent,
			started,
			settled: settled && options.interruptedEstimates ? withInterruptedEstimate(settled) : settled,
		};
	};
	const ordered = () =>
		[...starts.values()].sort((a, b) => a.started.attemptId.localeCompare(b.started.attemptId)).map(attempt);
	return {
		coverage,
		add(record) {
			const touched: string[] = [];
			const previous = seen.get(record.id);
			if (previous && isDeepStrictEqual(previous, record)) {
				coverage.duplicateRecords += 1;
				return touched;
			}
			if (previous) {
				for (const conflicting of [previous, record])
					if (conflicting.k === "call.started" || conflicting.k === "call.settled") {
						conflicts.add(conflicting.data.attemptId);
						touched.push(conflicting.data.attemptId);
					}
				coverage.conflictingAttempts = conflicts.size;
			}
			seen.set(record.id, record);
			if (record.k === "journal.gap") {
				// A mode change or the research cap only refuses research-tier records; accounting never passes either
				// gate, so neither leaves a call total partial (#434).
				if (record.data.reason === "mode-filtered" || record.data.reason === "research-cap") return touched;
				coverage.gapRecords += 1;
				coverage.droppedRecords += record.data.count;
				return touched;
			}
			if (record.k === "call.linked") {
				if (!callIds || callIds.has(record.data.callId)) references.add(record.data.callId);
				return touched;
			}
			if (record.k !== "call.started" && record.k !== "call.settled") return touched;
			const data = record.data;
			if (callIds && !callIds.has(data.callId)) return touched;
			touched.push(data.attemptId);
			const started = {
				agent: record.ctx.agent,
				started: {
					callId: data.callId,
					attemptId: data.attemptId,
					attempt: data.attempt,
					// A response model is learned at settlement; it is not part of the request identity (#434).
					target: { ...data.target, reportedModel: { kind: "unknown", reason: "not-observed" } },
					roundKind: data.roundKind,
					toolChoice: data.toolChoice,
				} satisfies CallStarted,
			};
			const priorStart = starts.get(data.attemptId);
			if (priorStart && !isDeepStrictEqual(priorStart, started)) {
				conflicts.add(data.attemptId);
				if (JSON.stringify(started) < JSON.stringify(priorStart)) starts.set(data.attemptId, started);
			} else starts.set(data.attemptId, started);
			if (record.k === "call.settled") {
				const prior = settlements.get(data.attemptId);
				if (prior && !isDeepStrictEqual(prior, record.data)) conflicts.add(data.attemptId);
				else if (prior) coverage.duplicateAttempts += 1;
				else settlements.set(data.attemptId, record.data);
			}
			coverage.conflictingAttempts = conflicts.size;
			return touched;
		},
		attempt(attemptId) {
			const started = starts.get(attemptId);
			return started ? attempt(started) : undefined;
		},
		attempts: ordered,
		fold() {
			const attempts = ordered();
			const resolved = new Set(attempts.map(({ started }) => started.callId));
			return {
				attempts,
				totals: foldCalls(attempts),
				unresolvedCallIds: [...references].filter((id) => !resolved.has(id)).sort(),
				coverage: { ...coverage },
			};
		},
	};
}

/** Fold supplied journal and referenced run records once, irrespective of replay order or fork copies (#434). */
export function foldCallJournal(
	records: Iterable<TelemetryRecord>,
	callIds?: ReadonlySet<string>,
	options: FoldOptions = {},
): JournalFold {
	const folder = callJournalFolder(callIds, options);
	for (const record of records) folder.add(record);
	return folder.fold();
}

/** A run snapshot includes its constituent calls. Pick one accounting source, independent of replay order (#434). */
function foldRunScope(records: Iterable<TelemetryRecord>, options: FoldOptions) {
	const rows = [...records];
	const calls = foldCallJournal(rows, undefined, options);
	const aggregates = rows.flatMap((row) => (row.k === "run.usage_reported" ? [row.data] : []));
	const revision = aggregates.reduce((maximum, row) => Math.max(maximum, row.revision), -1);
	const latest = aggregates.filter((row) => row.revision === revision);
	const aggregate = latest[0];
	const conflict =
		aggregate !== undefined &&
		(aggregates.some((row) => row.source !== aggregate.source || row.scope !== aggregate.scope) ||
			latest.some((row) => !isDeepStrictEqual(row, aggregate)));
	const observed = (value: number): Fact<number> => ({ kind: "measured", value, source: "local-count" });
	const fromFact = (fact: Fact<number>) => foldFacts([fact]);
	const callTotals = calls.totals;
	const apiCalls = callTotals.settled + callTotals.settledNoUsage + callTotals.sentUnsettled;
	const missingCalls = foldCalls(calls.attempts.filter((attempt) => attempt.settled !== null)).totalTokens.unknownCount;
	const choose = (fact: Fact<number>) => fromFact(conflict ? unknown : fact);
	const chooseCount = (fact: Fact<number>) =>
		!conflict && aggregate?.callCountCoverage !== "complete" && fact.kind !== "unknown"
			? foldFacts([fact, unknown])
			: choose(fact);
	const usage = aggregate
		? (Object.fromEntries(fields.map((field) => [field, choose(aggregate.usage[field])])) as Record<
				(typeof fields)[number],
				FactSum
			>)
		: callTotals.usage;
	const aggregateTokenSubtotal = emptyFactSum();
	if (aggregate)
		addGroup(aggregateTokenSubtotal, [
			aggregate.usage.input,
			aggregate.usage.output,
			aggregate.usage.cacheRead,
			aggregate.usage.cacheWrite,
		]);
	return {
		calls,
		aggregate: conflict ? null : (aggregate ?? null),
		source: aggregate ? (conflict ? ("conflict" as const) : ("aggregate" as const)) : ("calls" as const),
		usage,
		totalTokens: aggregate
			? !conflict && aggregate.totalTokens.kind === "unknown"
				? aggregateTokenSubtotal
				: choose(aggregate.totalTokens)
			: callTotals.totalTokens,
		usd: aggregate
			? !conflict && aggregate.pricingCoverage !== "complete" && aggregate.pricing.usd.kind !== "unknown"
				? foldFacts([aggregate.pricing.usd, unknown])
				: choose(aggregate.pricing.usd)
			: callTotals.usd,
		// Identified constituent calls provide a lower bound even when the aggregate omits its count (#434).
		apiCalls: aggregate
			? !conflict && aggregate.apiCalls.kind === "unknown"
				? foldFacts([observed(apiCalls), aggregate.apiCalls])
				: chooseCount(aggregate.apiCalls)
			: fromFact(observed(apiCalls)),
		missingTokenCalls: aggregate ? chooseCount(aggregate.missingTokenCalls) : fromFact(observed(missingCalls)),
		amountCoverageUnknown: aggregate
			? conflict || aggregate.coverage !== "complete"
			: calls.coverage.gapRecords > 0 || callTotals.incomplete > 0 || calls.unresolvedCallIds.length > 0,
		unknownCoverage:
			conflict ||
			(aggregate
				? aggregate.coverage !== "complete" ||
					aggregate.callCountCoverage !== "complete" ||
					aggregate.apiCalls.kind === "unknown" ||
					aggregate.apiCalls.kind === "absent" ||
					aggregate.missingTokenCalls.kind === "unknown" ||
					aggregate.missingTokenCalls.kind === "absent"
				: calls.coverage.gapRecords > 0 || callTotals.incomplete > 0 || calls.unresolvedCallIds.length > 0),
	};
}

export function sumFactSums(sums: readonly FactSum[]): FactSum {
	const result = emptyFactSum();
	for (const sum of sums) {
		result.measured += sum.measured;
		result.estimated += sum.estimated;
		result.unknownCount += sum.unknownCount;
		result.absentCount += sum.absentCount;
		for (const kind of ["measured", "estimated", "unknown"] as const) result.coverage[kind] += sum.coverage[kind];
	}
	return result;
}

/** Parts are disjoint reported contributions, not inferred calls; a whole-scope snapshot replaces them (#434). */
export function foldRunJournal(records: Iterable<TelemetryRecord>, options: FoldOptions = {}) {
	const rows = [...records];
	const whole = rows.filter((row) => row.k !== "run.usage_reported" || row.data.partId === undefined);
	const base = foldRunScope(whole, options);
	const parts = new Map<string, TelemetryRecord[]>();
	for (const row of rows) {
		if (row.k !== "run.usage_reported" || row.data.partId === undefined) continue;
		const group = parts.get(row.data.partId) ?? [];
		group.push(row);
		parts.set(row.data.partId, group);
	}
	const allKnownFree = (scope: ReturnType<typeof foldRunScope>) => {
		const invoked = scope.calls.attempts.filter((attempt) => attempt.settled?.disposition !== "never_sent");
		return scope.source === "aggregate"
			? scope.aggregate?.pricing.pricedBy === "free"
			: scope.source === "calls" &&
					invoked.length > 0 &&
					invoked.every((attempt) => attempt.settled?.pricing.pricedBy === "free");
	};
	if (base.source !== "calls" || parts.size === 0) return { ...base, allKnownFree: allKnownFree(base) };
	const scopes = [...parts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, part]) => foldRunScope(part, options));
	const sources = new Set(scopes.map((scope) => `${scope.aggregate?.source}/${scope.aggregate?.scope}`));
	if (sources.size > 1) return { ...foldRunScope(rows, options), allKnownFree: false };
	const sum = (key: "totalTokens" | "usd" | "apiCalls" | "missingTokenCalls") =>
		sumFactSums(scopes.map((scope) => scope[key]));
	const apiCalls = sum("apiCalls");
	// Identified constituent calls and reported part counts overlap; either can establish a lower bound (#434).
	if (apiCalls.unknownCount > 0) apiCalls.measured = Math.max(apiCalls.measured, base.apiCalls.measured);
	return {
		...base,
		source: "parts" as const,
		usage: Object.fromEntries(
			fields.map((field) => [field, sumFactSums(scopes.map((scope) => scope.usage[field]))]),
		) as Record<(typeof fields)[number], FactSum>,
		totalTokens: sum("totalTokens"),
		usd: sum("usd"),
		apiCalls,
		missingTokenCalls: sum("missingTokenCalls"),
		amountCoverageUnknown: base.amountCoverageUnknown || scopes.some((scope) => scope.amountCoverageUnknown),
		unknownCoverage: base.unknownCoverage || scopes.some((scope) => scope.unknownCoverage),
		allKnownFree: scopes.every(allKnownFree),
	};
}
