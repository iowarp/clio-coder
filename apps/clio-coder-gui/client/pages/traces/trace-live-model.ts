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
 * Appends streamed rows to the held list in rowid order. A reconnect can replay rows the page
 * already holds, so rows at or below a held rowid replace nothing and are dropped. Returns the
 * previous list unchanged when nothing new arrived, so the query cache does not re-render.
 */
export function mergeTraceEvents(previous: TraceEvent[] | undefined, incoming: readonly TraceEvent[]): TraceEvent[] {
	const held = previous ?? [];
	const seen = new Set(held.map((row) => row.rowid));
	const fresh = incoming.filter((row) => !seen.has(row.rowid) && seen.add(row.rowid));
	if (!fresh.length) return held;
	const tail = lastRowid(held);
	// Rows arrive in rowid order; sort only when a replayed batch interleaves with held rows.
	const ordered = fresh.every((row, i) => row.rowid > (i ? (fresh[i - 1]?.rowid ?? tail) : tail));
	const merged = [...held, ...fresh];
	return ordered ? merged : merged.sort((a, b) => a.rowid - b.rowid);
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
