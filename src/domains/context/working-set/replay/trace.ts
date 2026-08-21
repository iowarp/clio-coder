import type { SessionEntry } from "../../../session/entries.js";
import { isTurnStart } from "../horizon.js";

/** One active-path Clio ledger prepared for deterministic replay. */
export interface Trace {
	id: string;
	source: string;
	/** Session working directory the ledger's relative paths resolve against; null when the source did not record one. */
	cwd: string | null;
	entries: ReadonlyArray<SessionEntry>;
	turnCount: number;
}

/** Turn boundaries shared by the live age horizon and replay runner. */
export function isReplayTurnStart(entry: SessionEntry): boolean {
	return isTurnStart(entry);
}

export function countReplayTurns(entries: ReadonlyArray<SessionEntry>): number {
	let count = 0;
	for (const entry of entries) {
		if (isReplayTurnStart(entry)) count += 1;
	}
	return count;
}
