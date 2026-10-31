import type { ResponseModelIdObservation } from "../../core/response-model-id.js";
import { attributedModelId } from "../../core/response-model-id.js";
import type { AgentRole } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { FoldedAttempt } from "../telemetry/folds.js";
import { foldCallJournal, foldCalls } from "../telemetry/folds.js";
import type { LedgerUsageCall } from "./usage.js";

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

/** Each attempt as the journal fold states it; all arithmetic and coverage come from the fold (#434). */
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
				usageFacts: facts.usage,
				providerId: target.targetId,
				requestedModelId: target.requestedModel,
				attributedModelId: attributedModelId(responseModelIdObservation, target.requestedModel, null),
				responseModelIdObservation,
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
