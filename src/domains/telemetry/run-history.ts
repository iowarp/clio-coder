import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import { clioStateDir } from "../../core/xdg.js";
import type { FleetRunRecord } from "../dispatch/index.js";
import { councilTopologies, gateTopology, openLedger, readFleetRun, runEvidenceOf } from "../dispatch/index.js";
import {
	listRunTelemetryIds,
	loadRunTelemetrySource,
	runTelemetryDirectoryExists,
	runTelemetryWrittenMs,
} from "../session/index.js";
import { runRowTelemetry } from "./read-model.js";
import { readRunRecord } from "./run-record.js";

/** Bound identity records before their domain readers open them; telemetry stays in its own run scopes (#434). */
function containedRecord(root: string, ...parts: string[]): boolean {
	try {
		const base = realpathSync(root);
		const path = realpathSync(resolve(base, ...parts));
		const rel = relative(base, path);
		const info = statSync(path);
		return (
			!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && info.isFile() && info.size <= 8 * 1024 * 1024
		);
	} catch {
		return false;
	}
}

/** Identity and orchestration history for run surfaces; terminal facts always come from the run DTO (#434). */
export function readDispatchHistory() {
	const state = clioStateDir();
	try {
		statSync(join(state, "runs.json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], present: false };
		throw new Error("The dispatch ledger cannot be read.");
	}
	if (!containedRecord(state, "runs.json"))
		throw new Error("The dispatch ledger is outside its storage boundary or exceeds 8 MiB.");
	return { rows: [...openLedger().list()], present: true };
}

export function readFleetHistoryRoot(id: string): FleetRunRecord | null {
	assertSafeId(id, "fleet run");
	return containedRecord(clioStateDir(), "fleet-runs", `${id}.json`) ? readFleetRun(id) : null;
}

/** Scan every root before pagination, so roots beyond the dispatch domain's recent-window cap remain reachable (#434). */
export function readFleetHistory() {
	let names: string[];
	try {
		names = readdirSync(join(clioStateDir(), "fleet-runs"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], present: false };
		throw new Error("The fleet directory cannot be read.");
	}
	if (names.length > 100_000) throw new Error("Fleet directory exceeds the supported scan size.");
	const rows: FleetRunRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const record = readFleetHistoryRoot(name.slice(0, -5));
			if (record && Number.isFinite(Date.parse(record.startedAt))) rows.push(record);
		} catch {
			// A malformed root costs one row, never the history page (#434).
		}
	}
	return { rows, present: true };
}

export { councilTopologies as runHistoryCouncils, gateTopology as runHistoryGates };

/** Read the row, its sealed facts and the seal verdict from the same run DTO (#434 B8, B10). */
export function readRunInspection(runId: string, state = clioStateDir()) {
	const run = readRunRecord(state, runId);
	return {
		telemetry: run?.row ?? runRowTelemetry(runId, loadRunTelemetrySource(state, runId)),
		evidence: runEvidenceOf(runId, run),
		record: run?.settled ? { settled: run.settled, seal: run.seal, result: run.result } : null,
	};
}

export function readRunHistoryEntry(runId: string, state = clioStateDir()) {
	assertSafeId(runId, "run");
	let present = false;
	let writtenMs: number | null = null;
	try {
		present = runTelemetryDirectoryExists(state, runId);
	} catch {
		/* An unreadable directory cannot establish presence (#434 R9). */
	}
	try {
		writtenMs = runTelemetryWrittenMs(state, runId);
	} catch {
		/* Unreadable journals keep their row with unknown write coverage (#434 R9). */
	}
	return { runId, present, writtenMs };
}

export function readRunHistoryEntries(state = clioStateDir()) {
	return listRunTelemetryIds(state).flatMap((runId) => {
		try {
			assertSafeId(runId, "run");
			return [readRunHistoryEntry(runId, state)];
		} catch {
			// A removed or invalid directory cannot contribute a history entry (#434).
			return [];
		}
	});
}
