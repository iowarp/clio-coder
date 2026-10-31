import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { CallLabel } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord, readTelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact } from "../../core/telemetry/fact.js";
import { derivedTelemetryIds, newAttemptId, newCallId } from "../../core/telemetry/ids.js";
import type { CallStarted, CallUsage, RunUsage } from "../../core/telemetry/schemas.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../telemetry/call-facts.js";
import type { OutOfTurnUsageRow } from "../telemetry/out-of-turn-usage.js";
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
	options: {
		outOfTurn?: readonly OutOfTurnUsageRow[];
		costProvenance?: CostProvenance;
		/**
		 * `derived` keys each call, attempt and record id on the ledger entry's own id (an out-of-turn row on its session,
		 * time, label and ordinal), so a read model that imports on every read hands out references that stay valid
		 * (#434). `minted` (the default) is the one-shot export.
		 */
		ids?: "minted" | "derived";
	} = {},
): LegacyImport {
	const result: LegacyImport = { records: [], aggregates: 0, invalid: 0 };
	// A ledger from before cost provenance (pre-0.2.9) stored only the cost Clio derived from catalog rates: a nonzero one
	// reads as estimated, as 0.6.5 read it, and a placeholder zero stays unknown (#434).
	const fallback = (usd: unknown): CostProvenance =>
		options.costProvenance ?? (typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? "estimated" : "unknown");
	let target = "unknown";
	let model = "unknown";
	let userTurn: string | undefined;
	const add = (
		label: CallLabel,
		at: string,
		message: Record<string, unknown>,
		route: { targetId: string; api: string; model: string },
		turnId: string | undefined,
		seed: string,
	) => {
		const time = Date.parse(at);
		const derived = options.ids === "derived" ? derivedTelemetryIds(seed, Number.isFinite(time) ? time : 0) : undefined;
		const callId = derived?.callId ?? newCallId();
		const attemptId = derived?.attemptId ?? newAttemptId();
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
			...callSettlementFromMessage(
				message,
				provenance(usage?.costProvenance, fallback((usage?.cost as { total?: unknown } | undefined)?.total)),
			),
			target: { ...started.target, reportedModel: reportedModelFromMessage(message) },
			stages: { settle: null },
		};
		const ctx: TelemetryContext = { sessionId, label, callId, attemptId, ...(turnId ? { turnId } : {}) };
		const clock = { t: new Date(Number.isFinite(time) ? time : 0).toISOString(), mono: 0 };
		const startedRecord = makeTelemetryRecord("call.started", started, ctx, clock);
		const settledRecord = makeTelemetryRecord("call.settled", settled, ctx, clock);
		if (derived) {
			startedRecord.id = derived.startedRecordId;
			settledRecord.id = derived.settledRecordId;
		}
		for (const record of [startedRecord, settledRecord]) {
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
			`ledger\0${entry.turnId}`,
		);
	}
	const ordinals = new Map<string, number>();
	for (const row of options.outOfTurn ?? []) {
		if (row.sessionId !== sessionId) continue;
		// An error row's recorded counts and cost follow the live rule: kept as a lower bound on an unsettled call (#434).
		const usage = row.usage as unknown as Record<string, unknown>;
		const key = `out-of-turn\0${sessionId}\0${row.timestamp}\0${row.label}`;
		const ordinal = ordinals.get(key) ?? 0;
		ordinals.set(key, ordinal + 1);
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
			`${key}\0${ordinal}`,
		);
	}
	return result;
}

const legacyUnknown = { kind: "unknown", reason: "legacy-record" } as const;

function receiptCount(value: unknown): Fact<number> {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? { kind: "measured", value, source: "provider" }
		: legacyUnknown;
}

