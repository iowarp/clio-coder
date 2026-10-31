import type { WorkerTelemetryContext } from "../../core/telemetry/context.js";
import type { FailureCause } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../core/telemetry/envelope.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import { readWorkerTelemetryRecord } from "../../core/telemetry/forwarder.js";
import { abandonedSettlement } from "../../core/telemetry/producer.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import type { CostAggregate } from "../telemetry/cost.js";
import type { CallTotals } from "../telemetry/folds.js";
import { foldRunJournal } from "../telemetry/folds.js";

export interface RunCallUsage {
	callIds: string[];
	callFacts: CallTotals;
	usageFacts: CallTotals["usage"];
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
	const folded = foldRunJournal(records);
	const facts = folded;
	const apiCalls = subtotal(folded.apiCalls);
	const unknownCoverage = folded.unknownCoverage;
	const costSummary: CostAggregate = {
		knownUsd: subtotal(facts.usd),
		hasEstimated: facts.usd.coverage.estimated > 0,
		hasUnknown: facts.usd.unknownCount > 0 || folded.amountCoverageUnknown,
		allKnownFree: folded.allKnownFree,
		calls: apiCalls,
		...(unknownCoverage ? { unknownCallCoverageRuns: 1 } : {}),
	};
	return {
		callIds: [...new Set(folded.calls.attempts.map(({ started }) => started.callId))].sort(),
		callFacts: folded.calls.totals,
		usageFacts: folded.usage,
		apiCalls,
		missingTokenCalls: subtotal(folded.missingTokenCalls),
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
					: facts.usd.coverage.measured > 0
						? "known"
						: "unknown",
		tokenUsageMissing: facts.totalTokens.unknownCount > 0 || folded.amountCoverageUnknown,
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
			if (
				record.k !== "call.started" &&
				record.k !== "call.settled" &&
				record.k !== "run.usage_reported" &&
				record.k !== "journal.gap"
			)
				return true;
			records.push(record);
			snapshot = runUsageFromCallRecords(records);
			return true;
		},
		gap(count = 1): void {
			if (!snapshot || count < 1) return;
			records.push(
				makeTelemetryRecord("journal.gap", { sink: "worker-ndjson", reason: "writer-drop", count }, context, {
					t: new Date().toISOString(),
					mono: performance.now(),
				}),
			);
			snapshot = runUsageFromCallRecords(records);
		},
		/**
		 * Settle every attempt the worker started and never settled, once its stream has ended. A killed worker cannot
		 * settle its own, and the host cannot see its stages, so each reads as sent with its spend unknown (#434).
		 */
		settleOpen(cause: FailureCause): TelemetryRecord<"call.settled">[] {
			const settledAttempts = new Set(
				records.flatMap((record) => (record.k === "call.settled" ? [record.data.attemptId] : [])),
			);
			const open = new Map<string, TelemetryRecord<"call.started">>();
			for (const record of records)
				if (record.k === "call.started" && !settledAttempts.has(record.data.attemptId))
					open.set(record.data.attemptId, record);
			const settled = [...open.values()].map((started) =>
				makeTelemetryRecord(
					"call.settled",
					{ ...started.data, ...abandonedSettlement(true, cause), stages: { settle: null } },
					started.ctx,
					{ t: new Date().toISOString(), mono: performance.now() },
				),
			);
			if (settled.length === 0) return settled;
			records.push(...settled);
			snapshot = runUsageFromCallRecords(records);
			return settled;
		},
		snapshot: () => snapshot,
	};
}
