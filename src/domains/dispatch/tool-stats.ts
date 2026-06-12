/**
 * Pure aggregation helpers for the per-tool stats folded into a RunReceipt.
 *
 * Sourced from the worker's ToolTelemetry stream (`clio_tool_finish` IPC
 * events). Kept as a small standalone module so receipts have a single source
 * of truth for the aggregation invariants, and so loops, retries, errors,
 * blocked admissions, and parallel-batch tool calls all flow through one
 * code path that unit tests can pin.
 *
 * Invariants (asserted by tests/contracts/dispatch.test.ts):
 *   - count == ok + errors + blocked for every tool entry.
 *   - totalDurationMs accumulates only finite non-negative durations.
 *   - snapshot is sorted by tool name ascending so receipt digests stay
 *     deterministic across runs.
 *   - countToolCalls returns the sum of count across every entry.
 */

import type { ActionClass } from "../safety/action-classifier.js";
import type { ToolActivitySummary, ToolCallStat } from "./types.js";

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

/** Action classes that can change state outside the worker's own context. */
const MUTATING_ACTION_CLASSES: ReadonlySet<ActionClass> = new Set([
	"write",
	"execute",
	"dispatch",
	"system_modify",
	"git_destructive",
]);

export function summarizeToolActivity(
	stats: Map<string, ToolCallStat>,
	classify: (tool: string) => ActionClass,
): ToolActivitySummary {
	const summary: ToolActivitySummary = { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false };
	for (const stat of stats.values()) {
		summary.calls += stat.count;
		summary.succeeded += stat.ok;
		summary.failed += stat.errors;
		summary.blocked += stat.blocked;
		if (stat.ok > 0 && MUTATING_ACTION_CLASSES.has(classify(stat.tool))) {
			summary.mutatingSucceeded = true;
		}
	}
	return summary;
}

/**
 * Factual note for a run that finished as succeeded without a single
 * successful tool call. The outcome stays succeeded (the harness cannot judge
 * whether the task was semantically accomplished); the note only makes the
 * emptiness visible wherever outcomeDetail renders.
 */
export function zeroSuccessfulToolNote(activity: ToolActivitySummary): string | null {
	if (activity.succeeded > 0) return null;
	if (activity.calls === 0) return "completed without executing any tools";
	return `completed without a successful tool call (${activity.calls} attempted: ${activity.failed} failed, ${activity.blocked} blocked)`;
}
