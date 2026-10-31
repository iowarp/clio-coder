/**
 * Read back what a test run left under its scratch state directory: the run
 * ledger with its sealed run scopes, and the session ledger entries. Tests that
 * drive the real orchestrator or CLI assert against these durable records
 * rather than against the process's own report of what it did.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEnvelope } from "../../src/domains/dispatch/types.js";
import { listSessionLedgerRefs, parseSessionEntries } from "../../src/domains/session/archive-readers.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";

import type { SettledRunRecord } from "../../src/domains/telemetry/index.js";
import { readVerifiedRun, telemetryRunsDirectory } from "../../src/domains/telemetry/index.js";

export interface RunJournal {
	/** Ledger envelopes by run id. */
	envelopes: Map<string, RunEnvelope>;
	/** Settled run records whose scope seals verify. */
	runs: SettledRunRecord[];
}

/** The run ledger and sealed scopes under `stateDir`, or null when the directory does not exist. */
export function readRunJournal(stateDir: string): RunJournal | null {
	if (!existsSync(stateDir)) return null;
	return { envelopes: readEnvelopes(join(stateDir, "runs.json")), runs: readRuns(stateDir) };
}

/** Every entry of every session ledger under `stateDir`, in ledger order. */
export async function readSessionLedgerEntries(stateDir: string): Promise<SessionEntry[]> {
	const entries: SessionEntry[] = [];
	for (const ref of await listSessionLedgerRefs(stateDir)) {
		entries.push(...parseSessionEntries(await readFile(ref.path, "utf8"), ref.path).entries);
	}
	return entries;
}

function readEnvelopes(runsPath: string): Map<string, RunEnvelope> {
	const envelopes = new Map<string, RunEnvelope>();
	if (!existsSync(runsPath)) return envelopes;
	const parsed: unknown = JSON.parse(readFileSync(runsPath, "utf8"));
	if (!Array.isArray(parsed)) return envelopes;
	for (const entry of parsed) {
		if (isRecord(entry) && typeof entry.id === "string") envelopes.set(entry.id, entry as unknown as RunEnvelope);
	}
	return envelopes;
}

function readRuns(stateDir: string): SettledRunRecord[] {
	const directory = telemetryRunsDirectory(stateDir);
	if (!existsSync(directory)) return [];
	return readdirSync(directory).flatMap((runId) => {
		const run = readVerifiedRun(stateDir, runId);
		return run ? [run] : [];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
