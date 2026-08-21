import type { SessionEntry } from "../../../session/entries.js";

/** One active-path Clio ledger prepared for deterministic replay. */
export interface Trace {
	id: string;
	source: string;
	entries: ReadonlyArray<SessionEntry>;
	turnCount: number;
}

/** Turn boundaries shared by the live age horizon and replay runner. */
export function isReplayTurnStart(entry: SessionEntry): boolean {
	if (entry.kind === "bashExecution" || entry.kind === "branchSummary") return true;
	return entry.kind === "message" && entry.role === "user";
}

export function countReplayTurns(entries: ReadonlyArray<SessionEntry>): number {
	let count = 0;
	for (const entry of entries) {
		if (isReplayTurnStart(entry)) count += 1;
	}
	return count;
}
