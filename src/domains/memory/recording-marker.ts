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
