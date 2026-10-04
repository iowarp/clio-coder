import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cwdHash } from "../../engine/session.js";

/** One recorded session ledger, located without reading its content. */
export interface SessionLedgerStat {
	/** `<cwdHash>/<sessionId>`, stable for the life of the ledger. */
	key: string;
	sessionId: string;
	/** The workspace root whose cwd-partitioned bucket holds the ledger. */
	root: string;
	path: string;
	size: number;
	mtimeMs: number;
}

/**
 * The session ledgers recorded under each of the given workspace roots, newest
 * write first. Session history is partitioned by the hash of the recording
 * cwd, so only the named roots' buckets are opened: no other workspace's
 * sessions are listed or read.
 */
export function sessionLedgersForRoots(
	stateDir: string,
	roots: ReadonlyArray<string>,
	options: { excludeSessionId?: string | null; limit?: number } = {},
): SessionLedgerStat[] {
	const found: SessionLedgerStat[] = [];
	const seenBuckets = new Set<string>();
	for (const root of roots) {
		const bucket = cwdHash(root);
		if (seenBuckets.has(bucket)) continue;
		seenBuckets.add(bucket);
		const dir = join(stateDir, "sessions", bucket);
		let sessionIds: string[];
		try {
			sessionIds = readdirSync(dir);
		} catch {
			// No sessions were ever recorded from this root.
			continue;
		}
		for (const sessionId of sessionIds) {
			if (sessionId === options.excludeSessionId) continue;
			const path = join(dir, sessionId, "current.jsonl");
			try {
				const info = statSync(path);
				if (!info.isFile()) continue;
				found.push({ key: `${bucket}/${sessionId}`, sessionId, root, path, size: info.size, mtimeMs: info.mtimeMs });
			} catch {
				// A directory without a ledger is not a recorded session.
			}
		}
	}
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return options.limit === undefined ? found : found.slice(0, options.limit);
}
