/** Preserve spending from summary streams that did not produce a checkpoint. */

import type { FactSum } from "../../core/telemetry/fact.js";
import type { CostProvenance } from "../providers/index.js";
import type { CompactionCallObservation } from "../session/compaction/compact.js";
import { extractReasoningTokens } from "../session/context-accounting.js";
import type { LedgerUsageCall } from "../session/usage.js";
import type { BackgroundMemoryUsageSink } from "./background-memory-usage.js";
import { appendOutOfTurnUsageRow, type OutOfTurnUsage, type OutOfTurnUsageRow } from "./out-of-turn-usage.js";

export interface CompactionUsageOrigin {
	sessionId?: string;
	stateDir: string;
	repoIdentity: string;
	target: string;
	model: string;
}

/** Failed adapter zeros cannot distinguish absent usage from a reported zero. */
function observedUsage(call: CompactionCallObservation): OutOfTurnUsage & { costProvenance: CostProvenance } {
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
		...(raw.cacheWrite1h === undefined ? {} : { cacheWrite1h: reading(raw.cacheWrite1h) }),
		reasoning: reasoning !== null && reasoning > 0 ? reasoning : null,
		totalTokens: reading(raw.totalTokens),
		costUsd,
		costProvenance: costUsd === null ? "unknown" : "estimated",
	};
}

/**
 * Legacy clients without a journal retain usage when no checkpoint exists.
 * Journaled observations already have one durable owner and never write here (#434).
 * Missing legacy amounts remain null on disk; live counters are known subtotals.
 */
export function recordFailedCompactionCalls(
	origin: CompactionUsageOrigin,
	calls: ReadonlyArray<CompactionCallObservation>,
	observability?: BackgroundMemoryUsageSink,
): void {
	for (const call of calls) {
		if (call.callId) continue;
		const usage = observedUsage(call);
		const row: OutOfTurnUsageRow = {
			label: "failed-compaction",
			...(origin.sessionId === undefined ? {} : { sessionId: origin.sessionId }),
			callOutcome: call.outcome,
			...(call.failure === undefined ? {} : { failure: call.failure }),
			repoIdentity: origin.repoIdentity,
			timestamp: call.timestamp,
			target: origin.target,
			attributedModelId: origin.model,
			usage,
		};
		appendOutOfTurnUsageRow(origin.stateDir, row, { required: true });
		if (call.failure?.invoked !== false)
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
					...(typeof usage.cacheWrite1h === "number" ? { cacheWrite1h: usage.cacheWrite1h } : {}),
					reasoningTokens: usage.reasoning ?? 0,
					totalTokens: usage.totalTokens ?? 0,
					apiCalls: 1,
					...(usage.totalTokens === null ? { missingTokenCalls: 1 } : {}),
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

type CompactionUsageObservation = Pick<OutOfTurnUsageRow, "label" | "callOutcome" | "failure" | "usage"> & {
	unknownUsageFields?: readonly UsageField[];
};

/** Compatibility reporting shape only; journal projections never write a second usage store (#434). */
export function failedCompactionUsageFromCalls(calls: readonly LedgerUsageCall[]): CompactionUsageObservation[] {
	return calls.flatMap((call) => {
		if (call.label !== "failed-compaction" || !call.callOutcome || !call.facts) return [];
		const facts = call.facts;
		const fields: Record<UsageField, FactSum> = {
			input: facts.usage.input,
			output: facts.usage.output,
			cacheRead: facts.usage.cacheRead,
			cacheWrite: facts.usage.cacheWrite,
			reasoning: facts.usage.reasoning,
			totalTokens: facts.totalTokens,
			costUsd: facts.usd,
		};
		const known = (sum: FactSum): number | null =>
			sum.coverage.measured + sum.coverage.estimated > 0 ? sum.measured + sum.estimated : null;
		return [
			{
				label: "failed-compaction" as const,
				callOutcome: call.callOutcome,
				usage: {
					input: known(fields.input),
					output: known(fields.output),
					cacheRead: known(fields.cacheRead),
					cacheWrite: known(fields.cacheWrite),
					reasoning: known(fields.reasoning),
					totalTokens: known(fields.totalTokens),
					costUsd: known(fields.costUsd),
					...(call.costProvenance ? { costProvenance: call.costProvenance } : {}),
				},
				unknownUsageFields: USAGE_FIELDS.filter((field) => fields[field].unknownCount > 0),
			},
		];
	});
}

/** Known subtotals and missing-field coverage; zero missing values are never inferred. */
export function summarizeFailedCompactionUsage(rows: ReadonlyArray<CompactionUsageObservation>) {
	// #430: a compaction cancelled before its request left the process is not a
	// stream, and its null fields are not missing usage.
	const calls = rows.filter((row) => row.label === "failed-compaction" && row.failure?.invoked !== false);
	const knownUsage = Object.fromEntries(USAGE_FIELDS.map((field) => [field, null])) as Record<UsageField, number | null>;
	const erroredKnownUsage = { ...knownUsage };
	const unobservedUsageCalls = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])) as Record<UsageField, number>;
	for (const row of calls) {
		for (const field of USAGE_FIELDS) {
			const value = row.usage[field];
			if (value === null || row.unknownUsageFields?.includes(field)) unobservedUsageCalls[field] += 1;
			if (value !== null) {
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
