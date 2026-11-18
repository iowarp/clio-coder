import type { SessionEntry } from "../domains/session/entries.js";

/**
 * The Codex effort history one request carries, derived from the ledger (#423). The live sync and the receipt
 * verifier share it, so `context working-set --verify` re-derives what the send path put on the wire.
 */

/** The rows since the last record that restarts Codex's effort history: a summary, an eviction or a model change. */
export function codexEffortGeneration(entries: ReadonlyArray<SessionEntry>): ReadonlyArray<SessionEntry> {
	let start = 0;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry?.kind === "compactionSummary" || entry?.kind === "contextEviction" || entry?.kind === "modelChange")
			start = index + 1;
	}
	return entries.slice(start);
}

/** Each effort change lands on the next user turn the request carries, once, and only when it changes the effort. */
export function codexEffortUpdates(
	generation: ReadonlyArray<SessionEntry>,
	initialEffort: string,
	available: ReadonlySet<string>,
	effortOf: (entry: Extract<SessionEntry, { kind: "thinkingLevelChange" }>) => string,
): Array<{ position: string; effort: string }> {
	const updates: Array<{ position: string; effort: string }> = [];
	let desired = initialEffort;
	let effective = initialEffort;
	for (const entry of generation) {
		if (entry.kind === "thinkingLevelChange" && !entry.configurationInitial) desired = effortOf(entry);
		if (entry.kind !== "message" || entry.role !== "user") continue;
		if (!available.has(entry.turnId)) continue;
		if (desired === effective) continue;
		updates.push({ position: entry.turnId, effort: desired });
		effective = desired;
	}
	return updates;
}
