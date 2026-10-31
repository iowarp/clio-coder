import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { clioStateDir } from "../../core/xdg.js";
import { readCallJournalSync } from "./call-journal.js";
import {
	isTelemetryJournalFile,
	telemetryProcessesDirectory,
	telemetryRunsDirectory,
	telemetrySessionsDirectory,
} from "./paths.js";
import type { TaskMemorySpendSummary } from "./read-model.js";
import { foldTaskMemorySpend } from "./read-model.js";

const cache = new Map<string, { fingerprint: string; summary: TaskMemorySpendSummary }>();

/** Retained memory facts live in the session, run and process journals, including every rotated segment (#434). */
export function readTaskMemorySpendSummary(stateDir: string = clioStateDir()): TaskMemorySpendSummary {
	const directories: string[] = [];
	let unreadableFiles = 0;
	for (const root of [
		telemetrySessionsDirectory(stateDir),
		telemetryRunsDirectory(stateDir),
		telemetryProcessesDirectory(stateDir),
	]) {
		try {
			directories.push(
				...readdirSync(root, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(root, entry.name)),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadableFiles += 1;
		}
	}
	directories.sort();
	const stamps: string[] = [];
	for (const directory of directories) {
		try {
			for (const name of readdirSync(directory).filter(isTelemetryJournalFile).sort()) {
				const path = join(directory, name);
				const stat = statSync(path);
				stamps.push(`${path}:${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`);
			}
		} catch {
			unreadableFiles += 1;
		} // A partial retained scope cannot establish zero spend (#434).
	}
	const fingerprint = stamps.join("|");
	const prior = cache.get(stateDir);
	if (unreadableFiles === 0 && prior?.fingerprint === fingerprint) return prior.summary;
	const records: TelemetryRecord[] = [];
	let readableFiles = 0;
	let invalidRows = 0;
	for (const directory of directories) {
		try {
			const read = readCallJournalSync(directory);
			records.push(...read.records.map(({ record }) => record));
			readableFiles += readdirSync(directory).filter(isTelemetryJournalFile).length;
			invalidRows += read.skipped + read.damaged;
		} catch {
			unreadableFiles += 1;
		} // Keep other scopes' known subtotal and retry failed reads (#434).
	}
	const summary = foldTaskMemorySpend(records);
	summary.readableFiles = readableFiles;
	summary.unreadableFiles = unreadableFiles;
	summary.invalidRows = invalidRows;
	if (unreadableFiles === 0) cache.set(stateDir, { fingerprint, summary });
	else cache.delete(stateDir);
	return summary;
}
