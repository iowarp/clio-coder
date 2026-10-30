import type { RunTimelineEntry } from "../../../contracts/wire.js";
import { matchesText } from "../run-inspection-model.js";
import { entryKey, entryLabel } from "./trace-model.js";

export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;
export const REPLAY_WINDOW = 9;

export interface ReplayEntry {
	key: string;
	entry: RunTimelineEntry;
	startedMs: number | null;
	elapsedMs: number | null;
}

/** The run timeline's own order, which the read model sorts by time; elapsed positions are from the run's start. */
export function replayEntries(entries: readonly RunTimelineEntry[], runStart: number | null): ReplayEntry[] {
	return entries.map((entry) => {
		const timestamp = Date.parse(entry.at);
		const startedMs = Number.isFinite(timestamp) ? timestamp : null;
		return {
			key: entryKey(entry),
			entry,
			startedMs,
			elapsedMs: startedMs !== null && runStart !== null && startedMs >= runStart ? startedMs - runStart : null,
		};
	});
}

export function replayIndex(entries: readonly ReplayEntry[], key: string | null): number {
	if (!entries.length) return -1;
	return Math.max(
		0,
		entries.findIndex((entry) => entry.key === key),
	);
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

export function filterReplayEntries(
	entries: readonly RunTimelineEntry[],
	query: string,
	kind: string,
): RunTimelineEntry[] {
	return entries.filter((entry) => {
		const label = entryLabel(entry);
		return (!kind || label.kind === kind) && matchesText(query, [label.title, label.kind, entryKey(entry)]);
	});
}
export function replayEntryKinds(entries: readonly RunTimelineEntry[]): string[] {
	return [...new Set(entries.map((entry) => entryLabel(entry).kind))].sort();
}
