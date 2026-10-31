import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	readDispatchHistory,
	readRunHistoryEntries,
	readRunHistoryEntry,
	readRunInspection,
} from "../../../../../src/domains/telemetry/index.js";
import { Id } from "../../../contracts/common.js";
import type { TraceIdentity, TraceRequest, TraceRun, TraceRunStatus } from "../../../contracts/traces.js";
import { AppProblem } from "../../services/problem.js";

/**
 * Trace history over the run journals (#434 §11.3). A run is listed by its journal's last write, newest first, the
 * same key `/api/telemetry/runs` pages by, and joined to the dispatch ledger for the identity a content-free journal
 * does not carry. Every number is the read model's run row.
 */
const Cursor = Type.Object(
	{ writtenMs: Type.Union([Type.Number(), Type.Null()]), runId: Id },
	{ additionalProperties: false },
);
type Entry = Static<typeof Cursor>;

function cursorOf(encoded: string | undefined): Entry | null {
	if (encoded === undefined) return null;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!Value.Check(Cursor, decoded)) throw new Error("cursor");
		return decoded;
	} catch {
		throw new AppProblem("validation", "Invalid trace pagination cursor.");
	}
}
const writeKey = (writtenMs: number | null) => writtenMs ?? -1;
/** Newest write first, then the higher id: the run journal listing's own order, so both histories agree. */
function newestFirst(a: Entry, b: Entry) {
	return writeKey(b.writtenMs) - writeKey(a.writtenMs) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0);
}
function entries(): Entry[] {
	try {
		return readRunHistoryEntries()
			.filter((entry) => Value.Check(Id, entry.runId))
			.map(({ runId, writtenMs }) => ({ runId, writtenMs }))
			.sort(newestFirst);
	} catch {
		throw new AppProblem("unavailable", "The run journal directory cannot be read.");
	}
}

const LEDGER_STATUS: Record<string, TraceRunStatus> = {
	queued: "queued",
	running: "running",
	completed: "success",
	failed: "fail",
	interrupted: "fail",
	stale: "fail",
	dead: "fail",
};
function identityOf(row: ReturnType<typeof readDispatchHistory>["rows"][number]): TraceIdentity {
	return {
		agentId: row.agentId,
		task: row.task,
		targetId: row.targetId,
		model: row.wireModelId,
		runtimeId: row.runtimeId,
		node: row.node?.id ?? null,
		status: row.status,
		outcome: row.outcome ?? null,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		sessionId: row.sessionId,
		parentRunId: row.lineage?.parentRunId ?? null,
		rootRunId: row.lineage?.rootRunId ?? null,
	};
}
/** The ledger's status when it holds the run; otherwise the journal's settlement, and unknown until there is one. */
function statusOf(identity: TraceIdentity | null, row: TraceRun["telemetry"] | null): TraceRunStatus {
	if (identity) return LEDGER_STATUS[identity.status] ?? "unknown";
	const reason = row?.terminalReason ?? null;
	return reason === null ? "unknown" : reason === "completed" ? "success" : "fail";
}
function matches(query: string, runId: string, identity: TraceIdentity | null): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	const fields = identity
		? [runId, identity.task, identity.agentId, identity.targetId, identity.model, identity.runtimeId]
		: [runId];
	return fields.some((field) => field.toLowerCase().includes(needle));
}

export class TraceAdapter {
	private identities(): Map<string, TraceIdentity> {
		try {
			return new Map(
				readDispatchHistory()
					.rows.filter((row) => typeof row.id === "string" && typeof row.task === "string")
					.map((row) => [row.id, identityOf(row)]),
			);
		} catch (error) {
			throw new AppProblem("unavailable", error instanceof Error ? error.message : String(error));
		}
	}
	private run(entry: Entry, identity: TraceIdentity | null): TraceRun {
		const { telemetry, evidence } = readRunInspection(entry.runId);
		return {
			runId: entry.runId,
			status: statusOf(identity, telemetry),
			writtenAt: entry.writtenMs === null ? null : new Date(entry.writtenMs).toISOString(),
			identity,
			telemetry,
			evidence,
		};
	}
	read(input: TraceRequest): unknown {
		// Parse caller-controlled cursors and ids before opening storage, including on an empty installation.
		const cursor = input.kind === "runs" ? cursorOf(input.query.cursor) : null;
		if ("runId" in input && !Value.Check(Id, input.runId))
			throw new AppProblem("validation", "Invalid trace run identifier.");
		if (input.kind === "receipt") return this.receipt(input.runId, input.full ?? false);
		const ledger = this.identities();
		if (input.kind === "run") {
			const identity = ledger.get(input.runId) ?? null;
			const directory = (() => {
				try {
					return readRunHistoryEntry(input.runId).present;
				} catch {
					return false;
				}
			})();
			if (!identity && !directory) throw new AppProblem("not_found", "Trace run was not found.");
			return this.run({ runId: input.runId, writtenMs: readRunHistoryEntry(input.runId).writtenMs }, identity);
		}
		const { status, q, limit = 50 } = input.query;
		const listed = entries();
		const runs: TraceRun[] = [];
		let last: Entry | null = null;
		let more = false;
		for (const entry of cursor ? listed.filter((item) => newestFirst(item, cursor) > 0) : listed) {
			if (runs.length >= limit) {
				more = true;
				break;
			}
			const identity = ledger.get(entry.runId) ?? null;
			// A ledger row decides status and text without reading the journal; only a ledger-less run is read to filter.
			if (q && !matches(q, entry.runId, identity)) continue;
			if (status && identity && statusOf(identity, null) !== status) continue;
			const run = this.run(entry, identity);
			if (status && run.status !== status) continue;
			runs.push(run);
			last = entry;
		}
		// The cursor keeps the journal's exact write time; an ISO string would round it and reorder same-millisecond runs.
		return { runs, nextCursor: more && last ? Buffer.from(JSON.stringify(last)).toString("base64url") : null };
	}
	/**
	 * A run's evidence through the read model, which checks the run seal and states only what a verified seal vouches
	 * for (#434 §11.3); the settled record and result object only when the full record is asked for.
	 */
	private receipt(runId: string, full: boolean) {
		const run = readRunInspection(runId);
		return { evidence: run.evidence, record: full ? run.record : null };
	}
}
