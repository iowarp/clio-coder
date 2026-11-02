import type { SessionContract } from "../session/contract.js";
import { filterEntriesToActivePath } from "../session/tree/active-path.js";

/**
 * Written to a session's ledger before the first turn recorded while `context.memory.enabled` is false. Memory
 * readers treat it like a flow restriction and read nothing past it, including what is recorded after memory comes
 * back on. A ledger written before this marker existed carries none, so those sessions stay reviewable.
 */
export const MEMORY_OFF_ENTRY_TYPE = "clio_coder_memory_off";

export function isMemoryOffEntry(entry: { kind?: unknown; customType?: unknown } | null | undefined): boolean {
	return entry?.kind === "custom" && entry.customType === MEMORY_OFF_ENTRY_TYPE;
}

/** The stretch of a ledger recorded before memory was first off. */
export function entriesBeforeMemoryOff<T extends { kind?: unknown }>(entries: readonly T[]): readonly T[] {
	const stop = entries.findIndex((entry) => isMemoryOffEntry(entry));
	return stop < 0 ? entries : entries.slice(0, stop);
}

/**
 * Decided from the active path, because readers filter to it: a marker on a branch /tree left no longer covers this
 * one. The ledger is the only state, so a restart and a fork that copied the marker answer the same way.
 */
export function markMemoryOffRecording(
	target: Pick<SessionContract, "current" | "tree" | "readEntries" | "appendEntry">,
): void {
	const meta = target.current();
	if (!meta) return;
	const leaf = target.tree(meta.id).leafId ?? null;
	if (filterEntriesToActivePath(target.readEntries(), leaf ?? undefined).some((entry) => isMemoryOffEntry(entry)))
		return;
	target.appendEntry({
		kind: "custom",
		customType: MEMORY_OFF_ENTRY_TYPE,
		// A fact about what memory may read, never a model message.
		display: false,
		parentTurnId: leaf,
		data: {},
	});
}
