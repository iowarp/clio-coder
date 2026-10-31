import { statSync } from "node:fs";
import { join } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import { openLedger } from "../../../../../src/domains/dispatch/state.js";
import type { RunEnvelope } from "../../../../../src/domains/dispatch/types.js";
import {
	listRunTelemetryIds,
	loadRunEvidence,
	loadRunRecord,
	loadRunTelemetrySource,
	runTelemetryDirectoryExists,
	runTelemetryWrittenMs,
} from "../../../../../src/domains/session/telemetry-source.js";
import { runRowTelemetry } from "../../../../../src/domains/telemetry/read-model.js";
import { Id } from "../../../contracts/common.js";
import type { TraceIdentity, TraceRequest, TraceRun, TraceRunStatus } from "../../../contracts/traces.js";
import { AppProblem } from "../../services/problem.js";
import { containedFile } from "./storage.js";

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
/** A run directory whose journal was never written lists last, as unknown coverage (R9). */
function writtenMs(state: string, runId: string): number | null {
	try {
		return runTelemetryWrittenMs(state, runId);
	} catch {
		return null;
	}
}
function entries(state: string): Entry[] {
	let names: string[];
	try {
		names = listRunTelemetryIds(state);
	} catch {
		throw new AppProblem("unavailable", "The run journal directory cannot be read.");
	}
	return names
		.filter((name) => Value.Check(Id, name))
		.map((runId) => ({ runId, writtenMs: writtenMs(state, runId) }))
		.sort(newestFirst);
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
function identityOf(row: RunEnvelope): TraceIdentity {
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
	/** The parsed ledger, kept while runs.json's identity and size stay the same. */
	private ledger: { key: string; rows: Map<string, TraceIdentity> } | null = null;
	private identities(state: string): Map<string, TraceIdentity> {
		let key: string;
		try {
			const info = statSync(join(state, "runs.json"));
			key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
			throw new AppProblem("unavailable", "The dispatch ledger cannot be read.");
		}
		if (this.ledger?.key === key) return this.ledger.rows;
		if (!containedFile(state, "runs.json"))
			throw new AppProblem("unavailable", "The dispatch ledger is outside its storage boundary or exceeds 8 MiB.");
		const rows = new Map<string, TraceIdentity>();
		try {
			for (const row of openLedger().list())
				if (typeof row.id === "string" && typeof row.task === "string") rows.set(row.id, identityOf(row));
		} catch {
			throw new AppProblem("unavailable", "The dispatch ledger is unreadable.");
		}
		this.ledger = { key, rows };
		return rows;
	}
	private run(state: string, entry: Entry, identity: TraceIdentity | null): TraceRun {
		const telemetry = runRowTelemetry(entry.runId, loadRunTelemetrySource(state, entry.runId));
		return {
			runId: entry.runId,
			status: statusOf(identity, telemetry),
			writtenAt: entry.writtenMs === null ? null : new Date(entry.writtenMs).toISOString(),
			identity,
			telemetry,
		};
	}
	read(input: TraceRequest): unknown {
		// Parse caller-controlled cursors and ids before opening storage, including on an empty installation.
		const cursor = input.kind === "runs" ? cursorOf(input.query.cursor) : null;
		if ("runId" in input && !Value.Check(Id, input.runId))
			throw new AppProblem("validation", "Invalid trace run identifier.");
		const state = clioStateDir();
		if (input.kind === "receipt") return this.receipt(state, input.runId, input.full ?? false);
		const ledger = this.identities(state);
		if (input.kind === "run") {
			const identity = ledger.get(input.runId) ?? null;
			const directory = (() => {
				try {
					return runTelemetryDirectoryExists(state, input.runId);
				} catch {
					return false;
				}
			})();
			if (!identity && !directory) throw new AppProblem("not_found", "Trace run was not found.");
			return this.run(state, { runId: input.runId, writtenMs: writtenMs(state, input.runId) }, identity);
		}
		const { status, q, limit = 50 } = input.query;
		const listed = entries(state);
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
			const run = this.run(state, entry, identity);
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
	private receipt(state: string, runId: string, full: boolean) {
		const evidence = loadRunEvidence(state, runId);
		if (!full) return { evidence, record: null };
		const record = loadRunRecord(state, runId);
		return {
			evidence,
			record: record?.settled ? { settled: record.settled, seal: record.seal, result: record.result } : null,
		};
	}
}
