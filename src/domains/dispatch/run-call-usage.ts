import type { WorkerTelemetryContext } from "../../core/telemetry/context.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../core/telemetry/envelope.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import { readWorkerTelemetryRecord } from "../../core/telemetry/forwarder.js";
import type { CostAggregate } from "../observability/cost.js";
import type { CallTotals } from "../observability/folds.js";
import { foldCallJournal } from "../observability/folds.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import { usageCallsFromAttempts } from "../session/journal-usage.js";

export interface RunCallUsage {
	callIds: string[];
	callFacts: CallTotals;
	apiCalls: number;
	missingTokenCalls: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite1hTokens: number;
	reasoningTokens: number;
	costUsd: number;
	costSummary: CostAggregate;
	costProvenance: CostProvenance;
	tokenUsageMissing: boolean;
}

const subtotal = (sum: FactSum) => sum.measured + sum.estimated;

/** Live meters and receipts project the same fold as session replay; unknown facts retain coverage (#434). */
export function runUsageFromCallRecords(records: Iterable<TelemetryRecord>): RunCallUsage {
	const folded = foldCallJournal(records);
	const facts = folded.totals;
	const calls = usageCallsFromAttempts(folded.attempts);
	const apiCalls = facts.settled + facts.settledNoUsage + facts.sentUnsettled;
	const unknownCoverage = facts.incomplete > 0 || folded.coverage.gapRecords > 0 || folded.unresolvedCallIds.length > 0;
	const costSummary: CostAggregate = {
		knownUsd: subtotal(facts.usd),
		hasEstimated: facts.usd.coverage.estimated > 0,
		hasUnknown: facts.usd.unknownCount > 0 || unknownCoverage,
		allKnownFree: calls.length > 0 && calls.every((call) => call.costSummary?.allKnownFree === true),
		calls: apiCalls,
		...(unknownCoverage ? { unknownCallCoverageRuns: 1 } : {}),
	};
	return {
		callIds: [...new Set(folded.attempts.map(({ started }) => started.callId))].sort(),
		callFacts: facts,
		apiCalls,
		missingTokenCalls: calls.reduce((sum, call) => sum + (call.missingTokenCalls ?? 0), 0),
		totalTokens: subtotal(facts.totalTokens),
		inputTokens: subtotal(facts.usage.input),
		outputTokens: subtotal(facts.usage.output),
		cacheReadTokens: subtotal(facts.usage.cacheRead),
		cacheWriteTokens: subtotal(facts.usage.cacheWrite),
		cacheWrite1hTokens: subtotal(facts.usage.cacheWrite1h),
		reasoningTokens: subtotal(facts.usage.reasoning),
		costUsd: costSummary.knownUsd,
		costSummary,
		costProvenance: costSummary.hasUnknown
			? "unknown"
			: costSummary.hasEstimated
				? "estimated"
				: costSummary.allKnownFree
					? "known_free"
					: apiCalls > 0
						? "known"
						: "unknown",
		tokenUsageMissing: facts.totalTokens.unknownCount > 0 || unknownCoverage,
	};
}

/** The receipt path drains this same stream before sealing; display replay never updates this projection (#434). */
export function createRunCallUsage(context: WorkerTelemetryContext) {
	const records: TelemetryRecord[] = [];
	let snapshot: RunCallUsage | undefined;
	return {
		observe(frame: unknown): boolean {
			const record = readWorkerTelemetryRecord(frame, context);
			if (!record) return false;
			if (record.k === "process.started") {
				snapshot ??= runUsageFromCallRecords(records);
				return true;
			}
			if (record.k !== "call.started" && record.k !== "call.settled" && record.k !== "gap") return true;
			records.push(record);
			snapshot = runUsageFromCallRecords(records);
			return true;
		},
		gap(count = 1): void {
			if (!snapshot || count < 1) return;
			records.push(
				makeTelemetryRecord("gap", { sink: "worker-ndjson", reason: "writer-drop", count }, context, {
					t: new Date().toISOString(),
					mono: performance.now(),
				}),
			);
			snapshot = runUsageFromCallRecords(records);
		},
		snapshot: () => snapshot,
	};
}
