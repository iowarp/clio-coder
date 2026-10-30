import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { CallLabel } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord, readTelemetryRecord } from "../../core/telemetry/envelope.js";
import { newAttemptId, newCallId } from "../../core/telemetry/ids.js";
import type { CallStarted } from "../../core/telemetry/schemas.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../observability/call-facts.js";
import type { OutOfTurnUsageRow } from "../observability/out-of-turn-usage.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import type { SessionEntry } from "./entries.js";

export interface LegacyImport {
	records: TelemetryRecord[];
	/** Checkpoint aggregates: they summarize calls without naming them, so no call is invented for them. */
	aggregates: number;
	/** Rows whose rebuilt facts failed the current schema; counted, never repaired. */
	invalid: number;
}

const OUT_OF_TURN_LABELS: Partial<Record<OutOfTurnUsageRow["label"], CallLabel>> = {
	"side-question": "btw",
	handoff: "handoff",
	prewarm: "prewarm",
	"background-memory": "memory",
	"system-one": "system-one",
	"safety-judge": "safety-judge",
	"failed-compaction": "compaction",
	compaction: "compaction",
};

function provenance(value: unknown, fallback: CostProvenance): CostProvenance {
	return value === "known" || value === "known_free" || value === "estimated" || value === "unknown" ? value : fallback;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Rebuild call facts from a legacy session (#434). Each assistant message and each out-of-turn row becomes one call
 * through the same settlement mapping a live call uses, so a never-sent call carries no usage, a placeholder zero
 * stays unknown, and a cause comes only from the recorded closed failure class. Timing, transport and cache facts the
 * ledger never held stay unknown. The importer returns records and writes nothing: a live session directory keeps its
 * ledger, whose unlinked messages would otherwise count beside the imported calls.
 */
export function importLegacySession(
	sessionId: string,
	entries: readonly SessionEntry[],
	options: { outOfTurn?: readonly OutOfTurnUsageRow[]; costProvenance?: CostProvenance } = {},
): LegacyImport {
	const result: LegacyImport = { records: [], aggregates: 0, invalid: 0 };
	const fallback = options.costProvenance ?? "unknown";
	let target = "unknown";
	let model = "unknown";
	let userTurn: string | undefined;
	const add = (
		label: CallLabel,
		at: string,
		message: Record<string, unknown>,
		route: { targetId: string; api: string; model: string },
		turnId: string | undefined,
		responded = false,
	) => {
		const callId = newCallId();
		const attemptId = newAttemptId();
		const started: CallStarted = {
			callId,
			attemptId,
			attempt: 0,
			label,
			target: {
				targetId: route.targetId,
				runtimeId: "unknown",
				api: route.api,
				requestedModel: route.model,
				reportedModel: { kind: "unknown", reason: "legacy-record" },
			},
			roundKind: "unknown",
			toolChoice: "unknown",
		};
		const usage = message.usage as Record<string, unknown> | null | undefined;
		const settled = {
			...started,
			...callSettlementFromMessage(message, provenance(usage?.costProvenance, fallback), undefined, responded),
			target: { ...started.target, reportedModel: reportedModelFromMessage(message) },
			stages: { settle: null },
		};
		const ctx: TelemetryContext = { sessionId, label, callId, attemptId, ...(turnId ? { turnId } : {}) };
		const time = Date.parse(at);
		const clock = { t: new Date(Number.isFinite(time) ? time : 0).toISOString(), mono: 0 };
		for (const record of [
			makeTelemetryRecord("call.started", started, ctx, clock),
			makeTelemetryRecord("call.settled", settled, ctx, clock),
		]) {
			if (readTelemetryRecord(record).kind === "record") result.records.push(record);
			else result.invalid += 1;
		}
	};
	for (const entry of entries) {
		if (entry.kind === "compactionSummary") {
			if (entry.usage) result.aggregates += 1;
			continue;
		}
		if (entry.kind === "modelChange") {
			const change = entry as { target?: unknown; provider?: unknown; modelId?: unknown };
			target = text(change.target) ?? text(change.provider) ?? target;
			model = text(change.modelId) ?? model;
			continue;
		}
		if (entry.kind !== "message") continue;
		if (entry.role === "user") userTurn = entry.turnId;
		if (entry.role !== "assistant" || !entry.payload || typeof entry.payload !== "object") continue;
		const payload = entry.payload as Record<string, unknown>;
		const usage = payload.usage as Record<string, unknown> | null | undefined;
		add(
			"main",
			entry.timestamp,
			payload,
			{
				targetId: text(usage?.targetId) ?? target,
				api: text(payload.api) ?? "unknown",
				model: model !== "unknown" ? model : (text(payload.model) ?? "unknown"),
			},
			userTurn,
		);
	}
	for (const row of options.outOfTurn ?? []) {
		if (row.sessionId !== sessionId) continue;
		// An error row that recorded provider counts was billed for them, and legacy accounting counted that spend.
		// Its zeros may only mark where the stream stopped, so they stay unknown rather than measured zero (#434).
		const responded =
			row.callOutcome === "error" &&
			[row.usage.input, row.usage.output, row.usage.cacheRead, row.usage.cacheWrite, row.usage.totalTokens].some(
				(count) => typeof count === "number" && count > 0,
			);
		const count = (value: number | null | undefined) => (responded && value === 0 ? null : value);
		const usage = {
			...row.usage,
			input: count(row.usage.input),
			output: count(row.usage.output),
			cacheRead: count(row.usage.cacheRead),
			cacheWrite: count(row.usage.cacheWrite),
			cacheWrite1h: count(row.usage.cacheWrite1h),
			reasoning: count(row.usage.reasoning),
		};
		add(
			OUT_OF_TURN_LABELS[row.label] ?? "helper",
			row.timestamp,
			{
				stopReason: row.callOutcome === "aborted" ? "aborted" : row.callOutcome === "error" ? "error" : "stop",
				...(row.failure ? { failure: row.failure } : {}),
				usage: {
					...usage,
					cost: { total: usage.costUsd },
					...(usage.totalTokens === null ? { estimated: true } : {}),
				},
			},
			{ targetId: row.target, api: "unknown", model: row.attributedModelId },
			undefined,
			responded,
		);
	}
	return result;
}
