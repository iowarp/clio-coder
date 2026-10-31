/**
 * Session accounting prefers linked call-journal facts, including retries. Old
 * ledger rows remain a compatibility input until explicitly imported (#434).
 * Model-change entries retain their attribution for that legacy path.
 */

import { messageUsageForAccounting } from "../../core/message-accounting.js";

import {
	attributedModelId,
	type ResponseModelIdObservation,
	responseModelIdObservationFromRecord,
} from "../../core/response-model-id.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Payload } from "../../core/telemetry/schemas.js";
import { normalizeTokenUsage } from "../../core/token-split.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import { resolveCostProvenance } from "../providers/types/cost-provenance.js";
import type { CostAggregate, CostEntryLabel } from "../telemetry/cost.js";
import type { CallTotals } from "../telemetry/folds.js";
import { foldCallJournal, foldCalls } from "../telemetry/folds.js";
import type { SessionEntry } from "./entries.js";
import { journalOwnsSideUsage, usageCallsFromJournal } from "./journal-usage.js";

/** One attempt projected from the journal, or a legacy ledger usage row (#434). */
export interface LedgerUsageCall {
	runId?: string;
	runJournalUnavailable?: boolean;
	/** Replay-only boundary for comparing a frozen fork prefix with the run owner's complete scope (#434). */
	runCutoff?: number;
	callId?: string;
	attemptId?: string;
	facts?: CallTotals;
	usageFacts?: CallTotals["usage"];
	tokenUsageMissing?: boolean;
	costSummary?: CostAggregate;
	callOutcome?: "success" | "error" | "aborted";
	compactionOutcome?: Payload<"compaction.closed">["outcome"] | "unknown";
	providerId: string;
	/** Model id the accounting row uses, or `unknown` when an observed response omitted it. */
	attributedModelId: string;
	/** The id the session asked for (the configured model, or the message's own `model`). */
	requestedModelId: string;
	/** Direct presence observation, with the pre-#193 difference-only shape labeled separately. */
	responseModelIdObservation: ResponseModelIdObservation;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
	/** API calls this row accounts for. Absent means one, which is every message row. */
	apiCalls?: number;
	missingTokenCalls?: number;
	label?: CostEntryLabel;
	costProvenance?: CostProvenance;
}

/** The target and model a session ran under before any modelChange row. */
export interface SessionUsageDefaults {
	journalDirectory?: string;
	target?: string | null;
	model?: string | null;
	sessionId?: string | null;
}

