import { isDeepStrictEqual } from "node:util";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import type { CallSettled, CallStarted, CallUsage } from "../../core/telemetry/schemas.js";

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
function addGroup(sum: FactSum, facts: readonly Fact<number>[]): void {
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
	usage: Record<keyof CallUsage, FactSum>;
	promptTokens: FactSum;
	totalTokens: FactSum;
	usd: FactSum;
}

/** All projections use these definitions: reasoning is included in output; cacheWrite1h is a cacheWrite subfield (#434). */
export function foldCalls(attempts: readonly FoldedAttempt[]): CallTotals {
	const totals: CallTotals = {
		logicalCalls: new Set(attempts.map(({ started }) => started.callId)).size,
		attempts: attempts.length,
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
	// Stable order makes independent consumers sum floating-point costs identically (#434).
	for (const { settled } of [...attempts].sort((a, b) => a.started.attemptId.localeCompare(b.started.attemptId))) {
		if (!settled) totals.incomplete += 1;
		else if (settled.disposition === "never_sent") totals.neverSent += 1;
		else if (settled.disposition === "sent_unsettled") totals.sentUnsettled += 1;
		else if (settled.disposition === "settled_no_usage") totals.settledNoUsage += 1;
		else totals.settled += 1;
		const fact = (field: keyof CallUsage) =>
			settled?.disposition === "never_sent" ? absent : (settled?.usage?.[field] ?? unknown);
		for (const field of fields) addGroup(totals.usage[field], [fact(field)]);
		const prompt = [fact("input"), fact("cacheRead"), fact("cacheWrite")];
		addGroup(totals.promptTokens, prompt);
		addGroup(totals.totalTokens, [...prompt, fact("output")]);
		addGroup(totals.usd, [settled?.pricing.usd ?? unknown]);
	}
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

/** Fold supplied journal and referenced run records once, irrespective of replay order or fork copies (#434). */
export function foldCallJournal(records: Iterable<TelemetryRecord>, callIds?: ReadonlySet<string>): JournalFold {
	const seen = new Map<string, TelemetryRecord>();
	const starts = new Map<string, CallStarted>();
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
	for (const record of records) {
		const previous = seen.get(record.id);
		if (previous && isDeepStrictEqual(previous, record)) {
			coverage.duplicateRecords += 1;
			continue;
		}
		if (previous) {
			for (const conflicting of [previous, record])
				if (conflicting.k === "call.started" || conflicting.k === "call.settled") conflicts.add(conflicting.data.attemptId);
		}
		seen.set(record.id, record);
		if (record.k === "gap") {
			coverage.gapRecords += 1;
			coverage.droppedRecords += record.data.count;
			continue;
		}
		if (record.k === "call.ref") {
			if (!callIds || callIds.has(record.data.callId)) references.add(record.data.callId);
			continue;
		}
		if (record.k !== "call.started" && record.k !== "call.settled") continue;
		const data = record.data;
		if (callIds && !callIds.has(data.callId)) continue;
		const started: CallStarted = {
			callId: data.callId,
			attemptId: data.attemptId,
			attempt: data.attempt,
			label: data.label,
			// A response model is learned at settlement; it is not part of the request identity (#434).
			target: { ...data.target, reportedModel: { kind: "unknown", reason: "not-observed" } },
			roundKind: data.roundKind,
			toolChoice: data.toolChoice,
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
	}
	const attempts = [...starts.values()]
		.sort((a, b) => a.attemptId.localeCompare(b.attemptId))
		.map((started) => ({
			started,
			settled: conflicts.has(started.attemptId) ? null : (settlements.get(started.attemptId) ?? null),
		}));
	coverage.conflictingAttempts = conflicts.size;
	const resolved = new Set(attempts.map(({ started }) => started.callId));
	return {
		attempts,
		totals: foldCalls(attempts),
		unresolvedCallIds: [...references].filter((id) => !resolved.has(id)).sort(),
		coverage,
	};
}

/** Grouping selects attempts only; every group's arithmetic remains the same fold (#434). */
export function foldCallsBy(
	attempts: readonly FoldedAttempt[],
	key: (attempt: FoldedAttempt) => string,
): Map<string, CallTotals> {
	const groups = new Map<string, FoldedAttempt[]>();
	for (const attempt of attempts) {
		const name = key(attempt);
		const group = groups.get(name) ?? [];
		group.push(attempt);
		groups.set(name, group);
	}
	return new Map(
		[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => [name, foldCalls(group)]),
	);
}
