import type { ResponseModelIdObservation } from "../../core/response-model-id.js";
import { attributedModelId } from "../../core/response-model-id.js";
import type { CallLabel } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import type { CostAggregate, CostEntryLabel } from "../observability/cost.js";
import type { FoldedAttempt } from "../observability/folds.js";
import { foldCallJournal, foldCalls } from "../observability/folds.js";
import type { LedgerUsageCall } from "./usage.js";

const labels: Record<CallLabel, CostEntryLabel | undefined> = {
	main: undefined,
	worker: "worker",
	compaction: "compaction",
	memory: "background-memory",
	"system-one": "system-one",
	prewarm: "prewarm",
	btw: "side-question",
	handoff: "handoff",
	helper: "helper",
	"safety-judge": "safety-judge",
};
const known = (sum: FactSum) => sum.measured + sum.estimated;

/** Compatibility projection for existing consumers. All arithmetic and coverage come from the journal fold (#434). */
export function usageCallsFromJournal(
	records: Iterable<TelemetryRecord>,
	callIds?: ReadonlySet<string>,
): LedgerUsageCall[] {
	return usageCallsFromAttempts(foldCallJournal(records, callIds).attempts);
}

/** Live settlement and durable replay share the same projection (#434). */
export function usageCallsFromAttempts(attempts: readonly FoldedAttempt[]): LedgerUsageCall[] {
	return attempts.flatMap((attempt) => {
		const { started, settled } = attempt;
		if (settled?.disposition === "never_sent") return [];
		const facts = foldCalls([attempt]);
		const target = settled?.target ?? started.target;
		const model = target.reportedModel;
		const responseModelIdObservation: ResponseModelIdObservation =
			model.kind === "measured"
				? { state: "reported", reportedModelId: model.value }
				: model.kind === "unknown" && model.reason === "provider-omitted"
					? { state: "not-reported" }
					: { state: "not-observed" };
		const costSummary: CostAggregate = {
			knownUsd: known(facts.usd),
			hasEstimated: facts.usd.coverage.estimated > 0,
			hasUnknown: facts.usd.unknownCount > 0,
			allKnownFree: settled?.pricing.pricedBy === "free",
			calls: facts.attempts,
		};
		const label = labels[started.label];
		return [
			{
				callId: started.callId,
				attemptId: started.attemptId,
				facts,
				providerId: target.targetId,
				requestedModelId: target.requestedModel,
				attributedModelId: attributedModelId(responseModelIdObservation, target.requestedModel, null),
				responseModelIdObservation,
				input: known(facts.usage.input),
				output: known(facts.usage.output),
				cacheRead: known(facts.usage.cacheRead),
				cacheWrite: known(facts.usage.cacheWrite),
				...(facts.usage.cacheWrite1h.coverage.measured > 0 || facts.usage.cacheWrite1h.coverage.estimated > 0
					? { cacheWrite1h: known(facts.usage.cacheWrite1h) }
					: {}),
				reasoningTokens: known(facts.usage.reasoning),
				totalTokens: known(facts.totalTokens),
				// An unclosed attempt establishes no invocation count; facts.incomplete retains that gap (#434).
				apiCalls: settled === null ? 0 : 1,
				missingTokenCalls: settled === null ? 0 : facts.totalTokens.unknownCount,
				costUsd: costSummary.knownUsd,
				costSummary,
				costProvenance: costSummary.hasUnknown
					? "unknown"
					: costSummary.hasEstimated
						? "estimated"
						: costSummary.allKnownFree
							? "known_free"
							: "known",
				...(label ? { label } : {}),
			},
		];
	});
}

/** Labels whose usage writer has moved from out-of-turn.jsonl to the call journal (#434). */
export function journalOwnsSideUsage(label: CallLabel): boolean {
	return (
		label === "btw" ||
		label === "helper" ||
		label === "handoff" ||
		label === "prewarm" ||
		label === "system-one" ||
		label === "safety-judge" ||
		label === "memory"
	);
}

/** Side calls have no transcript row; choose attempts by settlement UTC while retaining their start facts (#434). */
export function journalUsageWindow(records: readonly TelemetryRecord[], from: number, to: number): TelemetryRecord[] {
	const selected = new Map<string, boolean>();
	for (const row of records) {
		if ((row.k !== "call.started" && row.k !== "call.settled") || !journalOwnsSideUsage(row.data.label)) continue;
		if (row.k === "call.settled" || !selected.has(row.data.attemptId)) {
			const t = Date.parse(row.t);
			selected.set(row.data.attemptId, t >= from && t <= to);
		}
	}
	return records.filter(
		(row) =>
			(row.k !== "call.started" && row.k !== "call.settled") ||
			!journalOwnsSideUsage(row.data.label) ||
			selected.get(row.data.attemptId),
	);
}
