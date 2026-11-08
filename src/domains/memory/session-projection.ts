/**
 * The memory view of the live session: the active branch before memory was
 * turned off, the lesson it would yield, and the observation source it
 * offers. Cached against the session's frozen entry snapshot so a hot path
 * that asks repeatedly does not refold the ledger.
 */
import type { SessionContract } from "../session/contract.js";
import type { SessionEntry } from "../session/entries.js";
import { observationCheckpoint, observationSourceUnits } from "../session/memory-source.js";
import { filterEntriesToActivePath } from "../session/tree/active-path.js";
import { completedLessonSource } from "./history-review.js";
import { entriesBeforeMemoryOff } from "./recording-marker.js";

export interface MemorySessionProjection {
	sessionId: string;
	pinned: string | null;
	entries: readonly SessionEntry[];
	active: readonly SessionEntry[];
	lesson: ReturnType<typeof completedLessonSource>;
	observation: {
		checkpoint: ReturnType<typeof observationCheckpoint>;
		units: ReturnType<typeof observationSourceUnits>;
	};
}

export function createMemorySessionProjection(
	getSession: () => SessionContract | undefined,
): () => MemorySessionProjection | null {
	let memoryProjection: MemorySessionProjection | null = null;
	return () => {
		const session = getSession();
		const meta = session?.current();
		if (!meta || !session) return null;
		const entries = session.readEntries();
		const pinned = meta.pinnedLeafTurnId ?? null;
		// Session's frozen snapshot changes on append, replacement or external writes. A /tree pin is separate authority.
		if (
			memoryProjection?.entries !== entries ||
			memoryProjection.sessionId !== meta.id ||
			memoryProjection.pinned !== pinned
		) {
			const active = entriesBeforeMemoryOff(filterEntriesToActivePath(entries, session.tree(meta.id).leafId ?? undefined));
			const checkpointIndex = active.reduce(
				(last, entry, index) => (entry.kind === "compactionSummary" ? index : last),
				-1,
			);
			memoryProjection = {
				sessionId: meta.id,
				pinned,
				entries,
				active,
				lesson: completedLessonSource(active, meta.cwd),
				observation: {
					checkpoint: observationCheckpoint(active),
					units: observationSourceUnits(active.slice(checkpointIndex + 1)),
				},
			};
		}
		return memoryProjection;
	};
}
