import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TraceReader } from "../observability/trace-store.js";

const HISTORY_FILE_LIMIT = 10_000;
const HISTORY_FILE_BYTE_LIMIT = 8 * 1024 * 1024;
const HISTORY_SUFFIXES = [".json", ".jsonl", ".ndjson"] as const;
const LEGACY_EVENT_TYPES = [
	"clio_permission_escalated",
	"clio_permission_resolved",
	"clio_plan_update",
	"clio_run_outcome",
	"clio_safety_decision",
	"clio_skill_activation",
	"clio_steer_received",
	"clio_tool_activity",
	"clio_tool_finish",
	"clio_tool_start",
	"clio_usage",
	"clio_verification",
	"clio_write_record_downgraded",
] as const;
const LEGACY_HISTORY_LITERALS = [
	...LEGACY_EVENT_TYPES,
	"clio.eval.",
	'"clio-run"',
	"clio.runReceipt.integrity",
	"clio.gateDecision.integrity",
	"clio.gateDecision.pending",
	"clio.protectedArtifact.pending",
	"clio.ask_user.interview.v1",
	"clio.share.v1",
	"clio-context-replay-v2",
	"identity.clio-worker",
] as const;

export type NamingHistoryArea = "trace" | "sessions" | "evals" | "evidence" | "receipts";

export interface NamingHistoryCount {
	area: NamingHistoryArea;
	legacyIdentifiers: number;
	filesInspected: number;
	filesSkipped: number;
	error: string | null;
}

export interface InspectNamingHistoryOptions {
	stateDir: string;
	dataDir: string;
}

function countLegacyHistoryText(text: string): number {
	let count = 0;
	for (const literal of LEGACY_HISTORY_LITERALS) {
		let offset = 0;
		for (;;) {
			const found = text.indexOf(literal, offset);
			if (found === -1) break;
			count += 1;
			offset = found + literal.length;
		}
	}
	count += text.match(/"clio"\s*:/gu)?.length ?? 0;
	count += text.match(/"clioVersion"\s*:/gu)?.length ?? 0;
	count += text.match(/"clioCommit"\s*:/gu)?.length ?? 0;
	return count;
}

function inspectTextTree(area: Exclude<NamingHistoryArea, "trace">, root: string): NamingHistoryCount {
	const result: NamingHistoryCount = {
		area,
		legacyIdentifiers: 0,
		filesInspected: 0,
		filesSkipped: 0,
		error: null,
	};
	if (!existsSync(root)) return result;
	const pending = [root];
	try {
		while (pending.length > 0 && result.filesInspected + result.filesSkipped < HISTORY_FILE_LIMIT) {
			const directory = pending.pop();
			if (directory === undefined) break;
			for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
				left.name.localeCompare(right.name),
			)) {
				const path = join(directory, entry.name);
				if (entry.isSymbolicLink()) {
					result.filesSkipped += 1;
					continue;
				}
				if (entry.isDirectory()) {
					pending.push(path);
					continue;
				}
				if (!entry.isFile() || !HISTORY_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
				const stats = lstatSync(path);
				if (!stats.isFile() || stats.size > HISTORY_FILE_BYTE_LIMIT) {
					result.filesSkipped += 1;
					continue;
				}
				result.legacyIdentifiers += countLegacyHistoryText(readFileSync(path, "utf8"));
				result.filesInspected += 1;
			}
		}
		if (pending.length > 0) result.filesSkipped += pending.length;
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);
	}
	return result;
}

function inspectTrace(path: string): NamingHistoryCount {
	const result: NamingHistoryCount = {
		area: "trace",
		legacyIdentifiers: 0,
		filesInspected: 0,
		filesSkipped: 0,
		error: null,
	};
	if (!existsSync(path)) return result;
	try {
		if (!statSync(path).isFile()) {
			result.filesSkipped = 1;
			return result;
		}
		const reader = new TraceReader(path);
		try {
			const placeholders = LEGACY_EVENT_TYPES.map(() => "?").join(",");
			const row = reader.db
				.prepare(`SELECT COUNT(*) AS count FROM events WHERE type IN (${placeholders})`)
				.get(...LEGACY_EVENT_TYPES) as { count: number | bigint };
			result.legacyIdentifiers = Number(row.count);
			result.filesInspected = 1;
		} finally {
			reader.close();
		}
	} catch (error) {
		result.error = error instanceof Error ? error.message : String(error);
	}
	return result;
}

/** Count released legacy identifiers without mutating immutable or sealed history. */
export function inspectNamingHistory(options: InspectNamingHistoryOptions): NamingHistoryCount[] {
	return [
		inspectTrace(join(options.stateDir, "trace.sqlite")),
		inspectTextTree("sessions", join(options.stateDir, "sessions")),
		inspectTextTree("evals", join(options.dataDir, "evals")),
		inspectTextTree("evidence", join(options.dataDir, "evidence")),
		inspectTextTree("receipts", join(options.stateDir, "receipts")),
	];
}
