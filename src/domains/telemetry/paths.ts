import { join } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";

/**
 * The one module that knows where telemetry lives (#434). Every telemetry file is under `<stateDir>/telemetry/`:
 *
 *   process/<processId>/journal.jsonl    one journal per process, opened on its first process-scoped record
 *   sessions/<sessionId>/journal.jsonl   plus objects/
 *   runs/<runId>/journal.jsonl           plus objects/ when a run stores one
 *   <scope>/bundle.json                  only while the scope is sealed
 *   consent.json
 *
 * Every scope names its journal `journal.jsonl` and rotates it as `journal.<recId>.jsonl`. Nothing outside the
 * telemetry domain writes under this root (rule11 in tests/boundaries/check-boundaries.ts).
 */

export const TELEMETRY_JOURNAL_FILE = "journal.jsonl";
const SEGMENT_FILE = /^journal\.rec_[0-9a-f-]+\.jsonl$/u;

/** Ids are existing path components; one that could leave its scope directory is refused, not resolved (#434). */
function scopeId(id: string, scope: string): string {
	assertSafeId(id, scope);
	return id;
}

export function telemetryRoot(stateDir: string): string {
	return join(stateDir, "telemetry");
}

export function telemetryProcessesDirectory(stateDir: string): string {
	return join(telemetryRoot(stateDir), "process");
}

export function telemetryProcessDirectory(stateDir: string, processId: string): string {
	return join(telemetryProcessesDirectory(stateDir), scopeId(processId, "process"));
}

export function telemetrySessionsDirectory(stateDir: string): string {
	return join(telemetryRoot(stateDir), "sessions");
}

export function telemetrySessionDirectory(stateDir: string, sessionId: string): string {
	return join(telemetrySessionsDirectory(stateDir), scopeId(sessionId, "session"));
}

export function telemetryRunsDirectory(stateDir: string): string {
	return join(telemetryRoot(stateDir), "runs");
}

export function telemetryRunDirectory(stateDir: string, runId: string): string {
	return join(telemetryRunsDirectory(stateDir), scopeId(runId, "run"));
}

/** A scope's live journal segment. */
export function telemetryJournalPath(scopeDirectory: string): string {
	return join(scopeDirectory, TELEMETRY_JOURNAL_FILE);
}

/** The name a rotated segment takes; record ids are UUIDv7, so names sort oldest first. */
export function telemetrySegmentFile(recordId: string): string {
	return `journal.${recordId}.jsonl`;
}

/** A scope's journal segments among a directory listing, oldest first, the live segment last. */
export function telemetryJournalFiles(names: readonly string[]): string[] {
	const files = names.filter((name) => SEGMENT_FILE.test(name)).sort();
	if (names.includes(TELEMETRY_JOURNAL_FILE)) files.push(TELEMETRY_JOURNAL_FILE);
	return files;
}

/** Whether a name is one of a scope's journal segments, live or rotated. */
export function isTelemetryJournalFile(name: string): boolean {
	return name === TELEMETRY_JOURNAL_FILE || SEGMENT_FILE.test(name);
}

export const TELEMETRY_BUNDLE_FILE = "bundle.json";

/** A sealed scope's manifest; a live scope has none (#434). */
export function telemetryBundlePath(scopeDirectory: string): string {
	return join(scopeDirectory, TELEMETRY_BUNDLE_FILE);
}

export function telemetryObjectsDirectory(scopeDirectory: string): string {
	return join(scopeDirectory, "objects");
}

export function telemetryConsentPath(stateDir: string): string {
	return join(telemetryRoot(stateDir), "consent.json");
}
