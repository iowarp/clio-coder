import type { PathIndex } from "../path-index.js";
import type { ReferenceGraph } from "./reference-graph.js";
import type { ReplayTraceResult } from "./runner.js";
import type { Trace } from "./trace.js";

export interface ReplayMetrics {
	traces: number;
	retention: number;
	retentionAt10: number;
	evictionPrecision: number;
	tokensEvicted: number;
	evictionEvents: number;
	churn: number;
	turnsToFirstSummary: number | null;
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
	pooledRetentionAt10: number;
}

interface MeasuredTrace {
	metrics: ReplayMetrics;
	pairs: number;
	retainedPairs: number;
	pairsAt10: number;
	retainedPairsAt10: number;
}

function safeFraction(numerator: number, denominator: number, empty: number): number {
	return denominator === 0 ? empty : numerator / denominator;
}

function measure(input: ReplayMeasurement): MeasuredTrace {
	let pairs = 0;
	let retainedPairs = 0;
	let pairsAt10 = 0;
	let retainedPairsAt10 = 0;
	for (const [ref, futureTurns] of input.graph.futureTurnsOf) {
		const observationTurn = input.index.byRef.get(ref)?.turnIndex;
		const evictedAt = input.replay.evictedAtTurn.get(ref);
		for (const referenceTurn of futureTurns) {
			pairs += 1;
			const retained = evictedAt === undefined || evictedAt > referenceTurn;
			if (retained) retainedPairs += 1;
			if (observationTurn !== undefined && referenceTurn - observationTurn <= 10) {
				pairsAt10 += 1;
				if (retained) retainedPairsAt10 += 1;
			}
		}
	}

	let evictedItems = 0;
	let safelyEvictedItems = 0;
	let churnedItems = 0;
	let tokensEvicted = 0;
	for (const event of input.replay.events) {
		for (const item of event.items) {
			evictedItems += 1;
			tokensEvicted += item.tokensFreed;
			const future = input.graph.futureTurnsOf.get(item.ref.entry) ?? [];
			const referencedAfter = future.some((turn) => turn > event.turnIndex);
			if (referencedAfter) churnedItems += 1;
			else safelyEvictedItems += 1;
		}
	}

	return {
		metrics: {
			traces: 1,
			retention: safeFraction(retainedPairs, pairs, 1),
			retentionAt10: safeFraction(retainedPairsAt10, pairsAt10, 1),
			evictionPrecision: safeFraction(safelyEvictedItems, evictedItems, 1),
			tokensEvicted,
			evictionEvents: input.replay.events.length,
			churn: safeFraction(churnedItems, evictedItems, 0),
			turnsToFirstSummary: input.replay.turnsToFirstSummary,
		},
		pairs,
		retainedPairs,
		pairsAt10,
		retainedPairsAt10,
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
	const summaries = measured
		.map((entry) => entry.metrics.turnsToFirstSummary)
		.filter((value): value is number => value !== null);
	const sum = (field: "pairs" | "retainedPairs" | "pairsAt10" | "retainedPairsAt10"): number =>
		measured.reduce((total, entry) => total + entry[field], 0);
	return {
		mean: {
			traces: measured.length,
			retention: measured.length === 0 ? 1 : mean(measured.map((entry) => entry.metrics.retention)),
			retentionAt10: measured.length === 0 ? 1 : mean(measured.map((entry) => entry.metrics.retentionAt10)),
			evictionPrecision: measured.length === 0 ? 1 : mean(measured.map((entry) => entry.metrics.evictionPrecision)),
			tokensEvicted: mean(measured.map((entry) => entry.metrics.tokensEvicted)),
			evictionEvents: mean(measured.map((entry) => entry.metrics.evictionEvents)),
			churn: mean(measured.map((entry) => entry.metrics.churn)),
			turnsToFirstSummary: summaries.length === 0 ? null : mean(summaries),
		},
		turnsToFirstSummaryCount: summaries.length,
		pooledRetention: safeFraction(sum("retainedPairs"), sum("pairs"), 1),
		pooledRetentionAt10: safeFraction(sum("retainedPairsAt10"), sum("pairsAt10"), 1),
	};
}
