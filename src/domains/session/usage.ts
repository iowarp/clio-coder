/**
 * Session accounting reads linked call-journal facts only, retries included (#434). The ledger is the conversation:
 * it says which calls a branch's turns made, and never what they used or cost, so a call no journal holds is not
 * measured.
 */

import type { ResponseModelIdObservation } from "../../core/response-model-id.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { CostProvenance } from "../providers/types/cost-provenance.js";
import type { CostAggregate } from "../telemetry/cost.js";
import type { CallTotals } from "../telemetry/folds.js";
import { foldCallJournal, foldCalls } from "../telemetry/folds.js";
import type { SessionEntry } from "./entries.js";
import { journalOwnsSideUsage, usageCallsFromJournal } from "./journal-usage.js";

/** One attempt projected from the journal (#434). */
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
	compactionOutcome?: EventPayload<"compaction.settled">["outcome"] | "unknown";
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
	costProvenance?: CostProvenance;
}

/** The target and model a session ran under before any modelChange row. */
export interface SessionUsageDefaults {
	/** The state root whose telemetry journal holds `sessionId`'s calls; without it nothing is measured. */
	journalStateDir?: string;
	target?: string | null;
	model?: string | null;
	sessionId?: string | null;
}

/**
 * The journal's attempts for the calls the supplied (active-path) entries link: an assistant message's call, a
 * checkpoint's calls, plus side calls the journal owns and main calls whose turn is on the path but whose message a
 * crash lost. An entry whose call no journal holds contributes nothing (#434).
 */
export function ledgerUsageCalls(
	entries: ReadonlyArray<SessionEntry>,
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
	const project = (id: string) => {
		if (projected.has(id)) return;
		projected.add(id);
		calls.push(...(journalCalls.get(id) ?? []));
	};
	for (const id of linkedCallIds(entries)) if (journalCalls.has(id)) project(id);
	for (const row of journal)
		if ((row.k === "call.started" || row.k === "call.settled") && journalOwnsSideUsage(row.ctx.agent.role))
			project(row.data.callId);
	for (const id of orphanMainCallIds(entries, journal)) project(id);
	return calls;
}

/** Call ids the entries link, in ledger order: a checkpoint's calls, then each assistant message's call. */
function linkedCallIds(entries: ReadonlyArray<SessionEntry>): string[] {
	return entries.flatMap((entry) => {
		if (entry.kind === "compactionSummary") return entry.callIds ?? [];
		if (entry.kind !== "message" || entry.role !== "assistant") return [];
		const callId = (entry.payload as { callId?: unknown } | null)?.callId;
		return typeof callId === "string" ? [callId] : [];
	});
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
			row.ctx.agent.role === "main" &&
			row.ctx.turnId !== undefined &&
			turns.has(row.ctx.turnId) &&
			!linked.has(row.data.callId)
		)
			orphans.add(row.data.callId);
	return orphans;
}

/** Never-sent calls stay outside spending, but remain visible in coverage (#430). */
export function ledgerCallFailureCounts(
	entries: ReadonlyArray<SessionEntry>,
	journal: ReadonlyArray<TelemetryRecord> = [],
	seen?: Set<string>,
) {
	const linked = new Set(linkedCallIds(entries));
	for (const row of journal) {
		if ((row.k === "call.started" || row.k === "call.settled") && journalOwnsSideUsage(row.ctx.agent.role))
			linked.add(row.data.callId);
	}
	for (const id of orphanMainCallIds(entries, journal)) linked.add(id);
	const unique = foldCallJournal(journal, linked).attempts.filter(({ started }) => {
		if (seen?.has(started.attemptId)) return false;
		seen?.add(started.attemptId);
		return true;
	});
	const invokedUnknownCalls = unique.filter(
		(attempt) =>
			attempt.settled !== null &&
			attempt.settled.disposition !== "never_sent" &&
			foldCalls([attempt]).totalTokens.unknownCount > 0,
	).length;
	return { invokedUnknownCalls, neverInvokedCalls: foldCalls(unique).neverSent };
}

/** Coverage labels preserve the distinction between unknown and never sent (#430). */
export function usageCoverageLabel(unknownCalls: number, neverSentCalls = 0): string {
	if (unknownCalls === 0)
		return `${neverSentCalls.toLocaleString("en-US")} call${neverSentCalls === 1 ? "" : "s"} never sent`;
	return `${unknownCalls.toLocaleString("en-US")} call${unknownCalls === 1 ? "" : "s"} with unknown usage; token amounts are known subtotals${neverSentCalls > 0 ? `; ${neverSentCalls.toLocaleString("en-US")} never sent` : ""}`;
}
