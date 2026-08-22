import { covers, type PathIndex, type PathObservation } from "../path-index.js";
import type { ReferenceGraph } from "./reference-graph.js";
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
	/** Tokens freed by evicting items a later turn referenced again: the re-discovery bill a perfect recall would pay. */
	recallTokens: number;
	/** Sum over events of the projected tokens after the earliest evicted position: exact-prefix cache re-prefill cost. */
	coldPrefixTokens: number;
	evictionEvents: number;
	/** Fraction of applied events that exhausted the policy's usable candidates. */
	saturatedEvents: number;
	turnsToFirstSummary: number | null;
	/** Summary compactions the modeled summary stage applied; what a policy exists to make rare. */
	summaries: number;
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
}

interface MeasuredTrace {
	metrics: ReplayMetrics;
	pairs: number;
	retainedPairs: number;
	coveredRetainedPairs: number;
	pairsAt10: number;
	retainedPairsAt10: number;
	saturatedEventCount: number;
}

function safeFraction(numerator: number, denominator: number, empty: number): number {
	return denominator === 0 ? empty : numerator / denominator;
}

function survivesThrough(
	observation: PathObservation,
	referenceTurn: number,
	evictedAtTurn: ReadonlyMap<string, number>,
): boolean {
	const evictedAt = evictedAtTurn.get(observation.ref.entry);
	return evictedAt === undefined || evictedAt > referenceTurn;
}

function hasSurvivingCoveringRead(input: ReplayMeasurement, ref: string, referenceTurn: number): boolean {
	const original = input.index.byRef.get(ref);
	if (original?.op !== "read" || original.path.length === 0) return false;
	return (input.index.byPath.get(original.path) ?? []).some(
		(later) =>
			later.op === "read" &&
			!later.isError &&
			later.entryIndex > original.entryIndex &&
			later.turnIndex < referenceTurn &&
			covers(later.range, original.range) &&
			survivesThrough(later, referenceTurn, input.replay.evictedAtTurn),
	);
}

function measure(input: ReplayMeasurement): MeasuredTrace {
	let pairs = 0;
	let retainedPairs = 0;
	let coveredRetainedPairs = 0;
	let pairsAt10 = 0;
	let retainedPairsAt10 = 0;
	for (const [ref, futureTurns] of input.graph.futureTurnsOf) {
		const observationTurn = input.index.byRef.get(ref)?.turnIndex;
		const evictedAt = input.replay.evictedAtTurn.get(ref);
		for (const referenceTurn of futureTurns) {
			pairs += 1;
			const retained = evictedAt === undefined || evictedAt > referenceTurn;
			if (retained) retainedPairs += 1;
			if (retained || hasSurvivingCoveringRead(input, ref, referenceTurn)) coveredRetainedPairs += 1;
			if (observationTurn !== undefined && referenceTurn - observationTurn <= 10) {
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
	for (const event of input.replay.events) {
		if (event.saturated) saturatedEventCount += 1;
		coldPrefixTokens += event.coldPrefixTokens;
		for (const item of event.items) {
			evictedItems += 1;
			tokensEvicted += item.tokensFreed;
			const future = input.graph.futureTurnsOf.get(item.ref.entry) ?? [];
			if (!future.some((turn) => turn > event.turnIndex)) safelyEvictedItems += 1;
			else recallTokens += item.tokensFreed;
		}
	}

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
			evictionEvents: input.replay.events.length,
			saturatedEvents: safeFraction(saturatedEventCount, input.replay.events.length, 0),
			turnsToFirstSummary: input.replay.turnsToFirstSummary,
			summaries: input.replay.summaries,
		},
		pairs,
		retainedPairs,
		coveredRetainedPairs,
		pairsAt10,
		retainedPairsAt10,
		saturatedEventCount,
	};
}

export function measureReplayTrace(input: ReplayMeasurement): ReplayMetrics {
	return measure(input).metrics;
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
	return {
		mean: {
			traces: measured.length,
			retention: measured.length === 0 ? 1 : mean(measured.map((entry) => entry.metrics.retention)),
			retentionCovered: measured.length === 0 ? 1 : mean(measured.map((entry) => entry.metrics.retentionCovered)),
			retentionAt10: measured.length === 0 ? 1 : mean(measured.map((entry) => entry.metrics.retentionAt10)),
			evictionPrecision: measured.length === 0 ? 1 : mean(measured.map((entry) => entry.metrics.evictionPrecision)),
			tokensEvicted: mean(measured.map((entry) => entry.metrics.tokensEvicted)),
			recallTokens: mean(measured.map((entry) => entry.metrics.recallTokens)),
			coldPrefixTokens: mean(measured.map((entry) => entry.metrics.coldPrefixTokens)),
			evictionEvents: mean(measured.map((entry) => entry.metrics.evictionEvents)),
			// Event-pooled: zero-event traces must not dilute the saturation rate.
			saturatedEvents: safeFraction(saturatedEvents, totalEvents, 0),
			turnsToFirstSummary: firstSummaries.length === 0 ? null : mean(firstSummaries),
			summaries: mean(measured.map((entry) => entry.metrics.summaries)),
		},
		turnsToFirstSummaryCount: firstSummaries.length,
		pooledRetention: safeFraction(sum("retainedPairs"), sum("pairs"), 1),
		pooledRetentionCovered: safeFraction(sum("coveredRetainedPairs"), sum("pairs"), 1),
		pooledRetentionAt10: safeFraction(sum("retainedPairsAt10"), sum("pairsAt10"), 1),
	};
}
