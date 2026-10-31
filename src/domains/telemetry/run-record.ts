/**
 * A finished run's record as every reader gets it (#434): the read model's run DTO over the run's journal and its
 * scope files, so the settled facts, the seal verdict and the result object come from one read.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { assertSafeId } from "../../core/safe-id.js";
import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import { readCallJournal, readCallJournalSync } from "./call-journal.js";
import { telemetryRunDirectory } from "./paths.js";
import { journalSourceFromRead, runTelemetry } from "./read-model.js";
import type { TelemetryScopeFiles } from "./seal.js";
import { readTelemetryScopeFiles, readTelemetryScopeFilesSync } from "./seal.js";

/** A run DTO whose run settled: the facts its run.settled recorded are present. */
export type SettledRunRecord = RunTelemetryV1 & { settled: NonNullable<RunTelemetryV1["settled"]> };

function record(runId: string, read: Parameters<typeof journalSourceFromRead>[0], scope: TelemetryScopeFiles) {
	return runTelemetry(runId, journalSourceFromRead(read, scope.segments.length > 0, runId), {}, scope);
}

/**
 * Whether a directory resolves beneath the state root. The scope readers refuse a symlinked scope directory or file
 * but follow its ancestors, so a `telemetry` or `runs` symlink that leaves the root would otherwise serve a foreign
 * tree as this host's verified runs (#434).
 */
export function containedInStateRoot(stateDir: string, directory: string): boolean {
	try {
		const rel = relative(realpathSync(stateDir), realpathSync(directory));
		return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
	} catch {
		// A path that does not resolve holds nothing to read.
		return false;
	}
}

/**
 * The run's DTO with its seal verdict and result object; null when the run has no readable scope directory beneath the
 * state root.
 */
export function readRunRecord(stateDir: string, runId: string): RunTelemetryV1 | null {
	assertSafeId(runId, "run");
	const directory = telemetryRunDirectory(stateDir, runId);
	if (!containedInStateRoot(stateDir, directory)) return null;
	let scope: TelemetryScopeFiles;
	try {
		scope = readTelemetryScopeFilesSync(directory);
	} catch {
		// No run directory: the run never opened a journal on this host.
		return null;
	}
	return record(runId, readCallJournalSync(directory), scope);
}

export async function readRunRecordAsync(stateDir: string, runId: string): Promise<RunTelemetryV1 | null> {
	assertSafeId(runId, "run");
	const directory = telemetryRunDirectory(stateDir, runId);
	if (!containedInStateRoot(stateDir, directory)) return null;
	let scope: TelemetryScopeFiles;
	try {
		scope = await readTelemetryScopeFiles(directory);
	} catch {
		// No run directory: the run never opened a journal on this host.
		return null;
	}
	return record(runId, await readCallJournal(directory), scope);
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
