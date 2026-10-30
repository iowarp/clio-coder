import { runUsageFromCallRecords } from "../dispatch/run-call-usage.js";
import type { SessionCallJournalRead } from "./fork-journal.js";
import type { LedgerUsageCall } from "./usage.js";

/** A referenced worker is one replaceable run contribution, including aggregate-only external peers (#434). */
export function usageCallsFromRunJournals(runs: Readonly<SessionCallJournalRead["runs"]>): LedgerUsageCall[] {
	return [...runs.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([runId, journal]) => {
			const records = journal.records.map(({ record }) => record);
			const usage = runUsageFromCallRecords(records);
			const source = records.find(
				(record) => record.k === "run.usage" || record.k === "call.started" || record.k === "call.settled",
			);
			const target =
				source && (source.k === "run.usage" || source.k === "call.started" || source.k === "call.settled")
					? source.data.target
					: undefined;
			const incomplete = !source || journal.skipped > 0 || journal.damaged > 0;
			return {
				runId,
				runCutoff: journal.throughMs,
				label: "worker",
				providerId: target?.targetId ?? "unknown",
				requestedModelId: target?.requestedModel ?? "unknown",
				attributedModelId: target?.requestedModel ?? "unknown",
				responseModelIdObservation: { state: "not-observed" },
				input: usage.inputTokens,
				output: usage.outputTokens,
				cacheRead: usage.cacheReadTokens,
				cacheWrite: usage.cacheWriteTokens,
				cacheWrite1h: usage.cacheWrite1hTokens,
				reasoningTokens: usage.reasoningTokens,
				totalTokens: usage.totalTokens,
				apiCalls: usage.apiCalls,
				missingTokenCalls: usage.missingTokenCalls,
				costUsd: usage.costUsd,
				costSummary: incomplete
					? { ...usage.costSummary, hasUnknown: true, allKnownFree: false, unknownCallCoverageRuns: 1 }
					: usage.costSummary,
				costProvenance: incomplete ? "unknown" : usage.costProvenance,
			};
		});
}