function receiptPricing(raw: Record<string, unknown>): Pick<RunUsage, "pricing" | "pricingCoverage"> {
	const summary =
		raw.costSummary && typeof raw.costSummary === "object" ? (raw.costSummary as Record<string, unknown>) : null;
	const external = (raw.externalTelemetry ?? {}) as Record<string, unknown>;
	const costProvenance = provenance(raw.costProvenance, "unknown");
	if (costProvenance === "known_free" || summary?.allKnownFree === true)
		return {
			pricing: { usd: { kind: "measured", value: 0, source: "local-count" }, pricedBy: "free" },
			pricingCoverage: "complete",
		};
	const amount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
	// A host that met an unpriced call sealed `unknown` provenance over its priced subtotal; the summary keeps it.
	const usd = summary ? amount(summary.knownUsd) : costProvenance === "unknown" ? null : amount(raw.costUsd);
	const hasUnknown = summary?.hasUnknown === true;
	if (usd === null || (hasUnknown && usd === 0))
		return { pricing: { usd: legacyUnknown, pricedBy: "none" }, pricingCoverage: "unknown" };
	const pricingCoverage = hasUnknown ? "partial" : "complete";
	if (summary ? summary.hasEstimated === true : costProvenance === "estimated")
		return {
			pricing: { usd: { kind: "estimated", value: usd, method: "catalog" }, pricedBy: "catalog" },
			pricingCoverage,
		};
	if (external.cost === "provider-reported")
		return {
			pricing: { usd: { kind: "measured", value: usd, source: "provider" }, pricedBy: "provider" },
			pricingCoverage,
		};
	return {
		pricing: { usd: { kind: "measured", value: usd, source: "local-count" }, pricedBy: "target-rates" },
		pricingCoverage,
	};
}

/**
 * A sealed receipt whose run left no journal, written before run journals existed or after retention pruned one,
 * keeps its known totals (#434). Its sealed token counts and USD become one `legacy-import` snapshot of the run. A
 * receipt never shows which calls it folded, so its call counts stay unknown coverage and a sum over it reads as a
 * lower bound. Null when the value is not a receipt for this run.
 */
/**
 * What a receipt's seal says about its totals: `verified` and `legacy` (a retired seal or none, which this build cannot
 * check) import as recorded; a current seal that `failed` keeps only the target, its counts and cost unknown (#434).
 */
export type LegacyReceiptSeal = "verified" | "legacy" | "failed";

export function importLegacyReceipt(runId: string, value: unknown, seal: LegacyReceiptSeal): TelemetryRecord | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const endedAt = typeof raw.endedAt === "string" ? Date.parse(raw.endedAt) : Number.NaN;
	if (raw.runId !== runId || !Number.isFinite(endedAt)) return null;
	const external = raw.externalTelemetry;
	const trusted = seal !== "failed";
	const verified =
		trusted &&
		(!external ||
			typeof external !== "object" ||
			(external as Record<string, unknown>).tokenUsage === "provider-reported");
	const token = (field: unknown) => (verified ? receiptCount(field) : legacyUnknown);
	const usage: CallUsage = {
		input: token(raw.inputTokenCount),
		output: token(raw.outputTokenCount),
		cacheRead: token(raw.cacheReadTokenCount),
		cacheWrite: token(raw.cacheWriteTokenCount),
		cacheWrite1h: token(raw.cacheWrite1hTokenCount),
		reasoning: token(raw.reasoningTokenCount),
	};
	const missingTokenCalls = trusted ? receiptCount(raw.missingTokenCalls) : legacyUnknown;
	const data: RunUsage = {
		source: "legacy-import",
		scope: "run",
		revision: 0,
		coverage: !verified
			? "unknown"
			: missingTokenCalls.kind === "measured" && missingTokenCalls.value === 0
				? "complete"
				: "partial",
		callCountCoverage: "unknown",
		...(trusted
			? receiptPricing(raw)
			: { pricing: { usd: legacyUnknown, pricedBy: "none" as const }, pricingCoverage: "unknown" as const }),
		target: {
			targetId: text(raw.targetId) ?? "unknown",
			runtimeId: text(raw.runtimeId) ?? "unknown",
			api: "unknown",
			requestedModel: text(raw.wireModelId) ?? "unknown",
			reportedModel: legacyUnknown,
		},
		usage,
		totalTokens: token(raw.tokenCount),
		apiCalls: trusted ? receiptCount(raw.apiCalls) : legacyUnknown,
		missingTokenCalls,
	};
	const sessionId = text(raw.sessionId);
	const ctx: TelemetryContext = sessionId
		? { sessionId, runId, label: "worker" }
		: { sessionId: null, runId, label: "worker" };
	const usageRecord = makeTelemetryRecord("run.usage_reported", data, ctx, {
		t: new Date(endedAt).toISOString(),
		mono: 0,
	});
	usageRecord.id = derivedTelemetryIds(`receipt\0${runId}`, endedAt).usageRecordId;
	return readTelemetryRecord(usageRecord).kind === "record" ? usageRecord : null;
}
