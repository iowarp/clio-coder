/**
 * Pure aggregation helpers for the per-tool stats folded into a RunResult.
 *
 * Sourced from the worker's ToolTelemetry stream (`clio_coder_tool_finish` IPC
 * events). Kept as a small standalone module so receipts have a single source
 * of truth for the aggregation invariants, and so loops, retries, errors,
 * blocked admissions, and parallel-batch tool calls all flow through one
 * code path that unit tests can pin.
 *
 * Invariants (pinned by tests/contracts/dispatch.test.ts):
 *   - Each recognized outcome (ok|error|blocked) increments its own bucket and
 *     count, so count == ok + errors + blocked + withheld whenever every recorded
 *     finish carried an outcome. An `ok` finish the spent observation pool
 *     stopped before it ran (`notExecuted: "observation_budget"`, C-17) counts
 *     withheld instead of ok. The worker ToolFinishEvent always does; a synthetic
 *     finish without an outcome increments count only.
 *   - totalDurationMs accumulates only finite non-negative durations.
 *   - snapshot is sorted by tool-name UTF-16 code unit ascending so receipt
 *     digests stay deterministic across runs and host locales.
 *   - countToolCalls returns the sum of count across every entry.
 */

import { ToolNames } from "../../core/tool-names.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { ToolActivitySummary, ToolCallStat } from "./types.js";

export interface ToolFinishPayload {
	tool?: string;
	durationMs?: number;
	outcome?: "ok" | "error" | "blocked";
	actionClass?: string;
	/** An `ok` call that did no work (C-17); see `ToolFinishEvent.notExecuted`. */
	notExecuted?: string | undefined;
}

export interface ToolStartPayload {
	tool?: string;
}

/** Count starts independently from finishes so a worker crash cannot disappear an in-flight call. */
export function recordToolStart(inFlight: Map<string, number>, payload: ToolStartPayload): void {
	if (typeof payload.tool !== "string") return;
	inFlight.set(payload.tool, (inFlight.get(payload.tool) ?? 0) + 1);
}

/** Match one finish to its start without inventing a start for legacy or opaque streams. */
export function recordToolCompletion(inFlight: Map<string, number>, payload: ToolFinishPayload): void {
	if (typeof payload.tool !== "string") return;
	const count = inFlight.get(payload.tool) ?? 0;
	if (count <= 1) inFlight.delete(payload.tool);
	else inFlight.set(payload.tool, count - 1);
}

export function snapshotUnfinishedTools(inFlight: ReadonlyMap<string, number>): Array<{ tool: string; count: number }> {
	return [...inFlight.entries()]
		.filter(([, count]) => count > 0)
		.map(([tool, count]) => ({ tool, count }))
		.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

function blankStat(tool: string): ToolCallStat {
	return { tool, count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0 };
}

/**
 * The `details.notExecuted` type a tool result carries when its call returned a notice without running (C-17), for
 * the stats folds that see the result rather than the finish event: a gateway chain's steps and a headless run.
 */
export function resultNotExecuted(result: unknown): string | undefined {
	if (result === null || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (details === null || typeof details !== "object") return undefined;
	const value = (details as { notExecuted?: unknown }).notExecuted;
	return typeof value === "string" ? value : undefined;
}

export function recordToolFinish(stats: Map<string, ToolCallStat>, payload: ToolFinishPayload): void {
	if (typeof payload.tool !== "string") return;
	const existing = stats.get(payload.tool) ?? blankStat(payload.tool);
	existing.count += 1;
	if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs) && payload.durationMs >= 0) {
		existing.totalDurationMs += payload.durationMs;
	}
	if (payload.outcome === "ok" && payload.notExecuted === "observation_budget")
		existing.withheld = (existing.withheld ?? 0) + 1;
	else if (payload.outcome === "ok") existing.ok += 1;
	else if (payload.outcome === "error") existing.errors += 1;
	else if (payload.outcome === "blocked") existing.blocked += 1;
	// The store tool's class depends on its op, so the tool name alone reads a
	// granted put as a read; keep the per-call class the worker saw.
	if (payload.outcome === "ok" && (payload.actionClass === "write" || payload.actionClass === "destructive"))
		existing.okWrites = (existing.okWrites ?? 0) + 1;
	stats.set(payload.tool, existing);
}

export function countToolCalls(stats: Map<string, ToolCallStat>): number {
	let total = 0;
	for (const stat of stats.values()) total += stat.count;
	return total;
}

