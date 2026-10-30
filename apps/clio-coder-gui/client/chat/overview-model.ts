// The numbers at the top of the Progress view: how long the task has run, how much it has used, and
// how far its plan has come. Pure and defensive, because every field is a reported value that may be
// absent on a replayed turn.

import type { ContextLedger } from "../../contracts/context-ledger.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";

/**
 * Turn count, wall time and whether a turn is running. Tokens and cost are not summed here: the read model folds
 * them and the usage read carries its displays, so a client sum would be a second, lesser accounting (#434).
 */
export interface TaskOverview {
	readonly turns: number;
	readonly elapsedMs: number;
	readonly running: boolean;
}

function at(value: string | null | undefined): number | null {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

export function taskOverview(turns: SessionSnapshot["turns"], nowMs: number): TaskOverview {
	let elapsed = 0;
	let running = false;
	for (const turn of turns) {
		const start = at(turn.startedAt);
		if (start === null) continue;
		const end = at(turn.finishedAt);
		if (end !== null) elapsed += Math.max(0, end - start);
		else if (turn.status === "running") {
			running = true;
			elapsed += nowMs > 0 ? Math.max(0, nowMs - start) : 0;
		}
	}
	return { turns: turns.length, elapsedMs: elapsed, running };
}

/** 842 → "842", 12 400 → "12.4K", 1 250 000 → "1.3M". */
export function compactCount(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 0 ms → "0s", 75 000 → "1m 15s", 3 900 000 → "1h 5m". Whole seconds, because a task is minutes long. */
export function compactDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface ContextMeter {
	/** 0 to 100, clamped for drawing. */
	readonly percent: number;
	/** The share in use as the server worded it, or null when the ledger reports no share. */
	readonly figure: string | null;
	readonly tone: "ok" | "warn" | "full";
	/** "43K of 128K tokens", with "estimated" until the provider reports usage. */
	readonly label: string;
	/** The whole sentence for assistive technology. */
	readonly text: string;
}

/**
 * The window meter on the Progress view, from Clio's own accounting. Null when the window size is not
 * reported, because a share of an unknown size would be invented.
 */
/** The meter's fill is geometry from the ledger's counts; its words are the server's displays (#434). */
export function contextMeter(
	ledger: Pick<ContextLedger, "usedTokens" | "contextWindow" | "percent" | "measured" | "display">,
): ContextMeter | null {
	const meter = ledger.display.meter;
	if (ledger.contextWindow <= 0 || meter === null) return null;
	const raw = ledger.percent ?? (ledger.usedTokens / ledger.contextWindow) * 100;
	const percent = Math.min(100, Math.max(0, raw));
	const tone = percent >= 85 ? "full" : percent >= 65 ? "warn" : "ok";
	const label = `${meter.used} of ${meter.window} tokens${ledger.measured ? "" : ", estimated"}`;
	return {
		percent,
		figure: ledger.display.percent,
		tone,
		label,
		text: `Context window ${ledger.display.percent ?? "share not reported"} used, ${label}`,
	};
}

export interface ContextSegment {
	readonly key: string;
	readonly label: string;
	/** Share of the whole window, 0 to 100. */
	readonly percent: number;
}

/**
 * What fills the window, as shares of the whole window for a stacked bar. The largest parts keep their
 * own segment and the rest fold into one, so the bar stays readable at the pane's width.
 */
export function contextSegments(
	ledger: Pick<ContextLedger, "contextWindow" | "groups">,
	keep = 4,
): readonly ContextSegment[] {
	if (ledger.contextWindow <= 0) return [];
	const parts = ledger.groups
		.filter((group) => group.tokens > 0)
		.map((group) => ({
			key: group.category,
			label: group.label,
			percent: (group.tokens / ledger.contextWindow) * 100,
		}))
		.sort((a, b) => b.percent - a.percent);
	if (parts.length <= keep) return parts;
	const rest = parts.slice(keep - 1).reduce((sum, part) => sum + part.percent, 0);
	return [...parts.slice(0, keep - 1), { key: "other", label: "Other", percent: rest }];
}
