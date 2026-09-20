import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
import type { TraceRequest } from "../../../contracts/traces.js";
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
				const { source, status, q, limit } = input.query;
				const page = reader.runsPage({
					...(cursor ? { before: cursor } : {}),
					...(limit !== undefined ? { limit } : {}),
					filter: { ...(source ? { source } : {}), ...(status ? { status } : {}), ...(q ? { q } : {}) },
				});
				return {
					runs: page.runs,
					nextCursor: page.nextBefore ? Buffer.from(JSON.stringify(page.nextBefore)).toString("base64url") : null,
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
