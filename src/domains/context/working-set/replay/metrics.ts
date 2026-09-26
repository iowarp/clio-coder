import { EVICTION_REASONS, type EvictionReason } from "../../../session/entries.js";
import { covers, type PathIndex, type PathObservation } from "../path-index.js";
import type { ReferenceGraph, ReferencePoint } from "./reference-graph.js";
import type { ReplayTraceResult } from "./runner.js";
import type { Trace } from "./trace.js";

export interface ReplayMetrics {
	traces: number;
	retention: number;
	/** Retention after crediting a surviving newer read that covers the original range. */
	retentionCovered: number;
	retentionAt10: number;
	evictionPrecision: number;
	tokensEvicted: number;
	/** Tokens freed by evicting items a later request referenced again: the re-discovery bill a perfect recall would pay. */
	recallTokens: number;
	/** Sum over events of the projected tokens after the earliest evicted position: exact-prefix cache re-prefill cost. */
	coldPrefixTokens: number;
	/** Projected tokens after every applied summary, summed: the summary side of the same cache bill. */
	summaryColdPrefixTokens: number;
	/** `coldPrefixTokens + summaryColdPrefixTokens`: everything an exact-prefix cache re-prefills because of context reduction. */
	cacheMissTokens: number;
	/** Cold prefix tokens per eviction event; zero when a trace fired none. */
	cacheMissPerEvent: number;
	evictionEvents: number;
	/** Pressure checkpoints the trace offered, one per model request. */
	checkpoints: number;
	/** Checkpoints where the projection exceeded the modeled fit limit, so reduction was forced past the rearm band. */
	overflowReductions: number;
	/** Fraction of applied events that exhausted the policy's usable candidates. */
	saturatedEvents: number;
	turnsToFirstSummary: number | null;
	/** Summary compactions the modeled summary stage applied; what a policy exists to make rare. */
	summaries: number;
}

export interface ReasonTally {
	items: number;
	tokens: number;
}

export interface ReplayMeasurement {
	trace: Trace;
	index: PathIndex;
	graph: ReferenceGraph;
	replay: ReplayTraceResult;
}

export interface ReplayMetricAggregate {
	/** Arithmetic mean of the per-trace metrics; `traces` is the sample size. */
	mean: ReplayMetrics;
	/** Number of traces contributing to the nullable `turnsToFirstSummary` mean. */
	turnsToFirstSummaryCount: number;
	/** Headline pair-level retention pooled across every critical future reference. */
	pooledRetention: number;
	pooledRetentionCovered: number;
	pooledRetentionAt10: number;
	/** Items and tokens evicted per reason, totals over every trace, in `EVICTION_REASONS` order; absent reasons are omitted. */
	byReason: ReadonlyMap<EvictionReason, ReasonTally>;
}

interface MeasuredTrace {
	metrics: ReplayMetrics;
	pairs: number;
	retainedPairs: number;
	coveredRetainedPairs: number;
	pairsAt10: number;
	retainedPairsAt10: number;
	saturatedEventCount: number;
	byReason: Map<EvictionReason, ReasonTally>;
}

function safeFraction(numerator: number, denominator: number, empty: number): number {
	return denominator === 0 ? empty : numerator / denominator;
}

/** An eviction fired at checkpoint `k` precedes every entry at position `k` or later. */
function retainedThrough(evictedAt: number | undefined, point: ReferencePoint): boolean {
	return evictedAt === undefined || evictedAt > point.position;
}

function hasSurvivingCoveringRead(input: ReplayMeasurement, ref: string, point: ReferencePoint): boolean {
	const original = input.index.byRef.get(ref);
	if (original?.op !== "read" || original.path.length === 0) return false;
	return (input.index.byPath.get(original.path) ?? []).some(
		(later: PathObservation) =>
			later.op === "read" &&
			!later.isError &&
			later.entryIndex > original.entryIndex &&
			later.entryIndex < point.entryIndex &&
			covers(later.range, original.range) &&
			retainedThrough(input.replay.evictedAt.get(later.ref.entry), point),
	);
}