function numberAt(source: Record<string, unknown>, key: string): number {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringAt(source: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return null;
}

/**
 * One entry per completed assistant API call that carried provider usage.
 *
 * Attribution follows the live path, which records under the *target* id and
 * the wire model rather than the runtime name. Reading the runtime out of the
 * payload instead split one endpoint into two blocks in `/cost`, so a single
 * `node-a` target on `llamacpp` rendered as two providers whose turn counts
 * diverged with every resume. `modelChange` rows are replayed in order so a
 * session that switched targets mid-way attributes each call to the active
 * target.
 */
export function ledgerUsageCalls(
	entries: ReadonlyArray<SessionEntry>,
	defaults: SessionUsageDefaults = {},
	journal: ReadonlyArray<TelemetryRecord> = [],
): LedgerUsageCall[] {
	const calls: LedgerUsageCall[] = [];
	const journalCalls = new Map<string, LedgerUsageCall[]>();
	for (const row of journal)
		if (row.k === "call.started" || row.k === "call.settled") journalCalls.set(row.data.callId, []);
	for (const call of usageCallsFromJournal(journal)) {
		if (!call.callId) continue;
		const group = journalCalls.get(call.callId) ?? [];
		group.push(call);
		journalCalls.set(call.callId, group);
	}
	const projected = new Set<string>();
	let currentTarget = defaults.target ?? null;
	let currentModel = defaults.model ?? null;
	for (const entry of entries) {
		// Checkpoints link their calls; older checkpoints retain an aggregate fallback (#434).
		if (entry?.kind === "compactionSummary") {
			if (entry.callIds?.length && entry.callIds.every((id) => journalCalls.has(id))) {
				for (const id of entry.callIds) {
					if (!projected.has(id)) calls.push(...(journalCalls.get(id) ?? []));
					projected.add(id);
				}
				continue;
			}
			// If any referenced facts are missing, the legacy aggregate substitutes for the whole group (#434).
			for (const id of entry.callIds ?? []) projected.add(id);
			const usage = entry.usage;
			if (!usage) continue;
			calls.push({
				providerId: usage.targetId ?? currentTarget ?? "unknown",
				attributedModelId: usage.modelId ?? currentModel ?? "unknown",
				requestedModelId: usage.modelId ?? currentModel ?? "unknown",
				responseModelIdObservation: { state: "not-observed" },
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
				reasoningTokens: usage.reasoning,
				totalTokens: usage.totalTokens,
				costUsd: usage.cost.total,
				label: "compaction",
				...(usage.missingTokenCalls ? { missingTokenCalls: usage.missingTokenCalls } : {}),
				costProvenance: resolveCostProvenance(usage.costProvenance, usage.cost.total > 0 ? "estimated" : "unknown"),
				// A split turn runs two summarization streams under one entry; the
				// provider served that many calls even though one row records them.
				apiCalls: Math.max(1, Math.round(usage.apiCalls)),
			});
			continue;
		}
		if (entry?.kind === "modelChange") {
			const change = entry as { target?: unknown; modelId?: unknown; provider?: unknown };
			if (typeof change.target === "string" && change.target.length > 0) currentTarget = change.target;
			else if (typeof change.provider === "string" && change.provider.length > 0) currentTarget = change.provider;
			if (typeof change.modelId === "string" && change.modelId.length > 0) currentModel = change.modelId;
			continue;
		}
		if (entry?.kind !== "message" || entry.role !== "assistant") continue;
		const payload = entry.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
		const record = payload as Record<string, unknown>;
		if (typeof record.callId === "string" && journalCalls.has(record.callId)) {
			if (!projected.has(record.callId)) calls.push(...(journalCalls.get(record.callId) ?? []));
			projected.add(record.callId);
			continue;
		}
		const rawUsage = messageUsageForAccounting(record);
		if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
			if (
				typeof record.callId === "string" &&
				!projected.has(record.callId) &&
				record.callInvoked !== false &&
				(record.failure as { invoked?: boolean } | undefined)?.invoked !== false
			) {
				projected.add(record.callId);
				calls.push({
					callId: record.callId,
					providerId: currentTarget ?? stringAt(record, "provider", "api") ?? "unknown",
					requestedModelId: currentModel ?? stringAt(record, "model") ?? "unknown",
					attributedModelId: "unknown",
					responseModelIdObservation: { state: "not-observed" },
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					reasoningTokens: 0,
					totalTokens: 0,
					apiCalls: 0,
					missingTokenCalls: 0,
					costUsd: 0,
					costProvenance: "unknown",
					costSummary: {
						knownUsd: 0,
						hasEstimated: false,
						hasUnknown: true,
						allKnownFree: false,
						calls: 0,
						unknownCallCoverageRuns: 1,
					},
				});
			}
			continue;
		}
		const usage = rawUsage as Record<string, unknown>;
		if (usage.callInvoked === false || (record.failure as { invoked?: boolean } | undefined)?.invoked === false) continue;
		const { input, output, cacheRead, cacheWrite, totalTokens, reasoning, observed } = normalizeTokenUsage(usage);
		const cost = usage.cost;
		const costUsd =
			usage.estimated !== true && cost && typeof cost === "object"
				? numberAt(cost as Record<string, unknown>, "total")
				: 0;
		const requestedModelId = currentModel ?? stringAt(record, "model") ?? "unknown";
		const differingResponseModelId = stringAt(record, "responseModel");
		const responseModelIdObservation = responseModelIdObservationFromRecord(record, "legacy-difference-only");
		calls.push({
			...(typeof record.callId === "string" ? { callId: record.callId } : {}),
			providerId: stringAt(usage, "targetId") ?? currentTarget ?? stringAt(record, "provider", "api") ?? "unknown",
			attributedModelId: attributedModelId(responseModelIdObservation, requestedModelId, differingResponseModelId),
			requestedModelId,
			responseModelIdObservation,
			input,
			output,
			cacheRead,
			cacheWrite,
			...(typeof usage.cacheWrite1h === "number" ? { cacheWrite1h: numberAt(usage, "cacheWrite1h") } : {}),
			reasoningTokens: reasoning,
			totalTokens,
			costUsd,
			costProvenance:
				usage.estimated !== true
					? resolveCostProvenance(usage.costProvenance, costUsd > 0 ? "estimated" : "unknown")
					: "unknown",
			...(!observed ? { missingTokenCalls: 1 } : {}),
		});
	}
	const sideIds = new Set(
		journal.flatMap((row) =>
			(row.k === "call.started" || row.k === "call.settled") && journalOwnsSideUsage(row.data.label)
				? [row.data.callId]
				: [],
		),
	);
	for (const id of sideIds) if (!projected.has(id)) calls.push(...(journalCalls.get(id) ?? []));
	for (const id of orphanMainCallIds(entries, journal))
		if (!projected.has(id)) calls.push(...(journalCalls.get(id) ?? []));
	return calls;
}

