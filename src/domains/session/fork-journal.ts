import { dirname, join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import type { CallJournalRead } from "../observability/call-journal.js";
import { readCallJournalSync } from "../observability/call-journal.js";
import type { SessionEntry } from "./entries.js";
import { journalOwnsSideUsage } from "./journal-usage.js";

export interface SessionCallJournalRead extends CallJournalRead {
	runs: Map<string, CallJournalRead & { throughMs: number }>;
}

/** Resolve immutable ancestor facts; a copied ledger never owns a second copy of its calls (#434). */
export function readSessionCallJournalSync(
	directory: string,
	entries: readonly SessionEntry[],
): SessionCallJournalRead {
	const sessionsRoot = dirname(dirname(directory));
	const runCutoffs = new Map<string, { cutoff: number; sessionId: string | null }>();
	const linked = new Set(
		entries.flatMap((entry) => {
			if (entry.kind === "compactionSummary") return entry.callIds ?? [];
			if (entry.kind !== "message" || entry.role !== "assistant") return [];
			const callId = (entry.payload as { callId?: unknown } | null)?.callId;
			return typeof callId === "string" ? [callId] : [];
		}),
	);
	const seen = new Set<string>();
	const read = (path: string, cutoff = Number.POSITIVE_INFINITY): CallJournalRead => {
		if (seen.has(path) || seen.size >= 128) return { records: [], skipped: 1, damaged: 0 };
		seen.add(path);
		const local = readCallJournalSync(path);
		const rows = local.records;
		// A side call belongs to the side of the boundary it started on, read
		// from its earliest record. Judged record by record, memory that settled
		// after the fork kept only its start in the child and folded as an
		// unsettled call (#434).
		const sideCallStarts = new Map<string, number>();
		for (const { record } of rows) {
			if ((record.k !== "call.started" && record.k !== "call.settled") || !journalOwnsSideUsage(record.data.label))
				continue;
			const at = Date.parse(record.t);
			sideCallStarts.set(record.data.callId, Math.min(at, sideCallStarts.get(record.data.callId) ?? at));
		}
		local.records = rows.filter(({ record }) => {
			if (cutoff === Number.POSITIVE_INFINITY) return true;
			if (record.k === "call.started" || record.k === "call.settled")
				return linked.has(record.data.callId) || (sideCallStarts.get(record.data.callId) ?? Number.NaN) <= cutoff;
			if (record.k === "compaction.closed")
				return record.data.callIds.some((id) => linked.has(id)) || Date.parse(record.t) <= cutoff;
			return Date.parse(record.t) <= cutoff;
		});
		for (const { record } of local.records) {
			if (record.k !== "call.ref" && record.k !== "run.ref") continue;
			const previous = runCutoffs.get(record.data.runId);
			if (!previous || cutoff > previous.cutoff)
				runCutoffs.set(record.data.runId, { cutoff, sessionId: record.ctx.sessionId });
		}
		const parents = rows.filter(({ record }) => record.k === "session.forked_from");
		if (parents.length > 1) {
			local.skipped += parents.length;
			return local;
		}
		for (const { record } of parents) {
			if (record.k !== "session.forked_from") continue;
			const parent = record.data;
			try {
				assertSafeId(parent.parentSessionId, "parent session");
				assertSafeId(parent.parentCwdHash, "parent workspace");
				const at = Date.parse(parent.parentTurnAt);
				if (!Number.isFinite(at)) throw new Error("invalid fork boundary timestamp");
				const inherited = read(join(sessionsRoot, parent.parentCwdHash, parent.parentSessionId), Math.min(cutoff, at));
				local.records.push(...inherited.records);
				local.skipped += inherited.skipped + (inherited.records.length === 0 ? 1 : 0);
				local.damaged += inherited.damaged;
			} catch {
				// A missing or unsupported ancestor cannot prevent reading the child's own facts (#434).
				local.skipped += 1;
			}
		}
		return local;
	};
	const result = read(directory);
	const runs: SessionCallJournalRead["runs"] = new Map();
	for (const [runId, reference] of runCutoffs) {
		try {
			assertSafeId(runId, "run");
			const run = readCallJournalSync(join(dirname(sessionsRoot), "runs", runId), "events.ndjson");
			run.records = run.records.filter(
				({ record }) =>
					record.ctx.runId === runId &&
					record.ctx.sessionId === reference.sessionId &&
					Date.parse(record.t) <= reference.cutoff,
			);
			runs.set(runId, { ...run, throughMs: reference.cutoff });
		} catch {
			// The reference remains visible as unknown coverage when its target is unavailable (#434).
			runs.set(runId, { records: [], skipped: 1, damaged: 0, throughMs: reference.cutoff });
		}
	}
	return { ...result, runs };
}
