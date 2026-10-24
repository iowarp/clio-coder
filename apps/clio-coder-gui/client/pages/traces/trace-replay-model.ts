import type { TraceEvent } from "../../../contracts/traces.js";
import { matchesText } from "../run-inspection-model.js";

export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;
export const REPLAY_WINDOW = 9;

export interface ReplayEntry {
	event: TraceEvent;
	startedMs: number | null;
	elapsedMs: number | null;
}

/** Recorded starts establish order, with rowid and event identity breaking ties. Unknown starts stay at the end. */
export function replayEntries(events: readonly TraceEvent[], runStart: string, phaseId: string | null): ReplayEntry[] {
	const start = Date.parse(runStart);
	return events
		.filter((event) => phaseId === null || event.phase_id === phaseId)
		.map((event) => {
			const timestamp = Date.parse(event.started_at);
			return {
				event,
				startedMs: Number.isFinite(timestamp) ? timestamp : null,
				elapsedMs: Number.isFinite(timestamp - start) && timestamp >= start ? timestamp - start : null,
			};
		})
		.sort(
			(a, b) =>
				(a.startedMs ?? Number.POSITIVE_INFINITY) - (b.startedMs ?? Number.POSITIVE_INFINITY) ||
				a.event.rowid - b.event.rowid ||
				(a.event.event_id < b.event.event_id ? -1 : a.event.event_id > b.event.event_id ? 1 : 0),
		);
}

export function replayIndex(entries: readonly ReplayEntry[], eventId: string | null): number {
	if (!entries.length) return -1;
	return Math.max(
		0,
		entries.findIndex((entry) => entry.event.event_id === eventId),
	);
}

export function latestReplayEvent(entries: readonly ReplayEntry[]): string | null {
	let latest: ReplayEntry | undefined;
	for (const entry of entries) {
		if (!latest || entry.event.rowid > latest.event.rowid) latest = entry;
	}
	return latest?.event.event_id ?? null;
}

export function replayWindow(
	entries: readonly ReplayEntry[],
	index: number,
): { start: number; entries: ReplayEntry[] } {
	const start = Math.max(0, Math.min(index - Math.floor(REPLAY_WINDOW / 2), entries.length - REPLAY_WINDOW));
	return { start, entries: entries.slice(start, start + REPLAY_WINDOW) };
}

/** Scheduling is separate from elapsed evidence: equal/unknown starts use a reading beat, and long idle gaps are capped. */
export function replayDelay(current: ReplayEntry, next: ReplayEntry, speed: number, reducedMotion: boolean): number {
	const gap = current.startedMs !== null && next.startedMs !== null ? next.startedMs - current.startedMs : 0;
	const rate = REPLAY_SPEEDS.some((candidate) => candidate === speed) ? speed : 1;
	return Math.max(reducedMotion ? 500 : 80, (gap > 0 ? Math.min(gap, 5000) : 500) / rate);
}

export function filterReplayEvents(events: readonly TraceEvent[], query: string, kind: string): TraceEvent[] {
	return events.filter(
		(event) =>
			(!kind || event.type === kind) && matchesText(query, [event.name, event.type, event.event_id, event.payload_json]),
	);
}
export function replayEventKinds(events: readonly TraceEvent[]): string[] {
	return [...new Set(events.map((event) => event.type))].sort();
}