/**
 * Main calls the journal settled but no ledger entry links: a crash after settlement lost the assistant message.
 * Only a call whose user turn is on the supplied (active-path) entries counts, so an abandoned branch or a
 * fork-inherited prefix keeps its own attribution (#434).
 */
function orphanMainCallIds(entries: ReadonlyArray<SessionEntry>, journal: ReadonlyArray<TelemetryRecord>): Set<string> {
	const turns = new Set<string>();
	const linked = new Set<string>();
	for (const entry of entries) {
		if (entry.kind === "compactionSummary") for (const id of entry.callIds ?? []) linked.add(id);
		if (entry.kind !== "message") continue;
		if (entry.role === "user") turns.add(entry.turnId);
		const callId = (entry.payload as { callId?: unknown } | null)?.callId;
		if (entry.role === "assistant" && typeof callId === "string") linked.add(callId);
	}
	const orphans = new Set<string>();
	for (const row of journal)
		if (
			(row.k === "call.started" || row.k === "call.settled") &&
			row.data.label === "main" &&
			row.ctx.turnId !== undefined &&
			turns.has(row.ctx.turnId) &&
			!linked.has(row.data.callId)
		)
			orphans.add(row.data.callId);
	return orphans;
}

/** Never-sent rows stay outside spending, but remain visible in coverage (#430). */
export function ledgerCallFailureCounts(
	entries: ReadonlyArray<SessionEntry>,
	journal: ReadonlyArray<TelemetryRecord> = [],
	seen?: Set<string>,
) {
	const linked = new Set(
		entries.flatMap((entry) => {
			if (entry.kind === "compactionSummary") return entry.callIds ?? [];
			if (entry.kind !== "message" || entry.role !== "assistant") return [];
			const callId = (entry.payload as { callId?: unknown } | null)?.callId;
			return typeof callId === "string" ? [callId] : [];
		}),
	);
	for (const row of journal) {
		if ((row.k === "call.started" || row.k === "call.settled") && journalOwnsSideUsage(row.data.label))
			linked.add(row.data.callId);
	}
	for (const id of orphanMainCallIds(entries, journal)) linked.add(id);
	const folded = foldCallJournal(journal, linked);
	const projected = new Set(folded.attempts.map(({ started }) => started.callId));
	const unique = folded.attempts.filter(({ started }) => {
		if (seen?.has(started.attemptId)) return false;
		seen?.add(started.attemptId);
		return true;
	});
	let invokedUnknownCalls = unique.filter(
		(attempt) =>
			attempt.settled !== null &&
			attempt.settled.disposition !== "never_sent" &&
			foldCalls([attempt]).totalTokens.unknownCount > 0,
	).length;
	let neverInvokedCalls = foldCalls(unique).neverSent;
	for (const entry of entries) {
		if (entry.kind !== "message" || entry.role !== "assistant") continue;
		const payload = entry.payload as {
			callId?: string;
			usage?: Record<string, unknown> | null;
			callInvoked?: boolean;
			failure?: { invoked?: boolean };
		} | null;
		if (payload?.callId && projected.has(payload.callId)) continue;
		const key = `legacy:${payload?.callId ?? entry.turnId}`;
		if (seen?.has(key)) continue;
		seen?.add(key);
		const usage = payload?.usage;
		if (payload?.callInvoked === false || usage?.callInvoked === false || payload?.failure?.invoked === false)
			neverInvokedCalls += 1;
		else if (usage && !normalizeTokenUsage(usage).observed) invokedUnknownCalls += 1;
	}
	return { invokedUnknownCalls, neverInvokedCalls };
}

/** Coverage labels preserve the distinction between unknown and never sent (#430). */
export function usageCoverageLabel(unknownCalls: number, neverSentCalls = 0): string {
	if (unknownCalls === 0)
		return `${neverSentCalls.toLocaleString("en-US")} call${neverSentCalls === 1 ? "" : "s"} never sent`;
	return `${unknownCalls.toLocaleString("en-US")} call${unknownCalls === 1 ? "" : "s"} with unknown usage; token amounts are known subtotals${neverSentCalls > 0 ? `; ${neverSentCalls.toLocaleString("en-US")} never sent` : ""}`;
}
