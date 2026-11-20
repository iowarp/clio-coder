import { readFileSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { unlinkedStateDirectory } from "../../../core/state-boundary.js";
import { clioStateDir } from "../../../core/xdg.js";
import { parseWorkerContextSeed } from "../../../worker/context-seed.js";
import type { WorkerContextSeed } from "./contract.js";

const SEEDS_DIRECTORY = "context-seeds";
const SEED_FILE = /^[a-f0-9]{64}\.json$/u;

/** Content-addressed evidence, independent of the parent's live session writer. */
export function persistWorkerContextSeed(input: WorkerContextSeed): string {
	const seed = parseWorkerContextSeed(input);
	const file = join(clioStateDir(), SEEDS_DIRECTORY, `${seed.provenance.contentHash}.json`);
	safeResourceWrite(file, `${JSON.stringify(seed)}\n`, { mode: 0o600 });
	// A successful dispatch never names an artifact that was not durably materialized.
	parseWorkerContextSeed(JSON.parse(readFileSync(file, "utf8")));
	return file;
}

export interface WorkerContextSeedPruneOptions {
	nowMs: number;
	retentionMs: number;
	/** Per content hash, when the ledger runs that used the seed ended; null while one has not. */
	seedEnds: ReadonlyMap<string, number | null>;
	stopped?: () => boolean;
}

/**
 * Age out worker context seeds on the run journals' retention (FL-8), by the rule evicted observations follow: a seed
 * a ledger run that has not ended, or ended within the retention, still names is kept whatever its age; any other
 * seed goes once its file is older than the retention. A dispatch rewrites its seed, so the file time is its last
 * use. Returns the removed paths.
 */
export async function pruneWorkerContextSeeds(
	stateDir: string,
	options: WorkerContextSeedPruneOptions,
): Promise<string[]> {
	const root = join(stateDir, SEEDS_DIRECTORY);
	if (!unlinkedStateDirectory(stateDir, root)) return [];
	const cutoff = options.nowMs - options.retentionMs;
	const removed: string[] = [];
	const names = await readdir(root).catch(() => [] as string[]);
	for (const name of names) {
		if (options.stopped?.()) break;
		if (!SEED_FILE.test(name)) continue;
		const end = options.seedEnds.get(name.slice(0, -".json".length));
		if (end === null || (end !== undefined && end >= cutoff)) continue;
		const path = join(root, name);
		const stat = await lstat(path).catch(() => null);
		if (!stat?.isFile() || stat.mtimeMs >= cutoff) continue;
		// Containment is proven after the last await: a directory swapped for a link must not redirect the delete.
		if (!unlinkedStateDirectory(stateDir, root)) break;
		try {
			await unlink(path);
			removed.push(path);
		} catch {
			// Already gone or not ours to remove; the next sweep looks again.
		}
	}
	return removed;
}
