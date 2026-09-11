import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import { readEvidenceIndex } from "../../../../../src/domains/observability/evidence-index.js";
import {
	resolveTraceRetentionPolicy,
	TRACE_SCHEMA_VERSION,
	TraceReader,
	traceDatabasePath,
} from "../../../../../src/domains/observability/trace-store.js";
import { Id } from "../../../contracts/common.js";
import type { TraceRequest, TraceRun } from "../../../contracts/traces.js";
import { AppProblem } from "../../services/problem.js";

const Cursor = Type.Object({ startedAt: Type.String({ maxLength: 64 }), runId: Id }, { additionalProperties: false });
function cursorOf(encoded: string | undefined) {
	if (encoded === undefined) return null;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (!Value.Check(Cursor, decoded) || !Number.isFinite(Date.parse(decoded.startedAt))) throw new Error("cursor");
		return decoded;
	} catch {
		throw new AppProblem("validation", "Invalid trace pagination cursor.");
	}
}
function inside(root: string, path: string) {
	const part = relative(root, path);
	return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}
// Both the subtree and file must stay within the configured state root after resolving links.
function contained(state: string, directory: string, filename: string) {
	const root = realpathSync(state),
		base = realpathSync(join(state, directory)),
		path = realpathSync(join(base, filename));
	if (!inside(root, base) || !inside(base, path))
		throw new AppProblem("validation", "Trace path escapes its state directory.");
	return path;
}
export class TraceAdapter {
	private reader: TraceReader | undefined;
	private identity = "";
	private source = "source";
	private close() {
		this.reader?.close();
		this.reader = undefined;
	}
	private open() {
		const state = clioStateDir();
		const path = contained(state, ".", relative(state, traceDatabasePath(state)));
		const info = statSync(path),
			identity = `${info.dev}:${info.ino}`;
		if (this.reader && this.identity !== identity) this.close();
		if (!this.reader) {
			this.reader = new TraceReader(path);
			this.identity = identity;
			const columns = this.reader.db.prepare("PRAGMA table_info(runs)").all();
			this.source = columns.some((row) => row.name === "source")
				? "source"
				: "CASE WHEN assignment_id = 'session' THEN 'session' ELSE 'dispatch' END";
		}
		const version = this.reader.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
		if (Number(version?.value) !== TRACE_SCHEMA_VERSION) {
			this.close();
			throw new Error("Unsupported trace schema.");
		}
		return this.reader;
	}
	read(input: TraceRequest): unknown {
		// Parse caller-controlled cursors before opening storage, including on an empty installation.
		const cursor = input.kind === "runs" ? cursorOf(input.query.cursor) : null;
		if ("runId" in input && (!Value.Check(Id, input.runId) || input.runId.includes("..")))
			throw new AppProblem("validation", "Invalid trace run identifier.");
		if (input.kind === "receipt") return this.receipt(input.runId, input.full ?? false);
		try {
			const reader = this.open();
			if (input.kind === "status")
				return { available: true, schemaVersion: TRACE_SCHEMA_VERSION, retentionPolicy: resolveTraceRetentionPolicy() };
			if (input.kind === "runs") {
				const { query } = input,
					where: string[] = [],
					args: SQLInputValue[] = [];
				if (cursor) {
					where.push("(started_at < ? OR (started_at = ? AND run_id < ?))");
					args.push(cursor.startedAt, cursor.startedAt, cursor.runId);
				}
				if (query.source) {
					where.push(`(${this.source}) = ?`);
					args.push(query.source);
				}
				if (query.status) {
					where.push("status = ?");
					args.push(query.status);
				}
				if (query.q) {
					where.push("(run_id LIKE ? OR agent LIKE ? OR model LIKE ? OR status LIKE ? OR request LIKE ?)");
					args.push(...Array<string>(5).fill(`%${query.q}%`));
				}
				const limit = query.limit ?? 50;
				const rows = reader.db
					.prepare(
						`SELECT *, ${this.source} AS source FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, run_id DESC LIMIT ?`,
					)
					.all(...args, limit + 1) as unknown as TraceRun[];
				const runs = rows.slice(0, limit),
					last = runs.at(-1);
				return {
					runs,
					nextCursor:
						rows.length > limit && last
							? Buffer.from(JSON.stringify({ startedAt: last.started_at, runId: last.run_id })).toString("base64url")
							: null,
				};
			}
			const run = reader.run(input.runId);
			if (!run) throw new AppProblem("not_found", "Trace run was not found.");
			switch (input.kind) {
				case "run":
					return run;
				case "phases":
					return reader.phases(input.runId);
				case "gates":
					return reader.gateResults(input.runId);
				case "envelopes":
					return reader.envelopes(input.runId);
				case "processes":
					return reader.processes(input.runId);
				case "events":
				case "live": {
					const events = reader.events(input.runId, input.after, input.limit);
					return {
						...(input.kind === "live" ? { run } : {}),
						events,
						cursor: events.at(-1)?.rowid ?? input.after,
						hasMore: events.length === input.limit,
					};
				}
			}
		} catch (error) {
			this.close();
			if (error instanceof AppProblem) throw error;
			if (input.kind === "status")
				return { available: false, schemaVersion: null, retentionPolicy: resolveTraceRetentionPolicy() };
			throw new AppProblem("unavailable", "Trace database is unavailable or has an unsupported schema or journal mode.");
		}
	}
	private receipt(runId: string, full: boolean) {
		const state = clioStateDir();
		let receipt: Record<string, unknown> | null = null;
		let evidence: unknown = null;
		try {
			const path = contained(state, "receipts", `${runId}.json`);
			const data: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (data && typeof data === "object" && !Array.isArray(data)) receipt = data as Record<string, unknown>;
		} catch (error) {
			if (error instanceof AppProblem) throw error;
		}
		try {
			contained(state, ".", "evidence-index.json");
			evidence = readEvidenceIndex(state).find((row) => row.runId === runId) ?? null;
		} catch (error) {
			if (error instanceof AppProblem) throw error;
		}
		// Avoid sending the large payload through RPC until explicitly requested. Public policy also lives in the service.
		if (receipt && !full)
			for (const key of ["output", "upstreamResponses", "routeDecision", "briefing", "steering"]) delete receipt[key];
		return { receipt, evidence };
	}
}
