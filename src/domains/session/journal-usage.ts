import type { ResponseModelIdObservation } from "../../core/response-model-id.js";
import { attributedModelId } from "../../core/response-model-id.js";
import type { AgentRole } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { FactSum } from "../../core/telemetry/fact.js";
import type { CostAggregate } from "../telemetry/cost.js";
import type { FoldedAttempt } from "../telemetry/folds.js";
import { foldCallJournal, foldCalls } from "../telemetry/folds.js";
import type { LedgerUsageCall } from "./usage.js";

const known = (sum: FactSum) => sum.measured + sum.estimated;

/** A report spanning parent and child sessions counts a shared attempt once (#434). */
export function uniqueUsageCalls(calls: readonly LedgerUsageCall[]): LedgerUsageCall[] {
	const canonical = new Set(calls.filter((call) => call.attemptId).map((call) => call.callId));
	const unique = new Map<string | LedgerUsageCall, LedgerUsageCall>();
	for (const call of calls) {
		if (call.callId && !call.attemptId && canonical.has(call.callId)) continue;
		const key = call.attemptId ?? call.callId ?? call.runId ?? call;
		const prior = unique.get(key);
		// A frozen ancestor cut may contain only the start; a later owner snapshot can contain its settlement (#434).
		if (
			!prior ||
			((prior.facts?.incomplete ?? 0) > 0 && call.facts?.incomplete === 0) ||
			(call.runId && (call.runCutoff ?? 0) > (prior.runCutoff ?? 0))
		)
			unique.set(key, call);
	}
	return [...unique.values()];
}

/** Compatibility projection for existing consumers. All arithmetic and coverage come from the journal fold (#434). */
export function usageCallsFromJournal(
	records: Iterable<TelemetryRecord>,
	callIds?: ReadonlySet<string>,
): LedgerUsageCall[] {
	const rows = [...records];
	const outcomes = new Map<string, NonNullable<LedgerUsageCall["compactionOutcome"]>>();
	for (const row of rows) {
		if (row.k !== "compaction.settled") continue;
		for (const id of row.data.callIds) {
			const previous = outcomes.get(id);
			outcomes.set(id, previous !== undefined && previous !== row.data.outcome ? "unknown" : row.data.outcome);
		}
	}
	// A completed provider call can still fail to produce a checkpoint; absence alone proves neither outcome (#434).
	return foldCallJournal(rows, callIds).attempts.flatMap((attempt) =>
		usageCallsFromAttempts([attempt]).map((call) =>
			attempt.agent.role === "compaction"
				? { ...call, compactionOutcome: outcomes.get(attempt.started.callId) ?? "unknown" }
				: call,
		),
	);
}

/** Live settlement and durable replay share the same projection (#434). */
export function usageCallsFromAttempts(
	attempts: readonly Pick<FoldedAttempt, "started" | "settled">[],
): LedgerUsageCall[] {
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
			calls: settled === null ? 0 : 1,
			...(settled === null ? { unknownCallCoverageRuns: 1 } : {}),
		};
		return [
			{
				callId: started.callId,
				attemptId: started.attemptId,
				...(settled
					? {
							callOutcome:
								settled.stop.reason === "error" || settled.stop.reason === "aborted"
									? settled.stop.reason
									: ("success" as const),
						}
					: {}),
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
			},
		];
	});
}

/** Agent roles whose journal owns usage even without a transcript or checkpoint row (#434). */
export function journalOwnsSideUsage(role: AgentRole): boolean {
	return (
		role === "btw" ||
		role === "helper" ||
		role === "handoff" ||
		role === "prewarm" ||
		role === "system-one" ||
		role === "safety-judge" ||
		role === "memory" ||
		role === "compaction"
	);
}

/** Side calls have no transcript row; choose attempts by settlement UTC while retaining their start facts (#434). */
export function journalUsageWindow(records: readonly TelemetryRecord[], from: number, to: number): TelemetryRecord[] {
	const selected = new Map<string, boolean>();
	for (const row of records) {
		if ((row.k !== "call.started" && row.k !== "call.settled") || !journalOwnsSideUsage(row.ctx.agent.role)) continue;
		if (row.k === "call.settled" || !selected.has(row.data.attemptId)) {
			const t = Date.parse(row.t);
			selected.set(row.data.attemptId, t >= from && t <= to);
		}
	}
	return records.filter(
		(row) =>
			(row.k !== "call.started" && row.k !== "call.settled") ||
			!journalOwnsSideUsage(row.ctx.agent.role) ||
			selected.get(row.data.attemptId),
	);
}
