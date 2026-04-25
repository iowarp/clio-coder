/**
 * Pure aggregation helpers for the per-tool stats folded into a RunReceipt.
 *
 * Sourced from the worker's ToolTelemetry stream (`clio_tool_finish` IPC
 * events). Kept as a small standalone module so receipts have a single source
 * of truth for the aggregation invariants, and so loops, retries, errors,
 * blocked admissions, and parallel-batch tool calls all flow through one
 * code path that unit tests can pin.
 *
 * Invariants (asserted by tests/unit/dispatch-tool-stats.test.ts):
 *   - count == ok + errors + blocked for every tool entry.
 *   - totalDurationMs accumulates only finite non-negative durations.
 *   - snapshot is sorted by tool name ascending so receipt digests stay
 *     deterministic across runs.
 *   - countToolCalls returns the sum of count across every entry.
 */

import type { ToolCallStat } from "./types.js";

export interface ToolFinishPayload {
	tool?: string;
	durationMs?: number;
	outcome?: "ok" | "error" | "blocked";
}

function blankStat(tool: string): ToolCallStat {
	return { tool, count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0 };
}

export function recordToolFinish(stats: Map<string, ToolCallStat>, payload: ToolFinishPayload): void {
	if (typeof payload.tool !== "string") return;
	const existing = stats.get(payload.tool) ?? blankStat(payload.tool);
	existing.count += 1;
	if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs) && payload.durationMs >= 0) {
		existing.totalDurationMs += payload.durationMs;
	}
	if (payload.outcome === "ok") existing.ok += 1;
	else if (payload.outcome === "error") existing.errors += 1;
	else if (payload.outcome === "blocked") existing.blocked += 1;
	stats.set(payload.tool, existing);
}

export function countToolCalls(stats: Map<string, ToolCallStat>): number {
	let total = 0;
	for (const stat of stats.values()) total += stat.count;
	return total;
}

export function snapshotToolStats(stats: Map<string, ToolCallStat>): ToolCallStat[] {
	return [...stats.values()].sort((a, b) => a.tool.localeCompare(b.tool));
}
