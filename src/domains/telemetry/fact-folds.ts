/**
 * The read model's folds over the Phase 3 fact families (#434), one per family: decisions (approvals, tool and safety
 * decisions, completion evaluations), gate verdicts, memory steps and process health. Run lifecycle and route
 * decisions are entries on the run timeline (`runTimeline` in read-model.ts); quota is `foldAccountQuota`. Each fold
 * reads journal records and nothing else, so every surface that shows these facts counts them the same way. The fold
 * version is `TELEMETRY_FOLD_VERSION` (folds.ts).
 */

import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { AccountabilityEventName, AccountabilityRecord, JournalSource } from "./read-model.js";

// ---------------------------------------------------------------------------
// Decisions: approvals, tool decisions, safety judgments, completion evaluations
// ---------------------------------------------------------------------------

type Counts<K extends string> = Record<K, number>;

/** One accountability record as a surface lists it: what it decided, about which tool, for which run. */
export interface DecisionRow {
	id: string;
	at: string;
	kind: AccountabilityEventName;
	tool: string | null;
	actionClass: string | null;
	/** The decision, status, verdict, source or phase the record states; null for an approval ask. */
	outcome: string | null;
	/** The record's scope run, or the worker run a session record names (`requestedBy`, `workerRunId`). */
	runId: string | null;
	record: AccountabilityRecord;
}

export interface DecisionsFold {
	approvals: {
		/** Distinct asks: a forwarded ask republishes its request, and one request id is one ask. */
		requested: number;
		granted: number;
		denied: number;
		expired: number;
		/** Granted over requested; null with no ask. Resolutions can belong to asks outside the records read. */
		approvalRate: number | null;
	};
	tools: Counts<EventPayload<"tool.decided">["decision"]>;
	safety: Counts<EventPayload<"safety.judged">["verdict"]>;
	completion: Counts<EventPayload<"completion.evaluated">["decision"]>;
	/** Oldest first, as the records were given. */
	rows: DecisionRow[];
}

function decisionOutcome(record: AccountabilityRecord): string | null {
	switch (record.k) {
		case "tool.decided":
		case "completion.evaluated":
			return record.data.decision;
		case "approval.resolved":
			return record.data.status;
		case "safety.judged":
			return record.data.verdict;
		case "run.aborted":
		case "turn.aborted":
			return record.data.source;
		case "agent.status_changed":
			return record.data.phase;
		case "session.closed":
			return record.data.reason;
		case "session.resumed":
			return record.data.via;
		case "approval.requested":
			return null;
	}
}

function decisionRunId(record: AccountabilityRecord): string | null {
	if (record.ctx.runId !== undefined) return record.ctx.runId;
	if (record.k === "run.aborted") return record.data.runId;
	if (record.k === "approval.requested" || record.k === "approval.resolved") return record.data.requestedBy ?? null;
	if (record.k === "safety.judged") return record.data.workerRunId ?? null;
	return null;
}

export function decisionRow(record: AccountabilityRecord): DecisionRow {
	const data = record.data as { tool?: unknown; actionClass?: unknown };
	return {
		id: record.id,
		at: record.t,
		kind: record.k,
		tool: typeof data.tool === "string" ? data.tool : null,
		actionClass: typeof data.actionClass === "string" ? data.actionClass : null,
		outcome: decisionOutcome(record),
		runId: decisionRunId(record),
		record,
	};
}

/** Fold accountability records (`accountabilityRecords`) into the counts and rows a decisions surface shows. */
export function foldDecisions(records: Iterable<AccountabilityRecord>): DecisionsFold {
	const approvals = { requested: 0, granted: 0, denied: 0, expired: 0 };
	const tools = { allowed: 0, blocked: 0, permission_requested: 0, denied: 0 };
	const safety = { allow: 0, block: 0, none: 0, escalated: 0 };
	const completion = { ok: 0, engage: 0 };
	const asked = new Set<string>();
	const rows: DecisionRow[] = [];
	for (const record of records) {
		rows.push(decisionRow(record));
		switch (record.k) {
			case "approval.requested": {
				const id = record.data.requestId;
				if (id === undefined || !asked.has(id)) approvals.requested += 1;
				if (id !== undefined) asked.add(id);
				break;
			}
			case "approval.resolved":
				approvals[record.data.status] += 1;
				break;
			case "tool.decided":
				tools[record.data.decision] += 1;
				break;
			case "safety.judged":
				safety[record.data.verdict] += 1;
				break;
			case "completion.evaluated":
				completion[record.data.decision] += 1;
				break;
		}
	}
	return {
		approvals: {
			...approvals,
			approvalRate: approvals.requested === 0 ? null : approvals.granted / approvals.requested,
		},
		tools,
		safety,
		completion,
		rows,
	};
}

// ---------------------------------------------------------------------------
// Gate verdicts
// ---------------------------------------------------------------------------

export type GateVerdictRow = EventPayload<"gate.decided"> & { at: string; runId: string | null };

