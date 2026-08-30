/** Shared presentation formatters. No protocol knowledge lives here. */

export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatTimestamp(value: string): string {
	const timestamp = new Date(value);
	return Number.isNaN(timestamp.getTime())
		? "unavailable"
		: timestamp.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

export function formatClock(value: string): string {
	const timestamp = new Date(value);
	return Number.isNaN(timestamp.getTime()) ? "unavailable" : timestamp.toLocaleTimeString([], { timeStyle: "short" });
}

/** Whole seconds between an ISO start and `nowMs`, never negative, 0 when the start is unreadable. */
export function elapsedSeconds(startedAt: string | null, nowMs: number): number {
	if (startedAt === null) return 0;
	const startedMs = Date.parse(startedAt);
	return Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs - startedMs) / 1_000)) : 0;
}