export function snapshotToolStats(stats: Map<string, ToolCallStat>): ToolCallStat[] {
	return [...stats.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * Whether a receipt contains an executed tool call that may have changed
 * state. Failed calls are included because an error result does not prove the
 * tool rolled back partial filesystem or external side effects. Blocked calls
 * are excluded because admission stopped them before execution. Unknown tools
 * are treated conservatively as potentially mutating.
 */
export function hasPotentiallyMutatingAttempt(
	stats: ReadonlyArray<ToolCallStat>,
	classify: (tool: string) => ActionClass,
): boolean {
	return stats.some((stat) => stat.count > stat.blocked && classify(stat.tool) !== "read");
}

/** Action classes that can change state outside the worker's own context. */
const MUTATING_ACTION_CLASSES: ReadonlySet<ActionClass> = new Set([
	"write",
	"execute",
	"dispatch",
	"system_modify",
	"git_destructive",
	"destructive",
]);

export function summarizeToolActivity(
	stats: Map<string, ToolCallStat>,
	classify: (tool: string) => ActionClass,
): ToolActivitySummary {
	const summary: ToolActivitySummary = { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false };
	let withheld = 0;
	for (const stat of stats.values()) {
		if (stat.tool === "clio_submit_result") continue;
		summary.calls += stat.count;
		summary.succeeded += stat.ok;
		summary.failed += stat.errors;
		summary.blocked += stat.blocked;
		withheld += stat.withheld ?? 0;
		if (stat.ok > 0 && MUTATING_ACTION_CLASSES.has(classify(stat.tool))) {
			summary.mutatingSucceeded = true;
		}
		if (stat.tool === "store" && (stat.okWrites ?? 0) > 0) summary.storeWritten = true;
	}
	if (withheld > 0) summary.withheld = withheld;
	return summary;
}

/** Calls that ran: a notice the spent observation pool returned in a call's place ran nothing (C-17). */
export function executedCalls(activity: Pick<ToolActivitySummary, "calls" | "withheld">): number {
	return activity.calls - (activity.withheld ?? 0);
}

/**
 * Factual note for a run that finished as succeeded without a single
 * successful tool call. The outcome stays succeeded (the harness cannot judge
 * whether the task was semantically accomplished); the note only makes the
 * emptiness visible wherever outcomeDetail renders.
 */
export function zeroSuccessfulToolNote(activity: ToolActivitySummary): string | null {
	if (activity.succeeded > 0) return null;
	const withheld = activity.withheld ?? 0;
	if (executedCalls(activity) === 0)
		return withheld > 0
			? `completed without executing any tools (${withheld} withheld by the observation budget)`
			: "completed without executing any tools";
	return `completed without a successful tool call (${activity.calls} attempted: ${activity.failed} failed, ${activity.blocked} blocked${withheld > 0 ? `, ${withheld} withheld` : ""})`;
}

/**
 * Attempted write-class calls when every one of them was blocked by policy and
 * no state-changing call of any class succeeded. A workspace-edit worker in
 * that state produced no mutation, yet its finish contract reads "no
 * mutation" as success, so the caller seals it failed instead. Null whenever
 * no write was attempted, one write got past admission, or any mutating call
 * landed. A shell call may have changed anything, so it counts as landing until
 * `mutatedPathCount` says the run's tree did not move: a lint that passed beside
 * a refused write does not make the write's refusal `✓ execution ok`.
 */
export function blockedWriteAttempts(
	stats: ReadonlyMap<string, ToolCallStat>,
	classify: (tool: string) => ActionClass,
	mutatedPathCount: number | null = null,
): number | null {
	let attempted = 0;
	let blocked = 0;
	for (const stat of stats.values()) {
		const actionClass = classify(stat.tool);
		if (stat.ok > 0 && MUTATING_ACTION_CLASSES.has(actionClass) && (actionClass === "write" || mutatedPathCount !== 0)) {
			return null;
		}
		if (actionClass !== "write") continue;
		attempted += stat.count;
		blocked += stat.blocked;
	}
	return attempted > 0 && blocked === attempted ? attempted : null;
}

/**
 * Calls of the execute or write class that policy refused before they ran, when every such call was refused.
 * Zero once one of them got past admission, ran or failed: the refusals then are not why the tree did not move.
 */
export function blockedStateChangingCalls(
	stats: ReadonlyMap<string, ToolCallStat>,
	classify: (tool: string) => ActionClass,
): number {
	let blocked = 0;
	for (const stat of stats.values()) {
		const actionClass = classify(stat.tool);
		if (actionClass !== "write" && actionClass !== "execute") continue;
		if (stat.count > stat.blocked) return 0;
		blocked += stat.blocked;
	}
	return blocked;
}

/**
 * Observations, the one counter every evidence obligation reads (DESIGN 4.8): succeeded read-class calls and
 * succeeded checks. The handback tool is not one.
 */
export function observationCalls(
	stats: ReadonlyMap<string, ToolCallStat>,
	classify: (tool: string) => ActionClass,
): number {
	let observed = 0;
	for (const stat of stats.values()) {
		if (stat.tool === "clio_submit_result") continue;
		if (stat.tool === ToolNames.Verify || classify(stat.tool) === "read") observed += stat.ok;
	}
	return observed;
}