/**
 * The decided review and compete gates the journals hold, oldest first, each decision once: a run journal a session
 * and a repo both read is counted once, and a republished decision with the same digest is the same verdict.
 */
export function foldGateVerdicts(journals: Iterable<JournalSource>): GateVerdictRow[] {
	const seen = new Set<string>();
	const rows: GateVerdictRow[] = [];
	for (const journal of journals) {
		for (const record of journal.records) {
			if (record.k !== "gate.decided") continue;
			const key = `${record.data.decisionId}\u0000${record.data.digest}`;
			if (seen.has(key)) continue;
			seen.add(key);
			rows.push({ ...record.data, at: record.t, runId: record.ctx.runId ?? null });
		}
	}
	return rows.sort((a, b) => a.at.localeCompare(b.at) || a.decisionId.localeCompare(b.decisionId));
}

// ---------------------------------------------------------------------------
// Memory steps
// ---------------------------------------------------------------------------

type MemoryStep = EventPayload<"memory.step_decided">;

export interface MemoryStepRow {
	at: string;
	tier: MemoryStep["tier"];
	decision: MemoryStep["decision"];
	reason: MemoryStep["reason"];
	triggerReasons: MemoryStep["triggerReasons"];
	bankOperations: number;
	droppedOperations: number;
	citedEntries: number;
	route: MemoryStep["route"] | null;
}

export interface MemoryStepsFold {
	steps: MemoryStepRow[];
	decisions: Partial<Counts<MemoryStep["decision"]>>;
	reasons: Partial<Counts<MemoryStep["reason"]>>;
	/** Background memory calls that released their endpoint, by target. */
	completedByTarget: Record<string, number>;
}

/** The memory steps a scope decided and the endpoint completions it journaled; spend is `foldTaskMemorySpend`. */
export function foldMemorySteps(records: Iterable<TelemetryRecord>): MemoryStepsFold {
	const fold: MemoryStepsFold = { steps: [], decisions: {}, reasons: {}, completedByTarget: {} };
	for (const record of records) {
		if (record.k === "memory.step_completed") {
			fold.completedByTarget[record.data.targetId] = (fold.completedByTarget[record.data.targetId] ?? 0) + 1;
			continue;
		}
		if (record.k !== "memory.step_decided") continue;
		const data = record.data;
		fold.decisions[data.decision] = (fold.decisions[data.decision] ?? 0) + 1;
		fold.reasons[data.reason] = (fold.reasons[data.reason] ?? 0) + 1;
		fold.steps.push({
			at: record.t,
			tier: data.tier,
			decision: data.decision,
			reason: data.reason,
			triggerReasons: data.triggerReasons,
			bankOperations: data.bankOperations,
			droppedOperations: data.droppedOperations,
			citedEntries: data.citedEntries,
			route: data.route ?? null,
		});
	}
	fold.steps.sort((a, b) => a.at.localeCompare(b.at));
	return fold;
}

// ---------------------------------------------------------------------------
// Process health
// ---------------------------------------------------------------------------

export interface ProcessHealthFold {
	windows: number;
	firstAt: string | null;
	lastAt: string | null;
	/** The worst window's p99 and max event-loop lag; null when no window landed a lag sample. */
	peakLag: { p99Ms: number; maxMs: number } | null;
	peakRssBytes: number | null;
	peakQueueDepth: number | null;
	/** Records the process's writers dropped, as its last window counted them since opening. */
	dropped: number | null;
	last: (EventPayload<"health.sampled"> & { at: string }) | null;
}

/** A process journal's health windows (health.sampled) folded into peaks and the last sample. */
export function foldProcessHealth(source: Pick<JournalSource, "records">): ProcessHealthFold {
	const fold: ProcessHealthFold = {
		windows: 0,
		firstAt: null,
		lastAt: null,
		peakLag: null,
		peakRssBytes: null,
		peakQueueDepth: null,
		dropped: null,
		last: null,
	};
	for (const record of source.records) {
		if (record.k !== "health.sampled") continue;
		const data = record.data;
		fold.windows += 1;
		if (fold.firstAt === null || record.t < fold.firstAt) fold.firstAt = record.t;
		if (data.loopLag !== undefined)
			fold.peakLag = {
				p99Ms: Math.max(fold.peakLag?.p99Ms ?? 0, data.loopLag.p99Ms),
				maxMs: Math.max(fold.peakLag?.maxMs ?? 0, data.loopLag.maxMs),
			};
		fold.peakRssBytes = Math.max(fold.peakRssBytes ?? 0, data.rssBytes);
		fold.peakQueueDepth = Math.max(fold.peakQueueDepth ?? 0, data.writer.queueDepth);
		if (fold.lastAt === null || record.t >= fold.lastAt) {
			fold.lastAt = record.t;
			fold.dropped = data.writer.dropped;
			fold.last = { ...data, at: record.t };
		}
	}
	return fold;
}
