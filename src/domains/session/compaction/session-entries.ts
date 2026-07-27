import { isSessionEntry, type SessionEntry } from "../entries.js";

/**
 * Validate session ledger records and return the structured entry sequence.
 * The session header is removed by engine readers before this collector runs.
 */
export function collectSessionEntries(turns: ReadonlyArray<unknown>, filePath: string): SessionEntry[] {
	const out: SessionEntry[] = [];
	for (const raw of turns) {
		if (!isSessionEntry(raw)) {
			throw new Error(
				`session ledger contains an unreadable entry (missing kind discriminant): ${filePath}. Remove or compact the session to reset.`,
			);
		}
		out.push(raw);
	}
	return out;
}
