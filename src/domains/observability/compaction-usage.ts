/** Preserve spending from summary streams that did not produce a checkpoint. */

import type { CompactionCallObservation } from "../session/compaction/compact.js";
import { extractReasoningTokens } from "../session/context-accounting.js";
import type { BackgroundMemoryUsageSink } from "./background-memory-usage.js";
import { appendOutOfTurnUsageRow, type OutOfTurnUsage, type OutOfTurnUsageRow } from "./out-of-turn-usage.js";

export interface CompactionUsageOrigin {
	stateDir: string;
	sessionId: string;
	repoIdentity: string;
	target: string;
	model: string;
}

/** Failed adapter zeros cannot distinguish absent usage from a reported zero. */
function observedUsage(call: CompactionCallObservation): OutOfTurnUsage {
	const raw = isRecord(call.usage) ? call.usage : {};
	const reading = (value: unknown): number | null =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 && (call.outcome === "success" || value > 0)
			? value
			: null;
	const cost = isRecord(raw.cost) ? reading(raw.cost.total) : null;
	// Adapter cost is a price estimate, not independent provider billing evidence.
	const costUsd = cost !== null && cost > 0 ? cost : null;
	const reasoning = extractReasoningTokens({ ...raw, reasoningTokens: undefined });
	return {
		input: reading(raw.input),
		output: reading(raw.output),
		cacheRead: reading(raw.cacheRead),
		cacheWrite: reading(raw.cacheWrite),
		reasoning: reasoning !== null && reasoning > 0 ? reasoning : null,
		totalTokens: reading(raw.totalTokens),
		costUsd,
		costProvenance: costUsd === null ? "unknown" : "estimated",
	};
}

/**
 * The checkpoint is the sole accounting source on success. Call this only when
 * no checkpoint exists; each row is one actual stream invocation, not a retry.
 * Missing amounts remain null on disk. Numeric live counters are known subtotals.
 */
export function recordFailedCompactionCalls(
	origin: CompactionUsageOrigin,
	calls: ReadonlyArray<CompactionCallObservation>,
	observability?: BackgroundMemoryUsageSink,
): void {
	for (const call of calls) {
		const usage = observedUsage(call);
		const row: OutOfTurnUsageRow = {
			label: "failed-compaction",
			callOutcome: call.outcome,
			sessionId: origin.sessionId,
			repoIdentity: origin.repoIdentity,
			timestamp: call.timestamp,
			target: origin.target,
			attributedModelId: origin.model,
			usage,
			timing: { durationMs: call.durationMs },
		};
		appendOutOfTurnUsageRow(origin.stateDir, row, { required: true });
		// Do not create a measured-zero live entry for a wholly unobserved call.
		if (!Object.values(usage).some((value) => typeof value === "number" && value > 0)) continue;
		observability?.recordTokens(
			origin.target,
			origin.model,
			usage.totalTokens ?? 0,
			usage.costUsd ?? 0,
			{
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				reasoningTokens: usage.reasoning ?? 0,
				totalTokens: usage.totalTokens ?? 0,
				apiCalls: 1,
			},
			usage.costProvenance,
			undefined,
			"failed-compaction",
		);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "costUsd"] as const;
type UsageField = (typeof USAGE_FIELDS)[number];

/** Known subtotals and missing-field coverage; zero missing values are never inferred. */
export function summarizeFailedCompactionUsage(rows: ReadonlyArray<OutOfTurnUsageRow>) {
	const calls = rows.filter((row) => row.label === "failed-compaction");
	const knownUsage = Object.fromEntries(USAGE_FIELDS.map((field) => [field, null])) as Record<UsageField, number | null>;
	const erroredKnownUsage = { ...knownUsage };
	const unobservedUsageCalls = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])) as Record<UsageField, number>;
	for (const row of calls) {
		for (const field of USAGE_FIELDS) {
			const value = row.usage[field];
			if (value === null) unobservedUsageCalls[field] += 1;
			else {
				knownUsage[field] = (knownUsage[field] ?? 0) + value;
				if (row.callOutcome === "error") erroredKnownUsage[field] = (erroredKnownUsage[field] ?? 0) + value;
			}
		}
	}
	return {
		calls: calls.length,
		successfulCalls: calls.filter((row) => row.callOutcome === "success").length,
		erroredCalls: calls.filter((row) => row.callOutcome === "error").length,
		abortedCalls: calls.filter((row) => row.callOutcome === "aborted").length,
		knownUsage,
		erroredKnownUsage,
		unobservedUsageCalls,
	};
}
