// What a run's durable accounting says, before any of it is drawn. Status, the four totals, the
// phases in their recorded order, and how many events and processes there were of each kind. Pure,
// so the ordering and the wording are testable without a browser.

import type { TracePhase, TraceRun } from "../../../contracts/traces.js";
import { formatCost, formatDuration, formatTokens } from "../../api/clock.js";
import { omittedSentence } from "../../design/facts-model.js";
import { type StatusTone, toneForOutcome } from "../../design/status.js";

export interface RunTotal {
	label: string;
	value: string;
}

export interface HistogramRow {
	label: string;
	count: number;
	/** Width relative to the commonest kind, 0 to 1. */
	share: number;
}

export interface Histogram {
	rows: HistogramRow[];
	/** One sentence when rarer kinds were left out, empty when nothing was. */
	omitted: string;
}

export const HISTOGRAM_KINDS = 8;

/** The trace database records `success`/`fail`; the shared ramp knows the rest of the vocabulary. */
export function runTone(status: string): StatusTone {
	if (status === "success") return "success";
	if (status === "fail") return "fail";
	if (status === "queued") return "warn";
	return toneForOutcome(status);
}

/** Tokens, cost, wall time and the runtime that produced them. A live run measures wall time to now. */
export function runTotals(run: TraceRun, now: number): RunTotal[] {
	const ended = run.ended_at ? Date.parse(run.ended_at) : now;
	return [
		{ label: "Tokens", value: formatTokens(run.total_tokens) },
		{ label: "Cost", value: formatCost(run.total_cost_usd) },
		{ label: "Wall time", value: formatDuration(ended - Date.parse(run.started_at)) },
		{ label: "Runtime", value: run.runtime || "not recorded" },
	];
}

/** Recorded order, which is `seq`. A wire that returns them shuffled still renders the run's shape. */
export function orderedPhases(phases: readonly TracePhase[]): TracePhase[] {
	return [...phases].sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
}

/**
 * How many of each kind there were, commonest first. Ties order by name so two runs with the same
 * counts render identically.
 */
export function histogram(kinds: readonly string[], limit = HISTOGRAM_KINDS): Histogram {
	const counts = new Map<string, number>();
	for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const shown = sorted.slice(0, limit);
	const widest = shown[0]?.[1] ?? 0;
	return {
		rows: shown.map(([label, count]) => ({ label, count, share: widest > 0 ? count / widest : 0 })),
		omitted: omittedSentence(sorted.length - shown.length, "kind"),
	};
}
