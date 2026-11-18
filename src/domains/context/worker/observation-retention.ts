import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { unlinkedStateDirectory } from "../../../core/state-boundary.js";

const OBSERVATIONS_DIRECTORY = "context-observations";
const RUN_DIRECTORY = /^[a-zA-Z0-9_-]+$/;
const ARCHIVE_FILE = /^[0-9a-f]{64}\.json$/;

/**
 * Where a worker archives its evicted observations: one directory per dispatched run, so retention can key them on
 * the run that wrote them. A worker without a run id keeps the flat layout every archive used before.
 */
export function workerObservationsDirectory(stateDir: string, runId?: string): string {
	const root = join(stateDir, OBSERVATIONS_DIRECTORY);
	return runId !== undefined && RUN_DIRECTORY.test(runId) ? join(root, runId) : root;
}

export interface WorkerObservationPruneOptions {
	nowMs: number;
	retentionMs: number;
	/** The run ledger: when each run ended, null while it has not; a run it does not name is unknown. */
	runEnds: ReadonlyMap<string, number | null>;
	stopped?: () => boolean;
}

async function names(directory: string): Promise<string[]> {
	try {
		return await readdir(directory);
	} catch {
		return [];
	}
}

/**
 * Age out evicted worker observations on the run journals' retention (D1-5). A run that ended longer ago than the
 * retention loses its archives; a run that has not ended keeps them, whatever their age. An archive whose run the
 * ledger does not name, the flat layout written before archives recorded their run included, goes once the file
 * itself is older than the retention. Returns the removed paths.
 */
export async function pruneWorkerObservations(
	stateDir: string,
	options: WorkerObservationPruneOptions,
): Promise<string[]> {
	const root = workerObservationsDirectory(stateDir);
	if (!unlinkedStateDirectory(stateDir, root)) return [];
	const cutoff = options.nowMs - options.retentionMs;
	const removed: string[] = [];
	const sweep = async (directory: string, expired: boolean): Promise<void> => {
		for (const name of await names(directory)) {
			if (options.stopped?.()) return;
			if (!ARCHIVE_FILE.test(name)) continue;
			const path = join(directory, name);
			const stat = await lstat(path).catch(() => null);
			if (!stat?.isFile() || (!expired && stat.mtimeMs >= cutoff)) continue;
			// Containment is proven after the last await: a directory swapped for a link must not redirect the delete.
			if (!unlinkedStateDirectory(stateDir, directory)) return;
			try {
				await unlink(path);
				removed.push(path);
			} catch {
				// Already gone or not ours to remove; the next sweep looks again.
			}
		}
	};
	await sweep(root, false);
	for (const name of await names(root)) {
		if (options.stopped?.()) break;
		if (!RUN_DIRECTORY.test(name)) continue;
		const directory = join(root, name);
		if (!unlinkedStateDirectory(stateDir, directory)) continue;
		const end = options.runEnds.get(name);
		// A running or recoverable run keeps every archive, and so does one that ended within the retention.
		if (end === null || (end !== undefined && end >= cutoff)) continue;
		await sweep(directory, end !== undefined);
		await rmdir(directory).catch(() => {});
	}
	return removed;
}