function measure(input: ReplayMeasurement): MeasuredTrace {
	let pairs = 0;
	let retainedPairs = 0;
	let coveredRetainedPairs = 0;
	let pairsAt10 = 0;
	let retainedPairsAt10 = 0;
	for (const [ref, points] of input.graph.futureReferencesOf) {
		const observationTurn = input.index.byRef.get(ref)?.turnIndex;
		const evictedAt = input.replay.evictedAt.get(ref);
		for (const point of points) {
			pairs += 1;
			const retained = retainedThrough(evictedAt, point);
			if (retained) retainedPairs += 1;
			if (retained || hasSurvivingCoveringRead(input, ref, point)) coveredRetainedPairs += 1;
			if (observationTurn !== undefined && point.turnIndex - observationTurn <= 10) {
				pairsAt10 += 1;
				if (retained) retainedPairsAt10 += 1;
			}
		}
	}

	// Precision is the share of evicted items never referenced again; the
	// complement (items the session came back to) is what live churn would
	// count as recalls, so it is not reported as a second column.
	let evictedItems = 0;
	let safelyEvictedItems = 0;
	let tokensEvicted = 0;
	let recallTokens = 0;
	let coldPrefixTokens = 0;
	let saturatedEventCount = 0;
	const byReason = new Map<EvictionReason, ReasonTally>();
	for (const event of input.replay.events) {
		if (event.saturated) saturatedEventCount += 1;
		coldPrefixTokens += event.coldPrefixTokens;
		for (const item of event.items) {
			evictedItems += 1;
			tokensEvicted += item.tokensFreed;
			const tally = byReason.get(item.reason) ?? { items: 0, tokens: 0 };
			tally.items += 1;
			tally.tokens += item.tokensFreed;
			byReason.set(item.reason, tally);
			const future = input.graph.futureReferencesOf.get(item.ref.entry) ?? [];
			if (!future.some((point) => point.position >= event.checkpointIndex)) safelyEvictedItems += 1;
			else recallTokens += item.tokensFreed;
		}
	}
	const events = input.replay.events.length;
	const summaryColdPrefixTokens = input.replay.summaryColdPrefixTokens;

	return {
		metrics: {
			traces: 1,
			retention: safeFraction(retainedPairs, pairs, 1),
			retentionCovered: safeFraction(coveredRetainedPairs, pairs, 1),
			retentionAt10: safeFraction(retainedPairsAt10, pairsAt10, 1),
			evictionPrecision: safeFraction(safelyEvictedItems, evictedItems, 1),
			tokensEvicted,
			recallTokens,
			coldPrefixTokens,
			summaryColdPrefixTokens,
			cacheMissTokens: coldPrefixTokens + summaryColdPrefixTokens,
			cacheMissPerEvent: safeFraction(coldPrefixTokens, events, 0),
			evictionEvents: events,
			checkpoints: input.replay.checkpointCount,
			overflowReductions: input.replay.overflowReductions,
			saturatedEvents: safeFraction(saturatedEventCount, events, 0),
			turnsToFirstSummary: input.replay.turnsToFirstSummary,
			summaries: input.replay.summaries,
		},
		pairs,
		retainedPairs,
		coveredRetainedPairs,
		pairsAt10,
		retainedPairsAt10,
		saturatedEventCount,
		byReason,
	};
}

function mean(values: ReadonlyArray<number>): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregateReplayMetrics(inputs: ReadonlyArray<ReplayMeasurement>): ReplayMetricAggregate {
	const measured = inputs.map(measure);
	const firstSummaries = measured
		.map((entry) => entry.metrics.turnsToFirstSummary)
		.filter((value): value is number => value !== null);
	const sum = (field: "pairs" | "retainedPairs" | "coveredRetainedPairs" | "pairsAt10" | "retainedPairsAt10"): number =>
		measured.reduce((total, entry) => total + entry[field], 0);
	const totalEvents = measured.reduce((total, entry) => total + entry.metrics.evictionEvents, 0);
	const saturatedEvents = measured.reduce((total, entry) => total + entry.saturatedEventCount, 0);
	const meanOf = (pick: (metrics: ReplayMetrics) => number): number =>
		mean(measured.map((entry) => pick(entry.metrics)));
	const byReason = new Map<EvictionReason, ReasonTally>();
	for (const reason of EVICTION_REASONS) {
		let items = 0;
		let tokens = 0;
		for (const entry of measured) {
			const tally = entry.byReason.get(reason);
			if (tally === undefined) continue;
			items += tally.items;
			tokens += tally.tokens;
		}
		if (items > 0) byReason.set(reason, { items, tokens });
	}
	return {
		mean: {
			traces: measured.length,
			retention: measured.length === 0 ? 1 : meanOf((metrics) => metrics.retention),
			retentionCovered: measured.length === 0 ? 1 : meanOf((metrics) => metrics.retentionCovered),
			retentionAt10: measured.length === 0 ? 1 : meanOf((metrics) => metrics.retentionAt10),
			evictionPrecision: measured.length === 0 ? 1 : meanOf((metrics) => metrics.evictionPrecision),
			tokensEvicted: meanOf((metrics) => metrics.tokensEvicted),
			recallTokens: meanOf((metrics) => metrics.recallTokens),
			coldPrefixTokens: meanOf((metrics) => metrics.coldPrefixTokens),
			summaryColdPrefixTokens: meanOf((metrics) => metrics.summaryColdPrefixTokens),
			cacheMissTokens: meanOf((metrics) => metrics.cacheMissTokens),
			cacheMissPerEvent: meanOf((metrics) => metrics.cacheMissPerEvent),
			evictionEvents: meanOf((metrics) => metrics.evictionEvents),
			checkpoints: meanOf((metrics) => metrics.checkpoints),
			overflowReductions: meanOf((metrics) => metrics.overflowReductions),
			// Event-pooled: zero-event traces must not dilute the saturation rate.
			saturatedEvents: safeFraction(saturatedEvents, totalEvents, 0),
			turnsToFirstSummary: firstSummaries.length === 0 ? null : mean(firstSummaries),
			summaries: meanOf((metrics) => metrics.summaries),
		},
		turnsToFirstSummaryCount: firstSummaries.length,
		pooledRetention: safeFraction(sum("retainedPairs"), sum("pairs"), 1),
		pooledRetentionCovered: safeFraction(sum("coveredRetainedPairs"), sum("pairs"), 1),
		pooledRetentionAt10: safeFraction(sum("retainedPairsAt10"), sum("pairsAt10"), 1),
		byReason,
	};
}
