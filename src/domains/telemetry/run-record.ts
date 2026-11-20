/**
 * A finished run's record as every reader gets it (#434): the read model's run DTO over the run's journal and its
 * scope files, so the settled facts, the seal verdict and the result object come from one read.
 */

import { readdirSync } from "node:fs";
import { assertSafeId } from "../../core/safe-id.js";
import { withinStateRoot, withinStateRootAsync } from "../../core/state-boundary.js";
import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { scanTelemetrySegment } from "../../core/telemetry/segment.js";
import type { CallJournalRead } from "./call-journal.js";
import { callJournalReadOfScans, readCallJournal, readCallJournalSync } from "./call-journal.js";
import { telemetryJournalFiles, telemetryRunDirectory, telemetrySessionDirectory } from "./paths.js";
import { journalSourceFromRead, runTelemetry } from "./read-model.js";
import type { SealVerdict, TelemetryScopeFiles } from "./seal.js";
import { readTelemetryScopeFiles, readTelemetryScopeFilesSync, verifyTelemetryScope } from "./seal.js";

/** A run DTO whose run settled: the facts its run.settled recorded are present. */
export type SettledRunRecord = RunTelemetryV1 & { settled: NonNullable<RunTelemetryV1["settled"]> };

function record(runId: string, read: CallJournalRead, scope: TelemetryScopeFiles, sealVerdict?: SealVerdict) {
	return runTelemetry(runId, journalSourceFromRead(read, scope.segments.length > 0, runId), {}, scope, sealVerdict);
}

/**
 * A sealed scope's journal read and seal verdict from one scan of the segment bytes the scope read already holds.
 * Verifying a sealed scope walks every line, so a second journal read would checksum and decode each line twice. Null
 * keeps the journal's own read: a live scope's verdict walks nothing and its incremental read is cheaper than a
 * scan, and a journal listing that differs from the scope read's means a rotation raced it, which that read retries.
 */
function sealedRead(
	directory: string,
	scope: TelemetryScopeFiles,
): { read: CallJournalRead; seal: SealVerdict } | null {
	if (scope.manifest === null) return null;
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		// The directory went away after the scope read; the journal read reports that as it always has.
		return null;
	}
	if (telemetryJournalFiles(names).join("\n") !== scope.segments.map(({ name }) => name).join("\n")) return null;
	const scans = scope.segments.map(({ bytes }) => scanTelemetrySegment(bytes));
	return { read: callJournalReadOfScans(scans), seal: verifyTelemetryScope(scope, scans) };
}

/**
 * The run's DTO with its seal verdict and result object; null when the run has no readable scope directory beneath the
 * state root.
 */
export function readRunRecord(stateDir: string, runId: string): RunTelemetryV1 | null {
	assertSafeId(runId, "run");
	const directory = telemetryRunDirectory(stateDir, runId);
	if (!withinStateRoot(stateDir, directory)) return null;
	let scope: TelemetryScopeFiles;
	try {
		scope = readTelemetryScopeFilesSync(directory);
	} catch {
		// No run directory: the run never opened a journal on this host.
		return null;
	}
	const sealed = sealedRead(directory, scope);
	return sealed ? record(runId, sealed.read, scope, sealed.seal) : record(runId, readCallJournalSync(directory), scope);
}

export async function readRunRecordAsync(stateDir: string, runId: string): Promise<RunTelemetryV1 | null> {
	assertSafeId(runId, "run");
	const directory = telemetryRunDirectory(stateDir, runId);
	if (!(await withinStateRootAsync(stateDir, directory))) return null;
	let scope: TelemetryScopeFiles;
	try {
		scope = await readTelemetryScopeFiles(directory);
	} catch {
		// No run directory: the run never opened a journal on this host.
		return null;
	}
	return record(runId, await readCallJournal(directory), scope);
}

/**
 * The records a run's journal holds, live or sealed, without folding them; empty when the run has no journal beneath
 * the state root. Recovery folds an abandoned run's call records from them (FL-24).
 */
export function readRunJournalRecords(stateDir: string, runId: string): readonly TelemetryRecord[] {
	assertSafeId(runId, "run");
	const directory = telemetryRunDirectory(stateDir, runId);
	if (!withinStateRoot(stateDir, directory)) return [];
	return readCallJournalSync(directory).records.map(({ record }) => record);
}

/** The run's record when it settled; a run with no run.settled did not finish, which is what recovery needs to know. */
export function readSettledRun(stateDir: string, runId: string): SettledRunRecord | null {
	const run = readRunRecord(stateDir, runId);
	return run?.settled ? (run as SettledRunRecord) : null;
}

export async function readSettledRunAsync(stateDir: string, runId: string): Promise<SettledRunRecord | null> {
	const run = await readRunRecordAsync(stateDir, runId);
	return run?.settled ? (run as SettledRunRecord) : null;
}

/**
 * The run's settled record when its seal verifies and, given a cited identity, when its run.settled digest is that
 * identity; anything else is not evidence a reader may act on (#434).
 */
export function readVerifiedRun(stateDir: string, runId: string, digest?: string): SettledRunRecord | null {
	const run = readSettledRun(stateDir, runId);
	if (run?.seal?.status !== "verified") return null;
	return digest === undefined || run.settled.digest === digest ? run : null;
}

/**
 * The records a run or session scope's seal authenticates, in chain order; null unless the scope sits beneath the
 * state root and its seal verifies. The records come from the very bytes the seal verdict checked, so a reader that
 * acts on them acts only on what the seal vouches for (#434).
 */
export function readSealedScopeRecords(
	stateDir: string,
	scope: { kind: "run" | "session"; id: string },
): TelemetryRecord[] | null {
	const directory =
		scope.kind === "run" ? telemetryRunDirectory(stateDir, scope.id) : telemetrySessionDirectory(stateDir, scope.id);
	if (!withinStateRoot(stateDir, directory)) return null;
	let files: TelemetryScopeFiles;
	try {
		files = readTelemetryScopeFilesSync(directory);
	} catch {
		// No readable scope: nothing it holds is authenticated.
		return null;
	}
	if (verifyTelemetryScope(files).status !== "verified") return null;
	const records: TelemetryRecord[] = [];
	for (const segment of files.segments)
		for (const row of scanTelemetrySegment(segment.bytes).rows) if (row.kind === "record") records.push(row.record);
	return records;
}
