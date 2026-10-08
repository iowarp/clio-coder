import type { TraceEvent } from "../../../contracts/traces.js";

export type TraceLiveState = "idle" | "connecting" | "live" | "reconnecting" | "finished" | "unavailable";

/** A run the trace store can still write to. `success` and `fail` are the only terminal states. */
export const runIsLive = (status: string | undefined) => status === "running" || status === "queued";

/** The rowid cursor to resume from: the highest rowid already held. */
export const lastRowid = (rows: readonly TraceEvent[] | undefined) => {
	let last = 0;
	for (const row of rows ?? []) if (row.rowid > last) last = row.rowid;
	return last;
};

/**
 * Keeps the newest rowid for each stable event_id: a span's finish advances its cursor without
 * becoming a second event. Older and equal replays leave the held version alone. Returns the
 * previous list unchanged when nothing changed, so the query cache does not re-render.
 */
export function mergeTraceEvents(previous: TraceEvent[] | undefined, incoming: readonly TraceEvent[]): TraceEvent[] {
	const held = previous ?? [];
	if (!incoming.length) return held;
	const seen = new Map(held.map((row) => [row.event_id, row]));
	const fresh = new Map<string, TraceEvent>();
	for (const row of incoming) {
		const current = fresh.get(row.event_id) ?? seen.get(row.event_id);
		if (!current || row.rowid > current.rowid) fresh.set(row.event_id, row);
	}
	if (!fresh.size) return held;
	const rows = [...fresh.values()];
	const kept = rows.some((row) => seen.has(row.event_id)) ? held.filter((row) => !fresh.has(row.event_id)) : held;
	// Normal appends and finishes advance beyond the held tail. Sort only the changed batch first,
	// so repeated revisions in one flush do not force a sort of the whole history.
	if (!rows.every((row, i) => i === 0 || row.rowid > (rows[i - 1]?.rowid ?? 0))) rows.sort((a, b) => a.rowid - b.rowid);
	const merged = [...kept, ...rows];
	return (rows[0]?.rowid ?? 0) > lastRowid(kept) ? merged : merged.sort((a, b) => a.rowid - b.rowid);
}

/**
 * How often the run header and phases refresh. The live tail carries events only, so while it
 * is connected the header keeps a slow safety refresh; without it a live run polls as before.
 */
export function detailRefetchMs(status: string | undefined, live: TraceLiveState) {
	if (!runIsLive(status)) return false;
	return live === "live" ? 15_000 : 5_000;
}

export const liveLabel: Record<TraceLiveState, string | null> = {
	idle: null,
	connecting: "Connecting…",
	live: "Live",
	reconnecting: "Reconnecting…",
	finished: null,
	unavailable: "Live tail unavailable",
};
